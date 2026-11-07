import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, ownerIdSchema, profileIdSchema,
  projectSchema, taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { createWorkerExecutor, type ExecutorResult } from '../../packages/personal-agent/src/runtime/executor.js'
import { makeWorkerInput } from '../../packages/personal-agent/src/runtime/input-journal.js'
import type { NativeWorkerInput, NativeWorkerRuntime } from '../../packages/personal-agent/src/runtime/native-worker.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'
import { createNativeProfile, nativeAgentRows, nativeProfileTimeoutMs, nativeSessionPersistenceRows } from '../contracts/native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/native-input-crash.mjs', import.meta.url))
const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const ownerId = ownerIdSchema.parse('owner')
const profileId = profileIdSchema.parse('profile')
const actor = {
  role: 'owner', ownerId, profileId, clientId: clientIdSchema.parse('client'), deviceId: deviceIdSchema.parse('device'),
  policyVersion: 'fixture-policy',
} as const
const project = projectSchema.parse({
  id: 'project', ownerId, profileId, kind: 'project', title: 'PA-009 cancellation',
  purpose: 'Check exact cancellation and concurrent handles.',
  resourceRefs: [], status: 'active', successCriteria: ['Exact work stops.'], planRevision: 1, milestones: [],
})

function committed(result: ExecutorResult) {
  if (!result.ok) throw new Error(`Expected committed fixture state, received ${result.code}`)
  return result.state
}

describe('recovery and exact native cancellation', () => {
  it.each([
    { phase: 'pending', observation: 'pending' },
    { phase: 'claimed', observation: 'unknown' },
  ])('cold-classifies $phase native input after exit before SQLite acknowledgement and fences the attempt', ({ phase, observation }) => {
    const profile = createNativeProfile({ probe, patchRows: [...nativeAgentRows, ...nativeSessionPersistenceRows] })
    try {
      const interrupted = profile.run(`crash-${phase}`)
      expect(interrupted.signal, interrupted.stderr).toBeNull()
      expect(interrupted.status, interrupted.stderr).toBe(91)
      expect(interrupted.stdout).toBe('PA009_NATIVE_FLUSH_WITHOUT_ACK')
      const recovered = profile.run(`recover-${phase}`)
      expect(recovered.signal, recovered.stderr).toBeNull()
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(recovered.stdout).toBe(`PA009_NATIVE_FENCED ${observation}`)
    } finally {
      profile.dispose()
    }
  }, nativeProfileTimeoutMs * 2 + 1_000)

  it('commits retirement before signaling, rejects stale acknowledgement and work, and leaves other handles active', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshpa-pa009-cancel-'))
    const store = openWorkStore(join(directory, 'state'))
    onTestFinished(() => {
      try {
        store.close()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
    store.insertProject(project)
    function seed(label: string) {
      const taskId = taskIdSchema.parse(`task-${label}`)
      const ref = { ownerId, profileId, taskId }
      const context = { actor, at, projectId: project.id }
      const state = committed(store.applyCommand({
        type: 'work.create', commandId: `create-${label}`,
        payload: {
          projectId: project.id, requestedOutcome: `Run ${label} fixture.`, constraints: [],
          acceptance: { criteria: ['Exact work stops.'], requiresArtifact: false, requiresReceipt: false },
        },
      }, {
        ...context, newTaskId: taskId,
        newAttempt: {
          id: attemptIdSchema.parse(`attempt-${label}`),
          mandate: mandateRefSchema.parse({ id: `mandate-${label}`, ownerId, profileId, policyVersion: actor.policyVersion }),
        },
      }))
      return { ref, context, state }
    }

    const target = seed('target')
    const other = seed('other')
    const entered = Promise.withResolvers<NativeWorkerInput>()
    const delivery = Promise.withResolvers<void>()
    const stopStarted = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<boolean>()
    const waiting = Promise.withResolvers<void>()
    let opened = 0
    let targetOptions: Parameters<NativeWorkerRuntime['open']>[0] | undefined
    let otherOptions: Parameters<NativeWorkerRuntime['open']>[0] | undefined
    let stateAtAbort: ReturnType<typeof store.getWork>
    let otherStops = 0

    const runtime: NativeWorkerRuntime = {
      async open(options) {
        const isTarget = opened++ === 0
        if (isTarget) {
          targetOptions = options
          options.signal.addEventListener('abort', () => { stateAtAbort = store.getWork(target.ref) }, { once: true })
        } else {
          otherOptions = options
        }
        return {
          async followup(input) {
            if (isTarget) {
              entered.resolve(input)
              return delivery.promise
            }
            expect(input.acknowledge()).toBe(true)
          },
          async steer() { throw new Error('The old attempt must not reach native steering') },
          async flush() {},
          whenIdle: () => waiting.promise,
          readReport: () => undefined,
          async stop() {
            if (isTarget) {
              stopStarted.resolve()
              return stopped.promise
            }
            otherStops++
            return true
          },
        }
      },
    }
    const cwd = realpathSync(directory)
    const presetId = 'fixture'
    const executor = createWorkerExecutor({
      store, runtime, now: () => at, concurrency: 2,
      presets: [{ id: presetId, rootDirectory: cwd, provider: 'fixture-model', model: 'scripted', dataScope: [] }],
    })
    const launching = executor.launch(target.ref, {
      expectedVersion: target.state.task.version, presetId, cwd, dataScope: [], input: { cursor: 'target-input', text: 'Target fixture.' },
    })
    try {
      const nativeInput = await Promise.race([
        entered.promise,
        launching.then(result => { throw new Error(`Target did not enter native delivery: ${JSON.stringify(result)}`) }),
      ])
      committed(await executor.launch(other.ref, {
        expectedVersion: other.state.task.version, presetId, cwd, dataScope: [], input: { cursor: 'other-input', text: 'Other fixture.' },
      }))
      const running = store.getWork(target.ref)
      if (!running?.attempt.sessionId) throw new Error('Missing native worker binding')
      expect(targetOptions?.isCurrent()).toBe(true)
      const cancelled = committed(executor.cancel({
        type: 'work.cancel', commandId: 'cancel-target', taskId: target.ref.taskId,
        expectedVersion: running.task.version, payload: {},
      }, target.context))
      await stopStarted.promise
      expect(stateAtAbort?.task).toMatchObject({
        status: 'cancelling', generation: running.task.generation + 1, version: cancelled.task.version,
      })
      expect(targetOptions?.signal.aborted).toBe(true)
      expect(targetOptions?.isCurrent()).toBe(false)
      expect(nativeInput.acknowledge()).toBe(false)
      const staleFence = {
        expectedVersion: cancelled.task.version, attemptId: running.attempt.id, generation: running.attempt.generation, at,
      }
      expect(store.applyEvent(target.ref, { type: 'ready', ...staleFence, artifactIds: [] }))
        .toEqual({ ok: false, code: 'stale_attempt' })
      const stale = makeWorkerInput(running, running.attempt.sessionId, { cursor: 'old-redirect', text: 'Stale intent.' }, 'steer')
      expect(store.applyWorkerEvent(target.ref, { type: 'record_input', ...staleFence, cursor: stale.cursor }, stale))
        .toEqual({ ok: false, code: 'stale_attempt' })
      expect(store.workerInputs(target.ref, running.attempt.id)).toMatchObject([{ cursor: 'target-input', status: 'intent' }])
      expect(store.getWork(target.ref)?.task.status).toBe('cancelling')
      expect(otherOptions?.signal.aborted).toBe(false)
      expect(otherOptions?.isCurrent()).toBe(true)
      expect(otherStops).toBe(0)
      delivery.reject(new Error('The retired input cannot be acknowledged'))
      stopped.resolve(true)
      expect(await launching).toMatchObject({ ok: false })
      expect(await executor.waitForRelease(target.ref)).toBe(true)
      expect(store.getWork(target.ref)?.task.status).toBe('cancelled')
      expect(store.getWork(other.ref)?.task.status).toBe('running')
      expect(otherStops).toBe(0)
    } finally {
      delivery.resolve()
      stopped.resolve(true)
      waiting.resolve()
      await executor.close()
    }
  })
})
