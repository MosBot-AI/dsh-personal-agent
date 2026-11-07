import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  accountIdSchema,
  artifactIdSchema,
  attemptIdSchema,
  clientIdSchema,
  conversationSchema,
  deliverySchema,
  deviceIdSchema,
  mandateRefSchema,
  ownerIdSchema,
  profileIdSchema,
  projectSchema,
  taskIdSchema,
  utcInstantSchema,
  type Delivery,
} from '../../packages/personal-agent/src/domain/model.js'
import type { WorkState } from '../../packages/personal-agent/src/domain/transitions.js'
import type {
  OutboxLookupRequest,
  OutboxOptions,
  OutboxRoute,
  OutboxSendRequest,
} from '../../packages/personal-agent/src/runtime/outbox.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore, type StoredWorkResult, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const ownerId = ownerIdSchema.parse('owner')
const profileId = profileIdSchema.parse('profile')
const actor = {
  role: 'owner',
  ownerId,
  profileId,
  clientId: clientIdSchema.parse('client'),
  deviceId: deviceIdSchema.parse('device'),
  policyVersion: 'policy-1',
} as const
const project = projectSchema.parse({
  id: 'project',
  ownerId,
  profileId,
  kind: 'project',
  title: 'Outbox fixtures',
  purpose: 'Verify durable provider handoff.',
  resourceRefs: [],
  status: 'active',
  successCriteria: ['Preserve exact provider receipts.'],
  planRevision: 1,
  milestones: [],
})
const conversation = conversationSchema.parse({
  id: 'conversation',
  ownerId,
  profileId,
  sessionIds: [],
  originalDestination: { sourceInstanceId: 'source', externalDestinationId: 'thread' },
})
const accountId = accountIdSchema.parse('provider-account')
const artifactId = artifactIdSchema.parse('private-artifact')
const destination = conversation.originalDestination
const criterion = 'Verify the requested outcome.'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-outbox-'))
  let store = openWorkStore(directory)
  let clock = Date.parse(at)
  store.insertProject(project)
  store.insertConversation(conversation)
  onTestFinished(() => {
    try {
      store.close()
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
  return {
    get store() { return store },
    now: () => utcInstantSchema.parse(new Date(clock).toISOString()),
    advance(ms: number) { clock += ms },
    reopen(beforeOpen?: (db: DatabaseSync) => void) {
      store.close()
      if (beforeOpen) {
        const db = new DatabaseSync(join(directory, DATABASE_FILENAME))
        try {
          beforeOpen(db)
        } finally {
          db.close()
        }
      }
      store = openWorkStore(directory)
      return store
    },
  }
}

function state(result: StoredWorkResult): WorkState {
  if (!result.ok) throw new Error(`Work operation failed with ${result.code}`)
  return result.state
}

function message(label: string, overrides: Partial<Delivery> = {}): Delivery {
  return deliverySchema.parse({
    id: `delivery-${label}`,
    ownerId,
    profileId,
    destination,
    payload: { text: `Verified result for ${label}.`, artifactIds: [] },
    dedupeKey: `dedupe-${label}`,
    retries: 0,
    status: 'pending',
    ...overrides,
  })
}

function createTask(store: WorkStore, label: string, deliveries: Delivery[] = [], requiresArtifact = false) {
  const taskId = taskIdSchema.parse(`task-${label}`)
  const ref = { ownerId, profileId, taskId }
  const newAttempt = {
    id: attemptIdSchema.parse(`attempt-${label}`),
    mandate: mandateRefSchema.parse({ id: `mandate-${label}`, ownerId, profileId, policyVersion: actor.policyVersion }),
  }
  const context = { actor, at, newAttempt, conversationId: conversation.id, projectId: project.id }
  const work = state(store.applyCommand({
    type: 'work.create',
    commandId: `create-${label}`,
    conversationId: conversation.id,
    payload: {
      projectId: project.id,
      requestedOutcome: 'Create a verified deliverable.',
      constraints: [],
      acceptance: { criteria: [criterion], requiresArtifact, requiresReceipt: false },
    },
  }, { ...context, newTaskId: taskId }, { deliveries }))
  return { ref, context, work }
}

function fence(work: WorkState) {
  return { expectedVersion: work.task.version, attemptId: work.attempt.id, generation: work.attempt.generation, at }
}

async function completeTask(store: WorkStore, label: string, deliveries: Delivery[], withPrivateArtifact = false) {
  const { ref, work, context } = createTask(store, label, [], withPrivateArtifact)
  const running = state(store.applyEvent(ref, { type: 'start', ...fence(work), executor: 'fixture' }))
  if (withPrivateArtifact) {
    const { attemptId, generation, expectedVersion } = fence(running)
    store.artifacts.seal(ref, {
      id: artifactId,
      attemptId,
      generation,
      expectedVersion,
      mediaType: 'text/plain',
      sourceEventIds: [],
      visibility: 'private',
      bytes: new TextEncoder().encode('Verified fixture attachment.'),
    })
  }
  const ready = state(store.applyEvent(ref, {
    type: 'ready', ...fence(running), artifactIds: withPrivateArtifact ? [artifactId] : [],
  }))
  const verifier = store.createVerifier({ now: () => at, check: () => [{ criterion, satisfied: true, evidence: 'Checked fixture output.' }] })
  const verified = state(await verifier.verify(ref, { expectedVersion: ready.task.version, deliveries }))
  return { ref, context, verified }
}

function response(
  request: OutboxSendRequest | OutboxLookupRequest,
  outcome: { kind: 'accepted' | 'delivered' | 'read'; receiptId: string }
    | { kind: 'not_sent'; retryable: boolean }
    | { kind: 'absent' },
) {
  const { deliveryId, dedupeKey, destination: target } = request
  return { deliveryId, dedupeKey, destination: target, ...outcome }
}

function outboxOptions(provider: OutboxRoute['provider'], extra: Partial<OutboxOptions> = {}): OutboxOptions {
  return {
    resolveRoute: scope => ({ ...scope, id: 'fixture-route', accountId, provider }),
    allowDisclosure: () => true,
    ...extra,
  }
}

describe('durable Outbox delivery', () => {
  it('claims before sending, preserves FIFO within a task/channel and leaves other tasks responsive', async () => {
    const { store } = fixture()
    const first = message('first')
    const second = message('second')
    const other = message('other')
    const { ref, verified } = await completeTask(store, 'ordered', [first, second])
    const unrelated = await completeTask(store, 'unrelated', [other])
    const hold = Promise.withResolvers<unknown>()
    const entered = Promise.withResolvers<OutboxSendRequest>()
    const send = vi.fn(async (request: OutboxSendRequest) => {
      if (request.deliveryId === first.id) {
        entered.resolve(request)
        return hold.promise
      }
      return response(request, { kind: 'accepted', receiptId: `receipt-${request.deliveryId}` })
    })
    const outbox = store.createOutbox(outboxOptions({ send }))
    const inFlight = outbox.deliver(ref, first.id)
    const request = await Promise.race([entered.promise, inFlight.then(() => { throw new Error('Provider was not invoked') })])
    try {
      expect(store.getDelivery(ref, first.id)).toMatchObject({ status: 'dispatching' })
      expect(store.hasUnsettledEffects(ref, verified.attempt.id)).toBe(true)
      expect(outbox.isActive()).toBe(true)
      expect(() => store.close()).toThrow(expect.objectContaining({ code: 'busy' }))
      expect(request.destination).toEqual(destination)
      expect(request.accountId).toBe(accountId)
      expect(request.routeId).toBe('fixture-route')
      expect(Object.isFrozen(request.payload)).toBe(true)
      expect(await outbox.deliver(ref, first.id)).toEqual({ ok: false, code: 'busy' })
      expect(await outbox.deliver(ref, second.id)).toEqual({ ok: false, code: 'blocked' })
      expect(await outbox.deliver({ ...ref, profileId: profileIdSchema.parse('other-profile') }, first.id))
        .toEqual({ ok: false, code: 'not_found' })
      expect(await outbox.deliver(unrelated.ref, other.id)).toMatchObject({ ok: true, delivery: { status: 'accepted' } })
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      hold.resolve(response(request, { kind: 'accepted', receiptId: 'receipt-first' }))
      await inFlight
    }
    expect(outbox.isActive()).toBe(false)
    expect(store.hasUnsettledEffects(ref, verified.attempt.id)).toBe(false)
    expect(await outbox.deliver(ref, second.id)).toMatchObject({ ok: true, delivery: { status: 'accepted' } })
    expect(send.mock.calls.map(([request]) => request.deliveryId)).toEqual([first.id, other.id, second.id])
  })

  it('backs off only confirmed pre-send failures and enforces the retry budget', async () => {
    const f = fixture()
    const delivery = message('retry')
    const { ref } = await completeTask(f.store, 'retry', [delivery])
    const send = vi.fn(async (request: OutboxSendRequest) => response(request, { kind: 'not_sent', retryable: true }))
    const outbox = f.store.createOutbox(outboxOptions({ send }, { maxRetries: 2, retryDelayMs: 100, now: f.now }))
    expect(await outbox.deliver(ref, delivery.id)).toMatchObject({
      ok: true, delivery: { status: 'pending', retries: 1, nextAttemptAt: '2026-11-07T08:00:00.100Z' },
    })
    expect(await outbox.deliver(ref, delivery.id)).toEqual({ ok: false, code: 'not_due' })
    expect(send).toHaveBeenCalledTimes(1)
    f.advance(100)
    expect(await outbox.deliver(ref, delivery.id)).toMatchObject({
      ok: true, delivery: { status: 'pending', retries: 2, nextAttemptAt: '2026-11-07T08:00:00.300Z' },
    })
    f.advance(200)
    expect(await outbox.deliver(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'failed', retries: 2 } })
    expect(await outbox.deliver(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'failed' } })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('does not replay a committed claim after restart and only advances exact provider receipts', async () => {
    const f = fixture()
    const delivery = message('interrupted')
    const { ref } = await completeTask(f.store, 'interrupted', [delivery])
    f.reopen(db => db.exec(`
      CREATE TRIGGER fixture_interrupt_receipt BEFORE UPDATE ON outbox
      WHEN (NEW.record ->> '$.status') = 'accepted'
      BEGIN SELECT RAISE(ABORT, 'Fixture local receipt write failed'); END
    `))
    const send = vi.fn(async (request: OutboxSendRequest) =>
      response(request, { kind: 'accepted', receiptId: 'provider-receipt' }))
    const outbox = f.store.createOutbox(outboxOptions({ send }))
    await expect(outbox.deliver(ref, delivery.id)).rejects.toMatchObject({ code: 'conflict' })
    f.reopen(db => db.exec('DROP TRIGGER fixture_interrupt_receipt'))
    expect(f.store.getDelivery(ref, delivery.id)).toMatchObject({ status: 'dispatching' })

    let lookupStatus: 'accepted' | 'delivered' | 'read' = 'accepted'
    let lookupReceipt = 'provider-receipt'
    const lookup = vi.fn(async (query: OutboxLookupRequest) =>
      response(query, { kind: lookupStatus, receiptId: lookupReceipt }))
    const reopened = f.store.createOutbox(outboxOptions({ send, lookup }, { now: f.now }))
    expect(await reopened.deliver(ref, delivery.id)).toEqual({ ok: false, code: 'reconciliation_required' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(await reopened.reconcile(ref, delivery.id)).toMatchObject({
      ok: true, delivery: { status: 'accepted', receipt: { providerReceiptId: 'provider-receipt' } },
    })
    lookupStatus = 'delivered'
    lookupReceipt = 'other-receipt'
    expect(await reopened.refresh(ref, delivery.id)).toEqual({ ok: false, code: 'outcome_uncertain' })
    expect(f.store.getDelivery(ref, delivery.id)).toMatchObject({ status: 'accepted' })
    lookupReceipt = 'provider-receipt'
    expect(await reopened.refresh(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'delivered' } })
    lookupStatus = 'accepted'
    expect(await reopened.refresh(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'delivered' } })
    lookupStatus = 'read'
    expect(await reopened.refresh(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'read' } })
    expect(lookup.mock.calls[0]?.[0].receiptId).toBeUndefined()
    expect(lookup.mock.calls[1]?.[0].receiptId).toBe('provider-receipt')
  })

  it('treats absent lookup as uncertain and retries only definitive no-send on the original account', async () => {
    const f = fixture()
    const delivery = message('unknown')
    const following = message('after-unknown')
    const { ref } = await completeTask(f.store, 'unknown', [delivery, following])
    let selectedAccount = accountId
    let lookupMode: 'mismatch' | 'absent' | 'not_sent' = 'mismatch'
    let sendUnknown = true
    const send = vi.fn(async (request: OutboxSendRequest) => {
      if (sendUnknown) throw new Error('Unknown provider outcome')
      return response(request, { kind: 'accepted', receiptId: 'receipt-after-retry' })
    })
    const lookup = vi.fn(async (request: OutboxLookupRequest) => {
      if (lookupMode === 'absent') return response(request, { kind: 'absent' })
      const query = lookupMode === 'mismatch' ? { ...request, dedupeKey: 'wrong-dedupe' } : request
      return response(query, { kind: 'not_sent', retryable: true })
    })
    const options = outboxOptions({ send, lookup }, {
      now: f.now,
      resolveRoute: scope => ({ ...scope, id: 'fixture-route', accountId: selectedAccount, provider: { send, lookup } }),
    })
    const outbox = f.store.createOutbox(options)
    expect(await outbox.deliver(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'uncertain' } })
    expect(await outbox.deliver(ref, following.id)).toEqual({ ok: false, code: 'blocked' })
    selectedAccount = accountIdSchema.parse('different-account')
    expect(await outbox.reconcile(ref, delivery.id)).toEqual({ ok: false, code: 'permission_denied' })
    expect(lookup).not.toHaveBeenCalled()
    selectedAccount = accountId
    expect(await outbox.reconcile(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'uncertain' } })
    lookupMode = 'absent'
    expect(await outbox.reconcile(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'uncertain', retries: 0 } })
    expect(await outbox.deliver(ref, delivery.id)).toEqual({ ok: false, code: 'reconciliation_required' })
    expect(send).toHaveBeenCalledTimes(1)
    lookupMode = 'not_sent'
    expect(await outbox.reconcile(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'pending', retries: 1 } })
    f.advance(5_000)
    selectedAccount = accountIdSchema.parse('different-account')
    expect(await outbox.deliver(ref, delivery.id)).toEqual({ ok: false, code: 'permission_denied' })
    expect(send).toHaveBeenCalledTimes(1)
    selectedAccount = accountId
    sendUnknown = false
    expect(await outbox.deliver(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'accepted' } })
    expect(send.mock.calls.map(([request]) => request.dedupeKey)).toEqual([delivery.dedupeKey, delivery.dedupeKey])
  })

  it('denies an altered destination and paused or cancelled attempts before provider I/O', async () => {
    const { store } = fixture()
    const send = vi.fn(async (request: OutboxSendRequest) => response(request, { kind: 'accepted', receiptId: 'receipt' }))
    const outbox = store.createOutbox(outboxOptions({ send }))
    const changed = message('changed', { destination: { ...destination, externalDestinationId: 'other-thread' } })
    const altered = createTask(store, 'altered', [changed])
    expect(await outbox.deliver(altered.ref, changed.id)).toEqual({ ok: false, code: 'permission_denied' })
    const pending = message('fenced')
    const { ref, context, work } = createTask(store, 'fenced', [pending])
    const control = { taskId: ref.taskId, conversationId: conversation.id, payload: {} }
    const paused = state(store.applyCommand({
      ...control, type: 'work.pause', commandId: 'pause-fenced', expectedVersion: work.task.version,
    }, context))
    expect(await outbox.deliver(ref, pending.id)).toEqual({ ok: false, code: 'stale_attempt' })
    state(store.applyCommand({
      ...control, type: 'work.cancel', commandId: 'cancel-fenced', expectedVersion: paused.task.version,
    }, context))
    expect(await outbox.deliver(ref, pending.id)).toEqual({ ok: false, code: 'stale_attempt' })
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves a confirmed no-send retry parked when the current attempt is soft-paused', async () => {
    const f = fixture()
    const pending = message('pause-in-flight')
    const { ref, context, work } = createTask(f.store, 'pause-in-flight', [pending])
    const hold = Promise.withResolvers<unknown>()
    const entered = Promise.withResolvers<OutboxSendRequest>()
    const send = vi.fn((request: OutboxSendRequest) => {
      entered.resolve(request)
      return hold.promise
    })
    const outbox = f.store.createOutbox(outboxOptions({ send }, { now: f.now }))
    const inFlight = outbox.deliver(ref, pending.id)
    const request = await Promise.race([entered.promise, inFlight.then(() => { throw new Error('Provider was not invoked') })])
    try {
      const paused = state(f.store.applyCommand({
        type: 'work.pause',
        commandId: 'pause-in-flight',
        taskId: ref.taskId,
        conversationId: conversation.id,
        expectedVersion: work.task.version,
        payload: {},
      }, context))
      expect(paused.task.status).toBe('paused')
    } finally {
      hold.resolve(response(request, { kind: 'not_sent', retryable: true }))
    }
    expect(await inFlight).toMatchObject({ ok: true, delivery: { status: 'pending', retries: 1 } })
    f.advance(5_000)
    expect(await outbox.deliver(ref, pending.id)).toEqual({ ok: false, code: 'stale_attempt' })
    expect(send).toHaveBeenCalledOnce()
  })

  it('checks exact verified attachment bytes and requires explicit private disclosure', async () => {
    const { store } = fixture()
    const delivery = message('artifact', { payload: { text: 'Verified artifact.', artifactIds: [artifactId] } })
    const { ref } = await completeTask(store, 'artifact', [delivery], true)
    let privateAllowed = false
    const send = vi.fn(async (request: OutboxSendRequest) => {
      expect(request.attachments).toHaveLength(1)
      const attachment = request.attachments[0]
      expect(attachment).toMatchObject({ id: artifactId, mediaType: 'text/plain' })
      if (!attachment) throw new Error('Missing attachment')
      expect(new TextDecoder().decode(attachment.bytes)).toBe('Verified fixture attachment.')
      attachment.bytes[0] = 0
      return response(request, { kind: 'accepted', receiptId: 'receipt-artifact' })
    })
    const outbox = store.createOutbox(outboxOptions({ send }, {
      allowPrivateArtifacts: disclosure => privateAllowed && disclosure.artifacts[0]?.id === artifactId
        && disclosure.accountId === accountId && disclosure.delivery.destination.externalDestinationId === destination.externalDestinationId,
    }))
    expect(await outbox.deliver(ref, delivery.id)).toEqual({ ok: false, code: 'permission_denied' })
    expect(send).not.toHaveBeenCalled()
    privateAllowed = true
    expect(await outbox.deliver(ref, delivery.id)).toMatchObject({ ok: true, delivery: { status: 'accepted' } })
    expect(send).toHaveBeenCalledOnce()
    expect(new TextDecoder().decode(store.artifacts.read(ref, artifactId)?.bytes)).toBe('Verified fixture attachment.')
  })
})
