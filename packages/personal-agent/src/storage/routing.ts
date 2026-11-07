import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  generationSchema, projectIdSchema, sha256DigestSchema, sourceEventSchema, taskIdSchema, utcInstantSchema,
  versionSchema, type ProjectId, type SourceEvent, type UtcInstant,
} from '../domain/model.js'
import type { WorkEvent, WorkState } from '../domain/transitions.js'
import type { WorkerInputIntent } from '../runtime/input-journal.js'
import {
  routingAuthoritySchema, routingDeliverySchema, routingDispositionSchema, routingDispositionUpdateSchema,
  routingEventRefSchema, routingReceiptSchema, subscriptionInputSchema, subscriptionKeySchema, subscriptionSchema,
  workerHandbackSchema, workerRouteIntentSchema, type RoutingAuthority,
  type RoutingEventRef, type RoutingReceipt, type StoredRoutingEvent, type Subscription, type SubscriptionKey,
  type SubscriptionScope, type WorkerRouteIntent,
} from '../runtime/subscriptions.js'
import { StorageError } from './schema.js'
import type { StoredWorkResult, WorkRef } from './store.js'

type Scope = Pick<WorkRef, 'ownerId' | 'profileId'>
type MutationFailure = {
  ok: false
  code: 'invalid_input' | 'invalid_transition' | 'not_found' | 'permission_denied' | 'version_conflict' | 'capacity'
}
const MAX_RECORD_BYTES = 1024 * 1024
const MAX_SCOPE_SUBSCRIPTIONS = 64
const scanLimitSchema = z.int().min(1).max(128)
const receiptMetadataSchema = z.strictObject({ projectId: projectIdSchema, authority: routingAuthoritySchema })
const routingBodyIdentity = z.object({
  kind: z.enum(['event', 'candidate']),
  projectId: projectIdSchema,
  dataScope: z.array(z.string()).min(1).max(16),
  policyVersion: z.string(),
  accountVerifiedAt: utcInstantSchema,
  target: z.strictObject({ taskId: taskIdSchema, expectedVersion: versionSchema, generation: generationSchema }).optional(),
  waitReference: z.string().optional(),
})

const receiptSelect = `
  SELECT s.record AS event, r.event_id AS eventId, r.owner_id AS ownerId, r.profile_id AS profileId,
    r.project_id AS projectId, r.digest, r.policy_version AS policyVersion, r.account_verified_at AS verifiedAt,
    r.version, r.disposition, d.event_id AS deliveryId, d.task_id AS deliveryTaskId, d.attempt_id AS deliveryAttemptId,
    d.generation AS deliveryGeneration, d.cursor AS deliveryCursor, d.project_id AS deliveryProjectId,
    d.subscription_version AS subscriptionVersion, d.task_version AS taskVersion, d.handback_at AS handbackAt, i.status AS inputStatus
  FROM routing_receipts r JOIN source_events s ON s.id = r.event_id
  LEFT JOIN routing_deliveries d ON d.event_id = r.event_id
  LEFT JOIN worker_inputs i ON i.task_id = d.task_id AND i.attempt_id = d.attempt_id
    AND i.generation = d.generation AND i.cursor = d.cursor
`
const subscriptionColumns = `
  s.owner_id AS ownerId, s.profile_id AS profileId, s.source_instance_id AS sourceInstanceId, s.account_id AS accountId,
  s.thread_id AS threadId, s.task_id AS taskId, s.project_id AS projectId, s.mode, s.enabled, s.version,
  s.policy_version AS policyVersion, s.account_verified_at AS verifiedAt, s.updated_at AS updatedAt, s.expires_at AS expiresAt
`
const scopePredicate = `s.owner_id = ? AND s.profile_id = ? AND s.source_instance_id = ? AND s.account_id = ? AND s.thread_id = ?`

function corrupt(): never {
  throw new StorageError('corrupt', 'Stored event routing record failed validation')
}

function json(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_RECORD_BYTES) return corrupt()
  try {
    return JSON.parse(value)
  } catch {
    return corrupt()
  }
}

function sourceRecord(value: unknown): SourceEvent {
  const event = sourceEventSchema.safeParse(json(value))
  if (!event.success) return corrupt()
  return event.data
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.ownerId === b.ownerId && a.profileId === b.profileId
}

function sameRoutingAuthority(a: RoutingAuthority, b: RoutingAuthority): boolean {
  return a.policyVersion === b.policyVersion && a.verifiedAt === b.verifiedAt
}

function eventBody(event: SourceEvent, projectId: ProjectId, authority: RoutingAuthority) {
  const decoded = routingBodyIdentity.safeParse(event.body)
  return decoded.success && decoded.data.projectId === projectId && event.actor.accountId !== undefined
    && event.actor.deviceId === undefined && event.threadId !== undefined
    && decoded.data.policyVersion === authority.policyVersion && decoded.data.accountVerifiedAt === authority.verifiedAt
    ? decoded.data : undefined
}

function decodeReceipt(row: Record<string, unknown>): StoredRoutingEvent {
  const event = sourceRecord(row.event)
  const disposition = routingDispositionSchema.safeParse(json(row.disposition))
  if (!disposition.success) return corrupt()
  const delivery = row.deliveryId === null ? undefined : routingDeliverySchema.safeParse({
    taskId: row.deliveryTaskId, attemptId: row.deliveryAttemptId, generation: row.deliveryGeneration,
    cursor: row.deliveryCursor, mode: 'work', projectId: row.deliveryProjectId, taskVersion: row.taskVersion,
    subscriptionVersion: row.subscriptionVersion, handbackAt: row.handbackAt ?? undefined, inputStatus: row.inputStatus,
  })
  if (delivery && !delivery.success) return corrupt()
  const parsed = routingReceiptSchema.safeParse({
    eventId: row.eventId, projectId: row.projectId, digest: row.digest, version: row.version,
    authority: { policyVersion: row.policyVersion, verifiedAt: row.verifiedAt },
    disposition: disposition.data, delivery: delivery?.data,
  })
  if (!parsed.success) return corrupt()
  const receipt = parsed.data
  if (event.id !== receipt.eventId || event.ownerId !== row.ownerId || event.profileId !== row.profileId
    || !eventBody(event, receipt.projectId, receipt.authority)
    || (receipt.delivery && (row.deliveryId !== receipt.eventId || receipt.delivery.projectId !== receipt.projectId
      || (receipt.disposition.kind === 'routed') !== (receipt.delivery.handbackAt === undefined)))
    || (!receipt.delivery && (receipt.disposition.kind === 'routed' || receipt.disposition.kind === 'handback'))) {
    return corrupt()
  }
  return { event, receipt }
}

export function getRoutingEvent(db: DatabaseSync, ref: RoutingEventRef): StoredRoutingEvent | undefined {
  const row = db.prepare(`${receiptSelect} WHERE r.event_id = ? AND r.owner_id = ? AND r.profile_id = ?`)
    .get(ref.eventId, ref.ownerId, ref.profileId)
  return row && decodeReceipt(row)
}

export function listRoutingEvents(db: DatabaseSync, scope: Scope, limit = 64): StoredRoutingEvent[] {
  return db.prepare(`${receiptSelect} WHERE r.owner_id = ? AND r.profile_id = ?
    AND r.kind IN ('pending', 'queued', 'handback') ORDER BY r.rowid LIMIT ?`)
    .all(scope.ownerId, scope.profileId, scanLimitSchema.parse(limit)).map(decodeReceipt)
}

export function replayRoutingEvents(db: DatabaseSync, scope: Scope, key: {
  projectId: ProjectId; sourceInstanceId: string; accountId: string; threadId: string
}): StoredRoutingEvent[] {
  return db.prepare(`${receiptSelect} WHERE r.owner_id = ? AND r.profile_id = ? AND r.project_id = ?
    AND (s.record ->> '$.sourceInstanceId') = ? AND (s.record ->> '$.actor.accountId') = ?
    AND (s.record ->> '$.threadId') = ? ORDER BY r.rowid DESC LIMIT 100`)
    .all(scope.ownerId, scope.profileId, key.projectId, key.sourceInstanceId, key.accountId, key.threadId).map(decodeReceipt)
}

/** Caller holds a write transaction. A legacy source record never becomes a new event. */
export function recordRoutingEvent(db: DatabaseSync, input: SourceEvent, digest: string, metadata: unknown):
  | { ok: true; duplicate: boolean; receipt: RoutingReceipt }
  | { ok: false; code: 'invalid_input' | 'source_conflict' | 'source_duplicate' } {
  const decoded = sourceEventSchema.safeParse(input)
  const meta = receiptMetadataSchema.safeParse(metadata)
  if (!decoded.success || !meta.success || !sha256DigestSchema.safeParse(digest).success) {
    return { ok: false, code: 'invalid_input' }
  }
  const event = decoded.data
  const { projectId, authority } = meta.data
  if (event.occurredAt > event.receivedAt || !eventBody(event, projectId, authority)) {
    return { ok: false, code: 'invalid_input' }
  }
  const existing = db.prepare(`
    SELECT record FROM source_events WHERE source_instance_id = ? AND external_event_id = ? AND external_revision = ?
  `).get(event.sourceInstanceId, event.externalEventId, event.externalRevision)
  if (existing) {
    const prior = sourceRecord(existing.record)
    if (!sameScope(prior, event) || (prior.actor.accountId !== undefined && prior.actor.accountId !== event.actor.accountId)) {
      return { ok: false, code: 'source_conflict' }
    }
    const stored = getRoutingEvent(db, { ownerId: prior.ownerId, profileId: prior.profileId, eventId: prior.id })
    if (!stored) return { ok: false, code: 'source_duplicate' }
    if (stored.receipt.digest !== digest || stored.receipt.projectId !== projectId || prior.threadId !== event.threadId) {
      return { ok: false, code: 'source_conflict' }
    }
    return { ok: true, duplicate: true, receipt: stored.receipt }
  }
  const record = JSON.stringify(event)
  if (Buffer.byteLength(record) > MAX_RECORD_BYTES) return { ok: false, code: 'invalid_input' }
  if (db.prepare('SELECT 1 FROM source_events WHERE id = ?').get(event.id)) {
    return { ok: false, code: 'source_conflict' }
  }
  const receipt: RoutingReceipt = { eventId: event.id, projectId, digest, authority, version: 1, disposition: { kind: 'pending' } }
  db.prepare('INSERT INTO source_events (id, record) VALUES (?, ?)').run(event.id, record)
  db.prepare(`
    INSERT INTO routing_receipts
      (event_id, owner_id, profile_id, project_id, digest, policy_version, account_verified_at, version, disposition)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(event.id, event.ownerId, event.profileId, projectId, digest, authority.policyVersion,
    authority.verifiedAt, JSON.stringify(receipt.disposition))
  return { ok: true, duplicate: false, receipt }
}

function updateDisposition(db: DatabaseSync, ref: RoutingEventRef, version: number, disposition: RoutingReceipt['disposition']): boolean {
  if (!Number.isSafeInteger(version + 1)) return false
  return db.prepare(`
    UPDATE routing_receipts SET version = version + 1, disposition = ?
    WHERE event_id = ? AND owner_id = ? AND profile_id = ? AND version = ?
  `).run(JSON.stringify(disposition), ref.eventId, ref.ownerId, ref.profileId, version).changes === 1
}

function taskInProject(db: DatabaseSync, scope: Scope, taskId: WorkRef['taskId'], projectId: ProjectId): boolean {
  return db.prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ? AND profile_id = ? AND project_id = ?')
    .get(taskId, scope.ownerId, scope.profileId, projectId) !== undefined
}

export function setRoutingDisposition(db: DatabaseSync, ref: RoutingEventRef, expectedVersion: number, raw: unknown):
  | { ok: true; receipt: RoutingReceipt }
  | MutationFailure {
  const decoded = routingDispositionUpdateSchema.safeParse(raw)
  if (!decoded.success || !routingEventRefSchema.safeParse(ref).success || !versionSchema.safeParse(expectedVersion).success) {
    return { ok: false, code: 'invalid_input' }
  }
  const stored = getRoutingEvent(db, ref)
  if (!stored) return { ok: false, code: 'not_found' }
  const { receipt } = stored
  if (receipt.version !== expectedVersion) return { ok: false, code: 'version_conflict' }
  const current = receipt.disposition.kind
  const disposition = decoded.data
  if ((current !== 'pending' && current !== 'queued' && current !== 'handback')
    || (current === 'queued' && disposition.kind === 'queued')) return { ok: false, code: 'invalid_transition' }
  if (disposition.kind === 'context' && disposition.taskIds?.some(id => !taskInProject(db, ref, id, receipt.projectId))) {
    return { ok: false, code: 'permission_denied' }
  }
  if (!updateDisposition(db, ref, expectedVersion, disposition)) return { ok: false, code: 'version_conflict' }
  return { ok: true, receipt: { ...receipt, version: expectedVersion + 1, disposition } }
}

export function cancelUnfinishedRouting(db: DatabaseSync, scope?: Scope, limit = 128): number {
  const filter = scope === undefined ? '' : 'AND owner_id = ? AND profile_id = ?'
  const args = scope === undefined ? [] : [scope.ownerId, scope.profileId]
  return Number(db.prepare(`
    UPDATE routing_receipts SET version = version + 1, disposition = ?
    WHERE event_id IN (
      SELECT event_id FROM routing_receipts WHERE kind IN ('pending', 'queued', 'handback') ${filter} ORDER BY rowid LIMIT ?
    )
  `).run(JSON.stringify({ kind: 'rejected', reason: 'interrupted' }), ...args, scanLimitSchema.parse(limit)).changes)
}

function scopeArgs(scope: SubscriptionScope) {
  return [scope.ownerId, scope.profileId, scope.sourceInstanceId, scope.accountId, scope.threadId] as const
}

function decodeSubscription(row: Record<string, unknown>): Subscription {
  const { policyVersion, verifiedAt, expiresAt, enabled, ...columns } = row
  if (enabled !== 0 && enabled !== 1) return corrupt()
  const decoded = subscriptionSchema.safeParse({
    ...columns, authority: { policyVersion, verifiedAt }, enabled: enabled === 1, expiresAt: expiresAt ?? undefined,
  })
  if (!decoded.success) return corrupt()
  return decoded.data
}

function findSubscription(db: DatabaseSync, key: SubscriptionKey): Subscription | undefined {
  const row = db.prepare(`SELECT ${subscriptionColumns} FROM routing_subscriptions s WHERE ${scopePredicate} AND s.task_id = ?`)
    .get(...scopeArgs(key), key.taskId)
  return row && decodeSubscription(row)
}

export function getSubscription(db: DatabaseSync, key: SubscriptionKey): Subscription | undefined {
  const subscription = findSubscription(db, key)
  return subscription && taskInProject(db, key, key.taskId, subscription.projectId) ? subscription : undefined
}

export function listSubscriptions(db: DatabaseSync, scope: SubscriptionScope, projectId: ProjectId, at: UtcInstant): Subscription[] {
  const rows = db.prepare(`
    SELECT ${subscriptionColumns} FROM routing_subscriptions s JOIN tasks t ON t.id = s.task_id
      AND t.owner_id = s.owner_id AND t.profile_id = s.profile_id AND t.project_id = s.project_id
    WHERE ${scopePredicate} AND s.project_id = ? AND s.enabled = 1 AND s.updated_at <= ?
      AND (s.expires_at IS NULL OR s.expires_at > ?) ORDER BY s.task_id LIMIT ?
  `).all(...scopeArgs(scope), projectId, at, at, MAX_SCOPE_SUBSCRIPTIONS + 1)
  if (rows.length > MAX_SCOPE_SUBSCRIPTIONS) return corrupt()
  return rows.map(decodeSubscription)
}

export function putSubscription(db: DatabaseSync, input: unknown, expectedVersion?: number):
  | { ok: true; subscription: Subscription }
  | MutationFailure {
  const decoded = subscriptionInputSchema.safeParse(input)
  if (!decoded.success || (expectedVersion !== undefined && !versionSchema.safeParse(expectedVersion).success)) {
    return { ok: false, code: 'invalid_input' }
  }
  const subscription = decoded.data
  if (!taskInProject(db, subscription, subscription.taskId, subscription.projectId)) return { ok: false, code: 'not_found' }
  const existing = findSubscription(db, subscription)
  if (existing?.version !== expectedVersion) return { ok: false, code: 'version_conflict' }
  const version = (existing?.version ?? 0) + 1
  if (!Number.isSafeInteger(version) || (existing && subscription.updatedAt < existing.updatedAt)) {
    return { ok: false, code: 'invalid_input' }
  }
  if (subscription.enabled && !existing?.enabled) {
    const active = db.prepare(`SELECT COUNT(*) AS count FROM routing_subscriptions s WHERE ${scopePredicate} AND s.enabled = 1`)
      .get(...scopeArgs(subscription))?.count
    if (typeof active !== 'number' || active >= MAX_SCOPE_SUBSCRIPTIONS) return { ok: false, code: 'capacity' }
  }
  const { projectId, mode, enabled, authority, updatedAt, expiresAt } = subscription
  if (existing) {
    const update = db.prepare(`
      UPDATE routing_subscriptions AS s
      SET project_id = ?, mode = ?, enabled = ?, version = ?, policy_version = ?, account_verified_at = ?, updated_at = ?, expires_at = ?
      WHERE ${scopePredicate} AND s.task_id = ? AND s.version = ?
    `).run(projectId, mode, Number(enabled), version, authority.policyVersion, authority.verifiedAt, updatedAt,
      expiresAt ?? null, ...scopeArgs(subscription), subscription.taskId, existing.version)
    if (update.changes !== 1) return { ok: false, code: 'version_conflict' }
  } else {
    db.prepare(`
      INSERT INTO routing_subscriptions
        (owner_id, profile_id, source_instance_id, account_id, thread_id, task_id, project_id, mode,
         enabled, version, policy_version, account_verified_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...scopeArgs(subscription), subscription.taskId, projectId, mode, Number(enabled), version,
      authority.policyVersion, authority.verifiedAt, updatedAt, expiresAt ?? null)
  }
  return { ok: true, subscription: { ...subscription, version } }
}

interface RoutingClaim {
  readonly ref: RoutingEventRef
  readonly intent: WorkerRouteIntent
}

/** Validate a current receipt and subscription in the same transaction as the Worker journal. */
export function checkWorkerRoute(
  db: DatabaseSync,
  before: WorkState,
  event: WorkEvent,
  raw: unknown,
): { ok: true; claim: RoutingClaim } | Extract<StoredWorkResult, { ok: false }> {
  const decoded = workerRouteIntentSchema.safeParse(raw)
  if (!decoded.success) return { ok: false, code: 'invalid_input' }
  const intent = decoded.data
  const { task, attempt } = before
  const ref = { ownerId: task.ownerId, profileId: task.profileId, eventId: intent.eventId }
  const stored = getRoutingEvent(db, ref)
  if (!stored) return { ok: false, code: 'not_found' }
  const { receipt, event: source } = stored
  if (receipt.version !== intent.expectedReceiptVersion) return { ok: false, code: 'version_conflict' }
  if (receipt.disposition.kind !== 'pending' || receipt.delivery) return { ok: false, code: 'invalid_transition' }
  const body = eventBody(source, receipt.projectId, receipt.authority)
  const freshnessFloor = event.type === 'record_input' ? attempt.startedAt ?? task.updatedAt : task.updatedAt
  if (!body || intent.mode !== 'work' || intent.projectId !== task.projectId
    || receipt.projectId !== task.projectId || source.receivedAt > event.at || source.occurredAt < freshnessFloor
    || !sameRoutingAuthority(intent.authority, receipt.authority)
    || attempt.mandate.policyVersion !== intent.authority.policyVersion
    || !body.dataScope.every(label => attempt.scope?.dataScope.includes(label))
    || (body.target && (body.target.taskId !== task.id || body.target.expectedVersion !== task.version
      || body.target.generation !== task.generation))) return { ok: false, code: 'permission_denied' }
  if (event.type === 'wake_worker'
    ? body.kind !== 'event' || body.waitReference === undefined || body.waitReference !== task.wait?.referenceId
    : body.waitReference !== undefined) {
    return { ok: false, code: 'permission_denied' }
  }
  if (event.type !== 'record_input' && event.type !== 'wake_worker') return { ok: false, code: 'invalid_transition' }
  if (!db.prepare(`
    SELECT 1 FROM projects WHERE id = ? AND owner_id = ? AND profile_id = ? AND (record ->> '$.status') = 'active'
  `).get(task.projectId, task.ownerId, task.profileId)) return { ok: false, code: 'permission_denied' }
  const key = subscriptionKeySchema.parse({
    ownerId: task.ownerId, profileId: task.profileId,
    taskId: task.id, sourceInstanceId: source.sourceInstanceId, accountId: source.actor.accountId, threadId: source.threadId,
  })
  const subscription = findSubscription(db, key)
  if (!subscription || !subscription.enabled || subscription.mode !== 'work' || subscription.projectId !== task.projectId
    || subscription.version !== intent.subscriptionVersion || !sameRoutingAuthority(subscription.authority, intent.authority)
    || source.occurredAt < subscription.updatedAt || (subscription.expiresAt !== undefined && event.at >= subscription.expiresAt)) {
    return { ok: false, code: 'permission_denied' }
  }
  return { ok: true, claim: { ref, intent } }
}

export function commitWorkerRoute(
  db: DatabaseSync,
  claim: RoutingClaim,
  state: WorkState,
  input: WorkerInputIntent,
): void {
  const { ref, intent } = claim
  db.prepare(`
    INSERT INTO routing_deliveries
      (event_id, task_id, attempt_id, generation, cursor, project_id, subscription_version, task_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ref.eventId, input.taskId, input.attemptId, input.generation, input.cursor,
    state.task.projectId, intent.subscriptionVersion, state.task.version)
  if (!updateDisposition(db, ref, intent.expectedReceiptVersion, { kind: 'routed' })) {
    throw new StorageError('version_conflict', 'Routing receipt changed before Worker delivery')
  }
}

export function applyWorkerHandback(db: DatabaseSync, ref: WorkRef, state: WorkState, input: unknown): boolean {
  const decoded = workerHandbackSchema.safeParse(input)
  if (!decoded.success) return false
  const { eventId, attemptId, generation, cursor, expectedVersion, summary } = decoded.data
  const { task, attempt } = state
  if (task.status !== 'running' || task.version !== expectedVersion || task.generation !== generation
    || attempt.id !== attemptId || attempt.generation !== generation || attempt.worker?.inputCursor !== cursor) return false
  const eventRef = { ownerId: ref.ownerId, profileId: ref.profileId, eventId }
  const receipt = getRoutingEvent(db, eventRef)?.receipt
  const delivery = receipt?.delivery
  if (!receipt || receipt.disposition.kind !== 'routed' || !delivery
    || delivery.taskId !== task.id || delivery.projectId !== task.projectId || delivery.attemptId !== attemptId
    || delivery.generation !== generation || delivery.cursor !== cursor || delivery.taskVersion !== expectedVersion) return false
  const journal = db.prepare(`
    SELECT 1 FROM worker_inputs WHERE task_id = ? AND attempt_id = ? AND generation = ? AND cursor = ?
      AND status IN ('flushed', 'admitted')
  `).get(task.id, attemptId, generation, cursor)
  if (!journal) return false
  const at = utcInstantSchema.parse(new Date().toISOString())
  const updated = db.prepare('UPDATE routing_deliveries SET handback_at = ? WHERE event_id = ? AND handback_at IS NULL')
    .run(at, eventId)
  if (updated.changes !== 1) return false
  if (!updateDisposition(db, eventRef, receipt.version, { kind: 'handback', ...(summary === undefined ? {} : { summary }) })) {
    throw new StorageError('version_conflict', 'Routing receipt changed before handback')
  }
  return true
}
