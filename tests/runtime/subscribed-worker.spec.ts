import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, profileSchema, projectSchema,
  taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import type { WorkState } from '../../packages/personal-agent/src/domain/transitions.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import { createWorkerExecutor, type ExecutorResult } from '../../packages/personal-agent/src/runtime/executor.js'
import { authenticateEvent } from '../../packages/personal-agent/src/runtime/intake.js'
import type { NativeWorkerInput, NativeWorkerRuntime } from '../../packages/personal-agent/src/runtime/native-worker.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'
import { createNativeProfile, nativeAgentRows, nativeProfileTimeoutMs, nativeSessionPersistenceRows } from '../contracts/native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/subscribed-worker-probe.mjs', import.meta.url))
const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const profile = profileSchema.parse({
  id: 'profile', ownerId: 'owner', policyVersion: 'policy',
  verifiedAccounts: [{ sourceInstanceId: 'source', accountId: 'account', verifiedAt: at }],
  verifiedDevices: [{ deviceId: 'device', verifiedAt: at }],
})
const scope = { ownerId: profile.ownerId, profileId: profile.id }
const actor = {
  role: 'owner' as const, ...scope, policyVersion: profile.policyVersion,
  clientId: clientIdSchema.parse('client'), deviceId: deviceIdSchema.parse('device'),
}
const project = projectSchema.parse({
  id: 'project', ...scope, kind: 'project', title: 'Subscribed work', purpose: 'Check routing delivery.',
  resourceRefs: [], status: 'active', successCriteria: ['Route authenticated observations.'], planRevision: 1, milestones: [],
})

function committed(result: ExecutorResult): WorkState {
  if (!result.ok) throw new Error(`Expected committed work, received ${result.code}`)
  return result.state
}

function controlledRuntime() {
  const handles: Array<{
    options: Parameters<NativeWorkerRuntime['open']>[0]
    inputs: Array<{ method: 'followup' | 'steer'; input: NativeWorkerInput }>
    holdStop?: Promise<boolean>
    stopped: boolean
    report(body: Record<string, unknown>): void
  }> = []
  const runtime: NativeWorkerRuntime = {
    async open(options) {
      let idle = Promise.withResolvers<void>()
      let report: string | undefined
      const inputs: Array<{ method: 'followup' | 'steer'; input: NativeWorkerInput }> = []
      const handle = {
        options, inputs, holdStop: undefined as Promise<boolean> | undefined, stopped: false,
        report(body: Record<string, unknown>) {
          report = JSON.stringify({ cursor: inputs.at(-1)?.input.cursor, summary: 'Scoped Worker report.', ...body })
          idle.resolve()
        },
      }
      const send = async (method: 'followup' | 'steer', input: NativeWorkerInput) => {
        idle.resolve()
        idle = Promise.withResolvers<void>()
        report = undefined
        inputs.push({ method, input })
        expect(input.acknowledge()).toBe(true)
      }
      handles.push(handle)
      return {
        followup: input => send('followup', input),
        steer: input => send('steer', input),
        async flush() {},
        whenIdle: () => idle.promise,
        readReport: () => report,
        async stop() {
          const released = handle.holdStop === undefined || await handle.holdStop
          if (released) {
            handle.stopped = true
            idle.resolve()
          }
          return released
        },
      }
    },
  }
  return { runtime, handles }
}

function fixture(onHandback?: Parameters<typeof createWorkerExecutor>[0]['onHandback']) {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-pa010-worker-'))
  const cwd = realpathSync(directory)
  const store = openWorkStore(join(directory, 'state'))
  store.insertProject(project)
  const ref = { ...scope, taskId: taskIdSchema.parse('task') }
  const queued = committed(store.applyCommand({
    type: 'work.create', commandId: 'create-task',
    payload: { projectId: project.id, requestedOutcome: 'Inspect the scoped work.', constraints: [],
      acceptance: { criteria: ['Use current observations.'], requiresArtifact: false, requiresReceipt: false } },
  }, {
    actor, at, projectId: project.id, newTaskId: ref.taskId,
    newAttempt: { id: attemptIdSchema.parse('attempt'), mandate: mandateRefSchema.parse({ id: 'mandate', ...scope, policyVersion: 'policy' }) },
  }))
  const subscribed = store.putSubscription({
    ...scope, sourceInstanceId: 'source', accountId: 'account', threadId: 'thread', taskId: ref.taskId,
    projectId: project.id, mode: 'work', enabled: true,
    authority: { policyVersion: profile.policyVersion, verifiedAt: at }, updatedAt: at,
  })
  if (!subscribed.ok) throw new Error(subscribed.code)
  const { runtime, handles } = controlledRuntime()
  const executor = createWorkerExecutor({
    store, runtime, now: () => at, onHandback,
    presets: [{ id: 'preset', rootDirectory: cwd, provider: 'model-provider', model: 'scripted', dataScope: ['project', 'other'] }],
  })
  onTestFinished(async () => {
    try {
      await executor.close()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  return {
    ref, store, executor, handles,
    async start() {
      return committed(await executor.launch(ref, {
        expectedVersion: queued.task.version, presetId: 'preset', cwd, dataScope: ['project'],
        input: { cursor: 'original-input', text: 'Original trusted owner direction.' },
      }))
    },
    recordEvent(state: WorkState, label: string, waitReference?: string) {
      const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
      const token = identity.bindSource({ ...scope, sourceInstanceId: 'source', accountId: 'account' })
      const result = authenticateEvent(identity, token, {
        kind: 'event', projectId: project.id, text: 'A scoped source observation.', dataScope: ['project'],
        externalEventId: label, externalRevision: '1', threadId: 'thread', occurredAt: at,
        actorKind: 'service', externalActorId: 'verified-adapter',
        target: { taskId: ref.taskId, expectedVersion: state.task.version, generation: state.task.generation },
        ...(waitReference === undefined ? {} : { waitReference }),
      }, at)
      if (!result.ok) throw new Error(result.code)
      const saved = store.recordRoutingEvent(result.event, result.digest, { projectId: project.id, authority: result.authority })
      if (!saved.ok) throw new Error(saved.code)
      return {
        expectedVersion: state.task.version,
        generation: state.task.generation,
        dataScope: ['project'],
        route: {
          eventId: result.event.id, expectedReceiptVersion: saved.receipt.version,
          projectId: project.id, subscriptionVersion: subscribed.subscription.version,
          mode: 'work' as const, authority: result.authority,
        },
        input: { cursor: result.event.id, text: 'A scoped source observation.' },
      }
    },
  }
}

describe('subscribed Worker runtime', () => {
  it('journals a subscribed followup and returns its exact handback once without mutating the task', async () => {
    const onHandback = vi.fn(() => { throw new Error('Router unavailable after durable handback') })
    const f = fixture(onHandback)
    const running = await f.start()
    const requested = f.recordEvent(running, 'handback')
    expect(f.executor.deliverSubscribed(f.ref, { ...requested, dataScope: ['other'] }, () => true))
      .toEqual({ ok: false, code: 'permission_denied' })
    expect(f.executor.deliverSubscribed(f.ref, { ...requested, input: { ...requested.input, text: 'Different material.' } }, () => true))
      .toEqual({ ok: false, code: 'permission_denied' })
    expect(f.executor.deliverSubscribed(f.ref, { ...requested, route: { ...requested.route, mode: 'context' } }, () => true))
      .toEqual({ ok: false, code: 'permission_denied' })
    expect(f.executor.deliverSubscribed(f.ref, requested, () => false)).toEqual({ ok: false, code: 'permission_denied' })
    const delivered = committed(f.executor.deliverSubscribed(f.ref, requested, () => true))
    const native = f.handles[0]!
    const sent = native.inputs.at(-1)
    expect(sent?.method).toBe('followup')
    expect(sent?.input.text).toContain('Untrusted subscribed source observation')
    expect(sent?.input.authorize?.()).toBe(true)
    expect(f.store.workerInputs(f.ref, running.attempt.id).at(-1)).toMatchObject({
      cursor: requested.input.cursor, kind: 'followup', status: 'flushed',
    })
    expect(f.store.getWork(f.ref)?.attempt.mandate).toEqual(running.attempt.mandate)
    expect(f.store.getWork(f.ref)?.attempt.scope).toEqual(running.attempt.scope)

    native.report({ kind: 'handback' })
    const routeRef = { ...scope, eventId: requested.route.eventId }
    await vi.waitFor(() => expect(f.store.getRoutingEvent(routeRef)?.receipt.disposition.kind).toBe('handback'))
    expect(onHandback).toHaveBeenCalledExactlyOnceWith(f.ref, requested.route.eventId)
    expect(f.store.getWork(f.ref)?.task).toMatchObject({ status: 'running', version: delivered.task.version })
    expect(native.stopped).toBe(false)
    expect(f.store.applyWorkerHandback(f.ref, {
      eventId: requested.route.eventId, cursor: requested.input.cursor,
      attemptId: delivered.attempt.id, generation: delivered.attempt.generation, expectedVersion: delivered.task.version,
    })).toBe(false)
    expect(onHandback).toHaveBeenCalledOnce()
  })

  it('resumes a released waiting-event Worker only for its exact fresh event and existing scope', async () => {
    const f = fixture()
    const running = await f.start()
    const held = Promise.withResolvers<boolean>()
    const native = f.handles[0]!
    native.holdStop = held.promise
    const referenceId = 'expected-event'
    try {
      native.report({ kind: 'waiting', wait: { reason: 'event', referenceId, resumeCondition: 'Match the verified event.' } })
      await vi.waitFor(() => expect(f.store.getWork(f.ref)?.task.status).toBe('waiting_event'))
      const waiting = f.store.getWork(f.ref)!
      const premature = {
        ...f.recordEvent(waiting, 'premature', referenceId), referenceId,
        grantsCurrent: true, budgetAvailable: true, conditionSatisfied: true,
      }
      expect((await f.executor.wakeSubscribed(f.ref, premature, () => true)).ok).toBe(false)
      expect(f.handles).toHaveLength(1)
    } finally {
      held.resolve(true)
    }
    expect(await f.executor.waitForRelease(f.ref)).toBe(true)
    const parked = f.store.getWork(f.ref)!
    expect(parked.attempt.worker?.releasedAt).toBe(at)
    const requested = {
      ...f.recordEvent(parked, 'wake', referenceId), referenceId,
      grantsCurrent: true, budgetAvailable: true, conditionSatisfied: true,
    }
    expect(await f.executor.wakeSubscribed(f.ref, { ...requested, referenceId: 'wrong' }, () => true))
      .toEqual({ ok: false, code: 'condition_unmet' })
    expect(await f.executor.wakeSubscribed(f.ref, { ...requested, budgetAvailable: false }, () => true))
      .toEqual({ ok: false, code: 'budget_exceeded' })
    expect(await f.executor.wakeSubscribed(f.ref, { ...requested, generation: requested.generation + 1 }, () => true))
      .toEqual({ ok: false, code: 'stale_attempt' })
    expect(await f.executor.wakeSubscribed(f.ref, requested, () => false))
      .toEqual({ ok: false, code: 'permission_denied' })
    const awake = committed(await f.executor.wakeSubscribed(f.ref, requested, () => true))
    expect(awake.task.status).toBe('running')
    expect(awake.attempt.id).toBe(running.attempt.id)
    expect(awake.attempt.sessionId).toBe(running.attempt.sessionId)
    expect(awake.attempt.scope).toEqual(running.attempt.scope)
    expect(f.handles[1]?.options.resume).toBe(true)
    expect(f.handles[1]?.inputs[0]?.method).toBe('followup')
    expect(f.store.workerInputs(f.ref, awake.attempt.id).map(input => input.cursor))
      .toEqual(['original-input', requested.input.cursor])
    expect((await f.executor.wakeSubscribed(f.ref, requested, () => true)).ok).toBe(false)
    expect(f.handles).toHaveLength(2)
  })

  it('rechecks revoked authority on the actual native pre-step even after flush acknowledgement', () => {
    const profile = createNativeProfile({ probe, patchRows: [...nativeAgentRows, ...nativeSessionPersistenceRows] })
    try {
      const result = profile.run()
      expect(result.signal, result.stderr).toBeNull()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('PA010_NATIVE_REVOKED_INPUT_DENIED')
    } finally {
      profile.dispose()
    }
  }, nativeProfileTimeoutMs + 1_000)
})
