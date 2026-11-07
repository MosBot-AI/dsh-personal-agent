import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import {
  attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, profileSchema, projectSchema,
  sessionIdSchema, taskIdSchema, utcInstantSchema, type UtcInstant,
} from '../../packages/personal-agent/src/domain/model.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import { authenticateEvent } from '../../packages/personal-agent/src/runtime/intake.js'
import { makeWorkerInput } from '../../packages/personal-agent/src/runtime/input-journal.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const before = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const at = utcInstantSchema.parse('2026-11-07T08:01:00.000Z')
const later = utcInstantSchema.parse('2026-11-07T08:02:00.000Z')
const sourceInstanceId = 'storage-routing-source'
const accountId = 'account-one'
const profile = profileSchema.parse({
  id: 'routing-profile', ownerId: 'routing-owner', policyVersion: 'routing-policy',
  verifiedDevices: [{ deviceId: 'storage-device', verifiedAt: before }],
  verifiedAccounts: [
    { sourceInstanceId, accountId, verifiedAt: before },
    { sourceInstanceId, accountId: 'account-two', verifiedAt: before },
  ],
})
const scope = { ownerId: profile.ownerId, profileId: profile.id }
const authority = { policyVersion: profile.policyVersion, verifiedAt: before }
const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
const actor = {
  role: 'owner',
  ...scope,
  policyVersion: profile.policyVersion,
  clientId: clientIdSchema.parse('storage-client'),
  deviceId: deviceIdSchema.parse('storage-device'),
} as const
const project = projectSchema.parse({
  id: 'routing-project', ...scope, kind: 'project', title: 'Routing storage fixture',
  purpose: 'Verify durable routing.', resourceRefs: [], status: 'active',
  successCriteria: ['Retain exact scoped routing.'], planRevision: 1, milestones: [],
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-routing-store-'))
  let store: WorkStore | undefined
  onTestFinished(() => {
    try { store?.close() } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  store = openWorkStore(directory)
  store.insertProject(project)
  return {
    store,
    reopen() {
      store?.close()
      store = undefined
      store = openWorkStore(directory)
      return store
    },
  }
}

function mustSucceed<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`Expected storage acceptance: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

function admitted(
  label: string,
  input: Record<string, unknown> = {},
  receivedAt: UtcInstant = at,
  sourceAccount = accountId,
) {
  const token = identity.bindSource({ ...scope, sourceInstanceId, accountId: sourceAccount })
  return mustSucceed(authenticateEvent(identity, token, {
    kind: 'event',
    projectId: project.id,
    dataScope: ['fixture-public'],
    text: `Fixture ${label}`,
    threadId: 'fixture-thread',
    externalEventId: label,
    externalRevision: '1',
    occurredAt: at,
    actorKind: 'service',
    externalActorId: 'fixture-actor',
    ...input,
  }, receivedAt))
}

function record(store: WorkStore, event: ReturnType<typeof admitted>) {
  return store.recordRoutingEvent(event.event, event.digest, { projectId: project.id, authority: event.authority })
}

function task(store: WorkStore, label: string, sourceEvent?: ReturnType<typeof admitted>['event']) {
  const taskId = taskIdSchema.parse(`task-${label}`)
  const attemptId = attemptIdSchema.parse(`attempt-${label}`)
  const state = mustSucceed(store.applyCommand({
    type: 'work.create', commandId: `create-${label}`,
    payload: {
      projectId: project.id, requestedOutcome: 'Verify the fixture.', constraints: [],
      acceptance: { criteria: ['Inspect the fixture.'], requiresArtifact: false, requiresReceipt: false },
    },
  }, {
    actor, at: before, projectId: project.id, newTaskId: taskId,
    newAttempt: {
      id: attemptId,
      mandate: mandateRefSchema.parse({ id: `mandate-${label}`, ...scope, policyVersion: profile.policyVersion }),
    },
  }, { sourceEvent })).state
  return { ref: { ...scope, taskId }, state }
}

it('persists receipt CAS and deduplicates canonical retries independently of receive time', () => {
  const fixtureStore = fixture()
  const { store } = fixtureStore
  const event = admitted('one')
  const ref = { ...scope, eventId: event.event.id }
  const first = mustSucceed(record(store, event))
  expect(first).toMatchObject({ duplicate: false, receipt: { version: 1, disposition: { kind: 'pending' } } })
  const queued = mustSucceed(store.setRoutingDisposition(ref, first.receipt.version, { kind: 'queued' }))
  expect(store.setRoutingDisposition(ref, first.receipt.version, { kind: 'rejected', reason: 'stale' }))
    .toEqual({ ok: false, code: 'version_conflict' })
  const settled = mustSucceed(store.setRoutingDisposition(ref, queued.receipt.version, {
    kind: 'assessed', decision: { kind: 'ignore', summary: 'Known fixture.' },
  }))

  const reopened = fixtureStore.reopen()
  expect(record(reopened, admitted('one', {}, later))).toEqual({ ok: true, duplicate: true, receipt: settled.receipt })
  expect(reopened.getRoutingEvent(ref)?.event.receivedAt).toBe(at)
  expect(record(reopened, admitted('one', { text: 'Changed body.' }))).toEqual({ ok: false, code: 'source_conflict' })
  expect(record(reopened, admitted('one', {}, later, 'account-two'))).toEqual({ ok: false, code: 'source_conflict' })
  expect(reopened.setRoutingDisposition(ref, settled.receipt.version, { kind: 'queued' }))
    .toEqual({ ok: false, code: 'invalid_transition' })
})

it('does not reroute legacy source records and bounds interrupted startup classification', () => {
  const { store } = fixture()
  const legacy = admitted('legacy')
  task(store, 'legacy', legacy.event)
  expect(record(store, legacy)).toEqual({ ok: false, code: 'source_duplicate' })
  expect(store.getRoutingEvent({ ...scope, eventId: legacy.event.id })).toBeUndefined()

  const pending = mustSucceed(record(store, admitted('pending'))).receipt
  const waiting = mustSucceed(record(store, admitted('queued'))).receipt
  const queued = mustSucceed(store.setRoutingDisposition({ ...scope, eventId: waiting.eventId }, waiting.version, { kind: 'queued' }))
  expect(store.cancelUnfinishedRouting(undefined, 1)).toBe(1)
  expect(store.getRoutingEvent({ ...scope, eventId: pending.eventId })?.receipt.disposition)
    .toEqual({ kind: 'rejected', reason: 'interrupted' })
  expect(store.getRoutingEvent({ ...scope, eventId: waiting.eventId })?.receipt).toEqual(queued.receipt)
  expect(store.cancelUnfinishedRouting(scope)).toBe(1)
  expect(store.listRoutingEvents(scope)).toEqual([])
})

it('atomically fences routed Worker input and consumes handback once without changing Task state', () => {
  const { store } = fixture()
  const { ref, state: queued } = task(store, 'worker')
  const sessionId = sessionIdSchema.parse('routing-worker-session')
  const start = makeWorkerInput(queued, sessionId, { cursor: 'initial', text: 'Initial fixture input.' }, 'followup')
  const startEvent = {
    type: 'start', at, expectedVersion: queued.task.version, attemptId: queued.attempt.id, generation: queued.attempt.generation,
    executor: 'fixture', sessionId, scope: { capabilities: [], dataScope: ['fixture-public'] },
    worker: { presetId: 'fixture', cwd: '/fixture', provider: 'fixture', model: 'fixture', inputCursor: 'initial', inputHistory: ['initial'] },
  }
  expect(store.applyEvent(ref, startEvent)).toEqual({ ok: false, code: 'permission_denied' })
  expect(store.getWork(ref)).toEqual(queued)
  const running = mustSucceed(store.applyWorkerEvent(ref, startEvent, start)).state
  expect(store.acknowledgeWorkerInput(ref, start, at)).toBe(true)

  const event = admitted('original')
  const first = mustSucceed(record(store, event)).receipt
  const key = {
    ...scope, taskId: ref.taskId,
    sourceInstanceId: event.event.sourceInstanceId, accountId: event.event.actor.accountId!, threadId: event.event.threadId!,
  }
  const write = { ...key, projectId: project.id, enabled: true, updatedAt: at, authority, mode: 'context' } as const
  const context = mustSucceed(store.putSubscription(write)).subscription
  expect(store.putSubscription({ ...write, mode: 'work' })).toEqual({ ok: false, code: 'version_conflict' })
  const route = (eventId: typeof first.eventId, subscriptionVersion: number) => ({
    eventId, expectedReceiptVersion: first.version, projectId: project.id, subscriptionVersion, authority, mode: 'work' as const,
  })
  const workerEvent = (cursor: string) => ({
    type: 'record_input', at: later, expectedVersion: running.task.version,
    attemptId: running.attempt.id, generation: running.attempt.generation, cursor,
  })
  expect(store.applyEvent(ref, workerEvent(first.eventId))).toEqual({ ok: false, code: 'permission_denied' })
  const oldInput = makeWorkerInput(running, sessionId, { cursor: first.eventId, text: 'Old fixture event.' }, 'steer')
  expect(store.applyWorkerEvent(ref, workerEvent(oldInput.cursor), oldInput, route(first.eventId, context.version)))
    .toEqual({ ok: false, code: 'permission_denied' })
  const work = mustSucceed(store.putSubscription({ ...write, mode: 'work', updatedAt: later }, context.version)).subscription
  expect(store.getSubscription(key)).toEqual(work)
  expect(store.listSubscriptions(key, project.id, at)).toEqual([])
  expect(store.listSubscriptions(key, project.id, later)).toEqual([work])
  expect(store.applyWorkerEvent(ref, workerEvent(oldInput.cursor), oldInput, route(first.eventId, work.version)))
    .toEqual({ ok: false, code: 'permission_denied' })

  const fresh = mustSucceed(record(store, admitted('fresh', { occurredAt: later }, later))).receipt
  const freshRef = { ...scope, eventId: fresh.eventId }
  const input = makeWorkerInput(running, sessionId, { cursor: fresh.eventId, text: 'Fresh fixture event.' }, 'steer')
  expect(store.applyWorkerEvent(ref, workerEvent(input.cursor), { ...input, digest: '0'.repeat(64) as typeof input.digest },
    route(fresh.eventId, work.version))).toEqual({ ok: false, code: 'stale_attempt' })
  expect(store.getWork(ref)).toEqual(running)
  expect(store.workerInputs(ref, running.attempt.id)).toHaveLength(1)
  expect(store.getRoutingEvent(freshRef)?.receipt).toEqual(fresh)

  const changed = mustSucceed(store.applyWorkerEvent(ref, workerEvent(input.cursor), input, route(fresh.eventId, work.version)))
  const handback = {
    eventId: fresh.eventId, attemptId: input.attemptId, generation: input.generation, cursor: input.cursor,
    expectedVersion: changed.state.task.version,
  }
  expect(store.getRoutingEvent(freshRef)?.receipt).toMatchObject({
    eventId: fresh.eventId, version: 2, disposition: { kind: 'routed' }, delivery: {
      taskId: ref.taskId, attemptId: input.attemptId, generation: input.generation, cursor: input.cursor,
      taskVersion: changed.state.task.version, subscriptionVersion: work.version, mode: 'work', inputStatus: 'intent',
    },
  })
  expect(store.applyWorkerHandback(ref, handback)).toBe(false)
  expect(store.acknowledgeWorkerInput(ref, input, later)).toBe(true)
  expect(store.getRoutingEvent(freshRef)?.receipt.delivery?.inputStatus).toBe('flushed')
  expect(store.applyWorkerHandback(ref, { ...handback, cursor: 'wrong-cursor' })).toBe(false)
  expect(store.applyWorkerHandback(ref, handback)).toBe(true)
  expect(store.applyWorkerHandback(ref, handback)).toBe(false)
  expect(store.getRoutingEvent(freshRef)?.receipt).toMatchObject({
    version: 3, disposition: { kind: 'handback' }, delivery: { handbackAt: expect.any(String) },
  })
  expect(store.getWork(ref)).toEqual(changed.state)
  expect(store.cancelUnfinishedRouting(scope)).toBe(2)
  expect(store.getRoutingEvent(freshRef)?.receipt).toMatchObject({
    disposition: { kind: 'rejected', reason: 'interrupted' }, delivery: { handbackAt: expect.any(String), inputStatus: 'flushed' },
  })
})
