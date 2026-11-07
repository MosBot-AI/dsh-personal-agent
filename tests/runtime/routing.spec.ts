import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  attemptIdSchema, mandateRefSchema, profileSchema, projectSchema, taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import { createWorkerExecutor, type ExecutorResult } from '../../packages/personal-agent/src/runtime/executor.js'
import type { NativeWorkerInput, NativeWorkerRuntime } from '../../packages/personal-agent/src/runtime/native-worker.js'
import { createRouter, type EventRouter, type RoutingAssessor } from '../../packages/personal-agent/src/runtime/router.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'

const earlier = utcInstantSchema.parse('2026-11-07T07:59:00.000Z')
const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const later = utcInstantSchema.parse('2026-11-07T08:00:01.000Z')
const account = { sourceInstanceId: 'connector', accountId: 'account-a' }
const otherAccount = { sourceInstanceId: 'connector', accountId: 'account-b' }
const initialProfile = profileSchema.parse({
  id: 'profile', ownerId: 'owner', policyVersion: 'policy-1',
  verifiedAccounts: [{ ...account, verifiedAt: earlier }, { ...otherAccount, verifiedAt: earlier }],
  verifiedDevices: [{ deviceId: 'device', verifiedAt: earlier }],
})
const scope = { ownerId: initialProfile.ownerId, profileId: initialProfile.id }

function success<Result extends { ok: boolean }>(result: Result): Extract<Result, { ok: true }> {
  if (!result.ok) throw new Error(`Unexpected fixture failure: ${JSON.stringify(result)}`)
  return result as Extract<Result, { ok: true }>
}

function setup(assess?: RoutingAssessor, authorizeDelivery = true) {
  const directory = realpathSync(mkdtempSync(`${tmpdir()}/dshpa-routing-`))
  const store = openWorkStore(directory)
  let profile = initialProfile
  let clock = at
  const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
  const ownerToken = identity.bindOwner({ ...scope, deviceId: 'device', clientId: 'client', sessionId: 'session' })!
  const owner = identity.resolveOwner(ownerToken)!
  const source = identity.bindSource({ ...scope, ...account })!
  const otherSource = identity.bindSource({ ...scope, ...otherAccount })!
  const nativeInputs: NativeWorkerInput[][] = []
  const workerTurns: { idle: PromiseWithResolvers<void>; report?: string }[] = []
  let router: EventRouter
  const runtime: NativeWorkerRuntime = {
    async open() {
      const inputs: NativeWorkerInput[] = []
      const turn = { idle: Promise.withResolvers<void>() } as typeof workerTurns[number]
      nativeInputs.push(inputs)
      workerTurns.push(turn)
      async function accept(input: NativeWorkerInput) {
        inputs.push(input)
        expect(input.acknowledge()).toBe(true)
      }
      return {
        followup: accept, steer: accept, whenIdle: () => turn.idle.promise,
        readReport: () => turn.report, async flush() {}, async stop() { return true },
      }
    },
  }
  const presetId = 'fixture'
  const dataScope = ['fixture-public']
  const executor = createWorkerExecutor({ store, runtime, now: () => clock, concurrency: 4,
    presets: [{ id: presetId, rootDirectory: directory, provider: 'fixture', model: 'scripted', dataScope }],
    onHandback: (ref, eventId) => router.handback(ref, eventId),
  })
  router = createRouter({ store, identity, executor, now: () => clock, assess, assessmentDataScope: dataScope,
    authorizeDelivery: () => authorizeDelivery })
  onTestFinished(async () => {
    try {
      router.close()
      for (const turn of workerTurns) turn.idle.resolve()
      await executor.close()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function project(id: string) {
    const record = projectSchema.parse({
      ...scope, id, kind: 'project', title: id, purpose: 'Verify event routing.', resourceRefs: [],
      status: 'active', successCriteria: ['Isolate work.'], planRevision: 1, milestones: [],
    })
    store.insertProject(record)
    return record.id
  }
  const alpha = project('alpha')
  const beta = project('beta')

  function task(id: string, projectId = alpha) {
    const taskId = taskIdSchema.parse(id)
    const ref = { ...scope, taskId }
    const context = { actor: owner, at: clock, projectId }
    const state = success(store.applyCommand({ type: 'work.create', commandId: `create-${id}`, payload: {
      projectId, requestedOutcome: 'Produce the exact project result.', constraints: [],
      acceptance: { criteria: ['Stay scoped.'], requiresArtifact: false, requiresReceipt: false },
    } }, { ...context, newTaskId: taskId, newAttempt: {
      id: attemptIdSchema.parse(`attempt-${id}`),
      mandate: mandateRefSchema.parse({ ...scope, id: `mandate-${id}`, policyVersion: owner.policyVersion }),
    } })).state
    return { ref, state, context, projectId }
  }

  function launch(item: ReturnType<typeof task>): Promise<ExecutorResult> {
    return executor.launch(item.ref, { expectedVersion: item.state.task.version, presetId, cwd: directory, dataScope,
      input: { cursor: `start-${item.ref.taskId}`, text: 'Do project work.' } })
  }

  function subscribe(item: ReturnType<typeof task>, mode: 'work' | 'context', threadId = 'thread') {
    return success(router.setSubscription(ownerToken, { ...account, projectId: item.projectId, taskId: item.ref.taskId,
      threadId, mode, enabled: true })).subscription
  }

  function event(externalEventId: string, fields: Record<string, unknown> = {}) {
    return { externalEventId, externalRevision: 'rev:z', threadId: 'thread', occurredAt: clock, actorKind: 'person',
      externalActorId: 'actor', projectId: alpha, dataScope, kind: 'event', text: 'One source observation.', ...fields }
  }
  return { store, router, executor, ownerToken, source, otherSource, alpha, beta, nativeInputs, workerTurns,
    task, launch, subscribe, event, advance: () => { clock = later },
    rotatePolicy: () => { profile = { ...profile, policyVersion: 'policy-2' } },
  }
}

describe('authenticated event routing', () => {
  it('rejects impersonation and conflicting payloads, and deduplicates a revision after time advances', () => {
    const f = setup()
    const event = f.event('one')
    expect(f.router.receive(f.ownerToken, event)).toEqual({ ok: false, code: 'permission_denied' })
    expect(f.router.receive({ ...scope, ...account }, event)).toEqual({ ok: false, code: 'permission_denied' })
    expect(f.router.receive(f.source, { ...event, accountId: otherAccount.accountId })).toEqual({ ok: false, code: 'invalid_input' })
    const receipt = success(f.router.receive(f.source, event))
    expect(receipt.disposition).toEqual({ kind: 'rejected', reason: 'target_unavailable' })
    f.advance()
    expect(f.router.receive(f.source, event)).toEqual({ ...receipt, duplicate: true })
    expect(f.router.receive(f.source, { ...event, text: 'Altered content.' })).toMatchObject({ ok: false })
    expect(f.router.receive(f.otherSource, event)).toMatchObject({ ok: false })
    expect(f.router.status(f.otherSource, receipt.eventId)).toBeUndefined()
    const edited = success(f.router.receive(f.source, { ...event, externalRevision: 'rev:a' }))
    expect(edited.eventId).not.toBe(receipt.eventId)
  })

  it('prioritizes an exact target and refuses ambiguous, stale, cross-project or context-only mutation', async () => {
    const assess = vi.fn<RoutingAssessor>(async () => [])
    const f = setup(assess)
    const first = f.task('first')
    const second = f.task('second')
    const other = f.task('other', f.beta)
    f.subscribe(first, 'work')
    f.subscribe(second, 'work')
    f.subscribe(other, 'work')
    f.subscribe(other, 'context', 'context')
    const started = success(await f.launch(first)).state
    success(await f.launch(second))
    success(await f.launch(other))
    const target = { taskId: first.ref.taskId, expectedVersion: started.task.version, generation: started.task.generation }
    f.advance()
    expect(success(f.router.receive(f.source, f.event('ambiguous'))).disposition)
      .toMatchObject({ kind: 'assessed', decision: { kind: 'clarify' } })
    expect(success(f.router.receive(f.source, f.event('mix', { kind: 'candidate', projectId: f.beta, target }))).disposition)
      .toEqual({ kind: 'rejected', reason: 'target_unavailable' })
    expect(success(f.router.receive(f.source, f.event('context', { threadId: 'context', projectId: f.beta }))).disposition)
      .toEqual({ kind: 'context' })
    expect(success(f.router.receive(f.source, f.event('old', { occurredAt: earlier, target }))).disposition.kind).toBe('rejected')
    const delivered = success(f.router.receive(f.source, f.event('target', { kind: 'candidate', target })))
    expect(delivered.disposition).toEqual({ kind: 'routed', inputStatus: 'flushed' })
    expect(f.nativeInputs.map(inputs => inputs.length)).toEqual([2, 1, 1])
    expect(f.nativeInputs[0]?.[1]).toMatchObject({ cursor: delivered.eventId })
    expect(f.store.workerInputs(first.ref, started.attempt.id).at(-1)).toMatchObject({ kind: 'followup', status: 'flushed' })
    expect(f.router.receive(f.source, f.event('target', { kind: 'candidate', target }))).toEqual({ ...delivered, duplicate: true })
    expect(success(f.router.receive(f.source, f.event('stale-version', { target }))).disposition.kind).toBe('rejected')
    const current = f.store.getWork(first.ref)!
    success(f.executor.cancel({ type: 'work.cancel', commandId: 'stop-first', taskId: first.ref.taskId,
      expectedVersion: current.task.version, payload: {} }, { ...first.context, at: later }))
    await f.executor.waitForRelease(first.ref)
    const cancelled = f.store.getWork(first.ref)!
    expect(cancelled.task.status).toBe('cancelled')
    expect(success(f.router.receive(f.source, f.event('cancelled', { target: {
      taskId: first.ref.taskId, expectedVersion: cancelled.task.version, generation: cancelled.task.generation,
    } }))).disposition.kind).toBe('rejected')
    expect(f.store.getWork(first.ref)).toEqual(cancelled)
    expect(f.nativeInputs.map(inputs => inputs.length)).toEqual([2, 1, 1])
    expect(assess).not.toHaveBeenCalled()
  })

  it('batches only candidates in the same scope and validates each proposal without changing work', async () => {
    const assess = vi.fn<RoutingAssessor>(async batch => batch.map(item => item.text === 'ambiguous'
      ? { id: item.id, kind: 'clarify', summary: 'Which task does this reference?' }
      : { id: item.id, kind: 'propose_task', summary: 'Forbidden extra routing field.', taskId: 'unrelated' }))
    const f = setup(assess)
    const unrelated = f.task('unrelated')
    const one = success(f.router.receive(f.source, f.event('one', { kind: 'candidate', text: 'ambiguous' })))
    const two = success(f.router.receive(f.source, f.event('two', { kind: 'candidate', threadId: 'second' })))
    const different = success(f.router.receive(f.source, f.event('different', { kind: 'candidate', projectId: f.beta })))
    expect(one.disposition).toEqual({ kind: 'queued' })
    expect(success(f.router.receive(f.source, f.event('private', { kind: 'candidate', dataScope: ['private'] }))).disposition)
      .toEqual({ kind: 'rejected', reason: 'disclosure_denied' })
    await vi.waitFor(() => expect(f.router.status(f.source, different.eventId)?.disposition.kind).toBe('rejected'))
    expect(assess.mock.calls.map(([batch]) => batch.map(item => item.id))).toEqual([[one.eventId, two.eventId], [different.eventId]])
    expect(f.router.status(f.source, one.eventId)?.disposition).toMatchObject({ kind: 'assessed', decision: { kind: 'clarify' } })
    expect(f.router.status(f.source, two.eventId)?.disposition).toEqual({ kind: 'rejected', reason: 'no_current_decision' })
    expect(f.store.getWork(unrelated.ref)).toEqual(unrelated.state)
  })

  it('keeps distinct observations that occurred after Worker start even when received together later', async () => {
    const f = setup()
    const work = f.task('worker')
    f.subscribe(work, 'work')
    success(await f.launch(work))
    f.advance()
    for (const id of ['first', 'second']) {
      expect(success(f.router.receive(f.source, f.event(id, { occurredAt: at }))).disposition.kind).toBe('routed')
    }
    expect(f.nativeInputs[0]).toHaveLength(3)
  })

  it('does not automatically dispatch a subscribed input without the trusted execution policy', async () => {
    const f = setup(undefined, false)
    const work = f.task('worker')
    f.subscribe(work, 'work')
    const started = success(await f.launch(work)).state
    expect(success(f.router.receive(f.source, f.event('unapproved'))).disposition)
      .toEqual({ kind: 'rejected', reason: 'permission_denied' })
    expect(f.store.getWork(work.ref)).toEqual(started)
    expect(f.nativeInputs[0]).toHaveLength(1)
  })

  it('ignores a decision after the source policy changes while the model is running', async () => {
    const pending = Promise.withResolvers<unknown>()
    const assess = vi.fn<RoutingAssessor>(() => pending.promise)
    const f = setup(assess)
    const item = success(f.router.receive(f.source, f.event('rotate', { kind: 'candidate' })))
    await vi.waitFor(() => expect(assess).toHaveBeenCalledOnce())
    f.rotatePolicy()
    pending.resolve([{ id: item.eventId, kind: 'propose_task', summary: 'Late decision.' }])
    await vi.waitFor(() => expect(f.store.getRoutingEvent({ ...scope, eventId: item.eventId })?.receipt.disposition)
      .toEqual({ kind: 'rejected', reason: 'no_current_decision' }))
    expect(f.router.status(f.source, item.eventId)).toBeUndefined()
  })

  it('assesses an exact Worker handback once without exposing its private report or redelivering the event', async () => {
    const assess = vi.fn<RoutingAssessor>(async batch => batch.map(item => ({ id: item.id, kind: 'ignore' })))
    const f = setup(assess)
    const work = f.task('worker')
    f.subscribe(work, 'work')
    success(await f.launch(work))
    const event = f.event('handback')
    const received = success(f.router.receive(f.source, event))
    const turn = f.workerTurns[0]!
    turn.report = JSON.stringify({ kind: 'handback', cursor: received.eventId, summary: 'Private Worker details.' })
    turn.idle.resolve()
    await vi.waitFor(() => expect(f.router.status(f.source, received.eventId)?.disposition.kind).toBe('assessed'))
    f.router.handback(work.ref, received.eventId)
    expect(f.router.receive(f.source, event)).toMatchObject({ ok: true, duplicate: true })
    expect(assess.mock.calls.map(([batch]) => batch)).toEqual([[{ id: received.eventId, text: event.text, kind: 'handback' }]])
    expect(f.nativeInputs[0]).toHaveLength(2)
    expect(f.store.getWork(work.ref)?.task.status).toBe('running')
  })
})
