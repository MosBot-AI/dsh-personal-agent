import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  accountIdSchema, attemptIdSchema, clientIdSchema, conversationSchema, deliverySchema, deviceIdSchema, mandateRefSchema, ownerIdSchema,
  profileIdSchema, projectSchema, taskIdSchema, utcInstantSchema, type Delivery,
} from '../../packages/personal-agent/src/domain/model.js'
import type { WorkState } from '../../packages/personal-agent/src/domain/transitions.js'
import type { AttentionOptions } from '../../packages/personal-agent/src/runtime/attention.js'
import type { OutboxSendRequest } from '../../packages/personal-agent/src/runtime/outbox.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const scope = { ownerId: ownerIdSchema.parse('attention-owner'), profileId: profileIdSchema.parse('attention-profile') }
const actor = { ...scope, role: 'owner', clientId: clientIdSchema.parse('attention-client'),
  deviceId: deviceIdSchema.parse('attention-device'), policyVersion: 'attention-test' } as const
const noon = '2026-11-07T12:00:00.000Z'
const seededAt = utcInstantSchema.parse('2026-11-01T00:00:00.000Z')
const project = projectSchema.parse({
  ...scope, id: 'attention-project', kind: 'project', title: 'Attention fixture', purpose: 'Protect the owner’s attention.',
  resourceRefs: [], status: 'active', successCriteria: ['Keep notifications bounded.'], planRevision: 1, milestones: [],
})

function fixture(allowExternal: AttentionOptions['allowExternal'] = () => true) {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-attention-'))
  let store: WorkStore | undefined
  let clock = utcInstantSchema.parse(noon)
  onTestFinished(() => {
    try { store?.close() } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  function open() {
    const current = openWorkStore(directory)
    store = current
    return { store: current, attention: current.createAttention({ now: () => clock, allowExternal }) }
  }
  const initial = open()
  initial.store.insertProject(project)
  return { ...initial,
    at(value: string) { clock = utcInstantSchema.parse(value) },
    reopen() { store?.close(); return open() },
  }
}

function succeed<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`Expected attention success, received ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

function task(store: WorkStore, name: string, ids: readonly string[] = []) {
  const destination = { sourceInstanceId: `channel-${name}`, externalDestinationId: `thread-${name}` }
  const conversation = conversationSchema.parse({ ...scope, id: `conversation-${name}`, sessionIds: [], originalDestination: destination })
  store.insertConversation(conversation)
  const deliveries = ids.map(id => deliverySchema.parse({
    ...scope, id, destination, payload: { text: `Fixture ${id}`, artifactIds: [] }, dedupeKey: `key-${id}`, retries: 0, status: 'pending',
  }))
  const taskId = taskIdSchema.parse(`task-${name}`)
  const ref = { ...scope, taskId }
  const state = succeed(store.applyCommand({
    type: 'work.create', commandId: `create-${name}`, conversationId: conversation.id,
    payload: { projectId: project.id, requestedOutcome: 'Keep only useful updates.', constraints: [],
      acceptance: { criteria: ['Inspect the result.'], requiresArtifact: false, requiresReceipt: false } },
  }, { actor, at: seededAt, projectId: project.id, conversationId: conversation.id, newTaskId: taskId,
    newAttempt: { id: attemptIdSchema.parse(`attempt-${name}`),
      mandate: mandateRefSchema.parse({ ...scope, id: `mandate-${name}`, policyVersion: actor.policyVersion }) },
  }, { deliveries })).state
  return { ref, state, destination, deliveries }
}

function candidate(state: WorkState, category: string, externalEventId: string, delivery?: Delivery) {
  return { attemptId: state.attempt.id, generation: state.attempt.generation, expectedVersion: state.task.version, category,
    source: { sourceInstanceId: 'fixture-source', externalEventId, externalRevision: 'v1' },
    ...(delivery === undefined ? {} : { deliveryId: delivery.id }),
  }
}

function policy(mode: 'off' | 'observe' | 'prepare' | 'act') {
  return { mode, timeZone: 'UTC', quietHours: null, urgentRules: [] }
}

describe('durable attention policy', () => {
  it('shares the owner cap between granted local notices and external reservations', () => {
    const f = fixture()
    const work = task(f.store, 'shared-budget', ['external-one', 'external-two'])
    succeed(f.attention.configure(scope, policy('act'), 0))
    const local = (id: string) => ({ ...candidate(work.state, 'proactive', id), local: true })
    expect(succeed(f.attention.consider(work.ref, local('unauthorized'))).decision.reason).toBe('external_not_authorized')
    expect(succeed(f.attention.consider(work.ref, candidate(work.state, 'proactive', 'external', work.deliveries[0]))).decision.action).toBe('reserved')
    for (const id of ['local-one', 'local-two']) {
      expect(succeed(f.attention.consider(work.ref, local(id), () => true)).decision.action).toBe('local')
    }
    expect(succeed(f.attention.consider(work.ref, candidate(work.state, 'proactive', 'external-extra', work.deliveries[1]))).decision.reason)
      .toBe('daily_limit')
    expect(f.reopen().attention.snapshot(scope).unsolicitedUsed).toBe(3)
  })

  it('coalesces progress without notification reservations and rejects identity changes on replay', () => {
    const f = fixture()
    const work = task(f.store, 'progress')
    const other = task(f.store, 'other')
    expect(f.attention.snapshot(scope)).toMatchObject({ policy: { mode: 'off', version: 0 }, unsolicitedUsed: 0, day: '2026-11-07' })
    const first = { ...candidate(work.state, 'progress', 'progress-1'), summary: 'First update.' }
    const second = { ...candidate(work.state, 'progress', 'progress-2'), summary: 'Newest update.' }
    expect(succeed(f.attention.consider(work.ref, first))).toMatchObject({ duplicate: false, decision: { action: 'workspace', reason: 'coalesced_progress' } })
    expect(succeed(f.attention.consider(work.ref, second))).toMatchObject({ duplicate: false })
    expect(succeed(f.attention.consider(work.ref, first))).toMatchObject({ duplicate: true })
    expect(f.attention.consider(work.ref, { ...first, summary: 'Changed replay' })).toEqual({ ok: false, code: 'candidate_conflict' })
    expect(f.attention.consider(other.ref, { ...candidate(other.state, 'progress', 'progress-1'), summary: 'Wrong task' }))
      .toEqual({ ok: false, code: 'candidate_conflict' })
    expect(f.attention.consider({ ...work.ref, ownerId: ownerIdSchema.parse('wrong-owner') }, second))
      .toEqual({ ok: false, code: 'not_found' })
    expect(f.attention.consider(work.ref, { ...second, ownerId: scope.ownerId })).toEqual({ ok: false, code: 'invalid_input' })
    const persisted = f.reopen().attention.snapshot(scope)
    expect(persisted.progress).toEqual([{ taskId: work.ref.taskId, attemptId: work.state.attempt.id,
      generation: work.state.attempt.generation, summary: 'Newest update.', at: noon }])
    expect(persisted.decisions).toHaveLength(2)
    expect(persisted.decisions.every(decision => !('summary' in decision))).toBe(true)
    expect(persisted.unsolicitedUsed).toBe(0)
  })

  it('evaluates one hundred noisy, duplicate, and useful candidates across all four policy modes', () => {
    const f = fixture()
    const allIds = Array.from({ length: 100 }, (_, index) => `notice-${index}`)
    const a = task(f.store, 'channel-a', allIds.filter((_, index) => index % 2 === 0))
    const b = task(f.store, 'channel-b', allIds.filter((_, index) => index % 2 !== 0))
    const reasons: Record<string, number> = {}
    const reservedDestinations = new Set<string>()
    let duplicates = 0
    let progress: { work: typeof a; input: unknown } | undefined

    for (const [revision, mode] of (['off', 'observe', 'prepare', 'act'] as const).entries()) {
      expect(succeed(f.attention.configure(scope, policy(mode), revision)).policy.version).toBe(revision + 1)
      for (let offset = 0; offset < 25; offset++) {
        const index = revision * 25 + offset
        const work = index % 2 === 0 ? a : b
        if (offset % 5 === 1 && progress) {
          expect(succeed(f.attention.consider(progress.work.ref, progress.input)).duplicate).toBe(true)
          duplicates++
          continue
        }
        if (offset % 5 === 0) {
          progress = { work, input: { ...candidate(work.state, 'progress', `progress-${index}`), summary: `Update ${index}` } }
          expect(succeed(f.attention.consider(work.ref, progress.input)).decision.reason).toBe('coalesced_progress')
          continue
        }
        const delivery = work.deliveries.find(item => item.id === `notice-${index}`)
        expect(delivery).toBeDefined()
        const { decision } = succeed(f.attention.consider(work.ref, candidate(work.state, 'proactive', `candidate-${index}`, delivery)))
        reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1
        if (decision.action === 'reserved') reservedDestinations.add(decision.destination!.sourceInstanceId)
      }
    }
    expect(duplicates).toBe(20)
    expect(reasons).toEqual({ mode_off: 15, observe_only: 15, prepare_only: 15, proactive_act: 3, daily_limit: 12 })
    expect(reservedDestinations.size).toBe(2)
    expect(f.reopen().attention.snapshot(scope)).toMatchObject({
      policy: { mode: 'act', version: 4 }, unsolicitedUsed: 3, unsolicitedLimit: 3, suppressedToday: 42,
    })
  })

  it('honors IANA quiet hours across the repeated DST hour with exact urgent and explicit-reminder exceptions', () => {
    const f = fixture(request => request.candidate.category !== 'reminder'
      || request.candidate.source.sourceInstanceId === 'owner-reminder')
    const work = task(f.store, 'quiet', ['first-fold', 'second-fold', 'urgent', 'fake-reminder', 'reminder', 'after-quiet'])
    const [first, second, urgent, fakeReminder, reminder, afterQuiet] = work.deliveries
    expect(succeed(f.attention.configure(scope, { mode: 'act', timeZone: 'America/New_York',
      quietHours: { start: '22:00', end: '08:00' }, urgentRules: [{ category: 'proactive', sourceInstanceId: 'fixture-source' }],
    }, 0)).policy.version).toBe(1)
    f.at('2026-11-01T05:30:00.000Z')
    expect(succeed(f.attention.consider(work.ref, candidate(work.state, 'proactive', 'fold-1', first))).decision.reason).toBe('quiet_hours')
    f.at('2026-11-01T06:30:00.000Z')
    expect(succeed(f.attention.consider(work.ref, candidate(work.state, 'proactive', 'fold-2', second))).decision.reason).toBe('quiet_hours')
    expect(succeed(f.attention.consider(work.ref, { ...candidate(work.state, 'proactive', 'urgent-event', urgent), urgent: true })).decision)
      .toMatchObject({ action: 'reserved', reason: 'urgent_exception' })
    expect(succeed(f.attention.consider(work.ref, candidate(work.state, 'reminder', 'untrusted', fakeReminder))).decision.reason)
      .toBe('external_not_authorized')
    const explicit = candidate(work.state, 'reminder', 'explicit', reminder)
    expect(succeed(f.attention.consider(work.ref, { ...explicit, source: { ...explicit.source, sourceInstanceId: 'owner-reminder' } })).decision)
      .toMatchObject({ action: 'reserved', reason: 'explicit_reminder' })
    f.at('2026-11-01T13:00:00.000Z')
    expect(succeed(f.attention.consider(work.ref, candidate(work.state, 'proactive', 'after-hours', afterQuiet))).decision.reason)
      .toBe('proactive_act')
    expect(f.attention.snapshot(scope)).toMatchObject({ day: '2026-11-01', unsolicitedUsed: 2, suppressedToday: 3 })
  })

  it('claims once for the exact pending delivery and fences changed policy, task and local day', () => {
    const f = fixture()
    const work = task(f.store, 'claims', ['one', 'two', 'three', 'four'])
    const [one, two, three, four] = work.deliveries
    const reserve = (id: string, delivery: Delivery | undefined) =>
      succeed(f.attention.consider(work.ref, candidate(work.state, 'proactive', id, delivery))).decision.id
    expect(succeed(f.attention.configure(scope, policy('act'), 0)).policy.version).toBe(1)
    const first = reserve('first', one)
    const second = reserve('second', two)
    expect(f.attention.claim(work.ref, first)).toEqual({ ok: true, deliveryId: one?.id, destination: work.destination })
    expect(f.attention.claim(work.ref, first)).toEqual({ ok: false, code: 'already_claimed' })
    expect(f.store.getDelivery(work.ref, one!.id)?.status).toBe('pending')
    expect(f.attention.claim({ ...work.ref, profileId: profileIdSchema.parse('other-profile') }, second))
      .toEqual({ ok: false, code: 'not_found' })
    expect(succeed(f.attention.configure(scope, policy('act'), 1)).policy.version).toBe(2)
    expect(f.attention.claim(work.ref, second)).toEqual({ ok: false, code: 'policy_changed' })
    const third = reserve('third', three)
    f.at('2026-11-08T00:00:00.000Z')
    expect(f.attention.claim(work.ref, third)).toEqual({ ok: false, code: 'reservation_expired' })
    const fourth = reserve('fourth', four)
    succeed(f.store.applyEvent(work.ref, { type: 'start', at: seededAt, expectedVersion: work.state.task.version,
      attemptId: work.state.attempt.id, generation: work.state.attempt.generation, executor: 'fixture' }))
    expect(f.attention.claim(work.ref, fourth)).toEqual({ ok: false, code: 'version_conflict' })
    const snapshot = f.reopen().attention.snapshot(scope)
    expect(snapshot.unsolicitedUsed).toBe(1)
    expect(snapshot.decisions.find(decision => decision.id === second)?.claimReason).toBe('policy_changed')
    expect(snapshot.decisions.find(decision => decision.id === fourth)?.claimReason).toBe('version_conflict')
  })

  it('denies external admission without trusted authority and rejects wrong-task delivery ids', () => {
    const f = fixture(() => false)
    const a = task(f.store, 'private', ['own-delivery'])
    const b = task(f.store, 'unrelated', ['other-delivery'])
    succeed(f.attention.configure(scope, policy('act'), 0))
    const foreign = succeed(f.attention.consider(a.ref, candidate(a.state, 'proactive', 'foreign', b.deliveries[0]))).decision
    expect(foreign).toMatchObject({ action: 'suppressed', reason: 'delivery_unavailable' })
    const denied = succeed(f.attention.consider(a.ref, candidate(a.state, 'proactive', 'denied', a.deliveries[0]))).decision
    expect(denied).toMatchObject({ action: 'suppressed', reason: 'external_not_authorized' })
    expect(f.attention.claim(a.ref, denied.id)).toEqual({ ok: false, code: 'not_reserved' })
    expect(f.attention.snapshot(scope).unsolicitedUsed).toBe(0)
  })

  it('counts authorized reminders, approvals, and query responses separately from unsolicited reservations', () => {
    const f = fixture()
    const work = task(f.store, 'separate', ['p1', 'p2', 'p3', 'p4', 'r1', 'a1', 'q1'])
    expect(f.attention.configure(scope, { ...policy('act'), timeZone: '+08:00' }, 0))
      .toEqual({ ok: false, code: 'invalid_input' })
    succeed(f.attention.configure(scope, policy('act'), 0))
    for (const [index, delivery] of work.deliveries.slice(0, 4).entries()) {
      const { decision } = succeed(f.attention.consider(work.ref, candidate(work.state, 'proactive', delivery.id, delivery)))
      expect(decision.reason).toBe(index < 3 ? 'proactive_act' : 'daily_limit')
    }
    const explicit = (['reminder', 'approval', 'query'] as const).map((category, index) =>
      succeed(f.attention.consider(work.ref, candidate(work.state, category, category, work.deliveries[index + 4]))).decision)
    expect(explicit.map(decision => decision.reason)).toEqual(['explicit_reminder', 'required_approval', 'query_response'])
    expect(f.attention.snapshot(scope).unsolicitedUsed).toBe(3)
    f.at('2026-11-08T00:00:00.000Z')
    expect(f.attention.claim(work.ref, explicit[0]!.id)).toMatchObject({ ok: true, deliveryId: work.deliveries[4]?.id })
    expect(f.attention.snapshot(scope)).toMatchObject({ day: '2026-11-08', unsolicitedUsed: 0, suppressedToday: 0 })
  })

  it('hands off only a live one-use attention reservation to the same store Outbox', async () => {
    const f = fixture()
    const suppressed = task(f.store, 'suppressed-handoff', ['suppressed-delivery'])
    const allowed = task(f.store, 'allowed-handoff', ['allowed-delivery'])
    const denied = succeed(f.attention.consider(suppressed.ref,
      candidate(suppressed.state, 'proactive', 'suppressed', suppressed.deliveries[0]))).decision
    expect(denied.reason).toBe('mode_off')
    succeed(f.attention.configure(scope, policy('act'), 0))
    const reserved = succeed(f.attention.consider(allowed.ref,
      candidate(allowed.state, 'proactive', 'allowed', allowed.deliveries[0]))).decision
    expect(reserved.action).toBe('reserved')
    expect(await f.attention.deliver(allowed.ref, reserved.id)).toEqual({ ok: false, code: 'delivery_unavailable' })
    expect(f.attention.snapshot(scope).decisions.find(item => item.id === reserved.id)?.claimedAt).toBeUndefined()

    const sent: OutboxSendRequest[] = []
    f.store.createOutbox({
      now: () => utcInstantSchema.parse(noon),
      allowDisclosure: () => true,
      resolveRoute: route => ({ ...route, id: 'fixture-route', accountId: accountIdSchema.parse('fixture-account'), provider: {
        async send(request) {
          sent.push(request)
          return { kind: 'accepted', receiptId: 'fixture-receipt', deliveryId: request.deliveryId,
            dedupeKey: request.dedupeKey, destination: request.destination }
        },
      } }),
    })
    expect(await f.attention.deliver(suppressed.ref, denied.id)).toEqual({ ok: false, code: 'not_reserved' })
    expect(await f.attention.deliver(suppressed.ref, reserved.id)).toEqual({ ok: false, code: 'not_found' })
    expect(sent).toHaveLength(0)
    const handoff = f.attention.deliver(allowed.ref, reserved.id)
    expect(sent).toHaveLength(1)
    expect(await handoff).toMatchObject({ ok: true, delivery: { id: allowed.deliveries[0]?.id,
      destination: allowed.destination, status: 'accepted', receipt: { providerReceiptId: 'fixture-receipt' } } })
    expect(await f.attention.deliver(allowed.ref, reserved.id)).toEqual({ ok: false, code: 'already_claimed' })
    expect(f.store.getDelivery(suppressed.ref, suppressed.deliveries[0]!.id)?.status).toBe('pending')
    expect(sent.map(item => item.deliveryId)).toEqual([allowed.deliveries[0]?.id])
  })
})
