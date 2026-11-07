import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  attemptIdSchema, conversationSchema, deliveryDestinationSchema, deliveryIdSchema, deliverySchema, generationSchema,
  nonEmptyTextSchema, ownerIdSchema, profileIdSchema, sourceInstanceIdSchema, taskIdSchema, taskStatusSchema,
  timeZoneSchema, utcInstantSchema, versionSchema, type Delivery, type DeliveryId, type OwnerId, type ProfileId, type UtcInstant,
} from '../domain/model.js'
import { dispatchPermitted, recoveryMode } from '../storage/recovery-state.js'
import { StorageError, transaction } from '../storage/schema.js'
import type { WorkRef } from '../storage/store.js'
import type { OutboxResult } from './outbox.js'

type DatabaseAccess = <T>(operation: (db: DatabaseSync) => T) => T
type Scope = Readonly<{ ownerId: OwnerId; profileId: ProfileId }>
const scopeSchema = z.object({ ownerId: ownerIdSchema, profileId: profileIdSchema })
const categorySchema = z.enum(['progress', 'result', 'blocker', 'approval', 'query', 'reminder', 'proactive'])
const unsolicited = new Set(['result', 'blocker', 'proactive'])
const MAX_UNSOLICITED = 3
const DAY_LOOKUP_MS = 48 * 60 * 60 * 1_000
const clockText = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
const sourceInstance = sourceInstanceIdSchema.max(512)
const sourceSchema = z.strictObject({
  sourceInstanceId: sourceInstance,
  externalEventId: nonEmptyTextSchema.max(512),
  externalRevision: nonEmptyTextSchema.max(512),
})

export const attentionPolicySchema = z.strictObject({
  mode: z.enum(['off', 'observe', 'prepare', 'act']),
  timeZone: timeZoneSchema,
  quietHours: z.strictObject({ start: clockText, end: clockText }).refine(range => range.start !== range.end).nullable(),
  urgentRules: z.array(z.strictObject({ category: z.enum(['result', 'blocker', 'approval', 'proactive']), sourceInstanceId: sourceInstance }))
    .max(64).refine(rules => new Set(rules.map(rule => JSON.stringify([rule.category, rule.sourceInstanceId]))).size === rules.length),
})
const policySchema = attentionPolicySchema.extend({ version: versionSchema })
export type AttentionPolicy = z.infer<typeof policySchema>
const defaultPolicy: AttentionPolicy = {
  version: 0, mode: 'off', timeZone: 'UTC', quietHours: { start: '22:00', end: '08:00' }, urgentRules: [],
}

const candidateFields = {
  attemptId: attemptIdSchema,
  generation: generationSchema,
  expectedVersion: versionSchema,
  category: categorySchema,
  source: sourceSchema,
  urgent: z.boolean().default(false),
}
const candidateSchema = z.strictObject({
  ...candidateFields,
  summary: nonEmptyTextSchema.max(2_048).optional(),
  deliveryId: deliveryIdSchema.optional(),
}).refine(candidate => candidate.category === 'progress'
  ? candidate.summary !== undefined && candidate.deliveryId === undefined && !candidate.urgent
  : candidate.summary === undefined)

const dispositionSchema = z.enum(['workspace', 'suppressed', 'reserved'])
const reasonSchema = z.enum([
  'coalesced_progress', 'mode_off', 'observe_only', 'prepare_only', 'workspace_only', 'delivery_unavailable',
  'already_reserved', 'external_not_authorized', 'quiet_hours', 'daily_limit', 'recovery_required',
  'explicit_reminder', 'required_approval', 'query_response', 'urgent_exception', 'outcome', 'blocker', 'proactive_act',
])
const reservationReason = {
  result: 'outcome', blocker: 'blocker', approval: 'required_approval', query: 'query_response',
  reminder: 'explicit_reminder', proactive: 'proactive_act',
} as const
const decisionId = z.string().regex(/^attention-[a-f0-9]{64}$/u)
const decisionSchema = z.strictObject({
  id: decisionId,
  taskId: taskIdSchema,
  ...candidateFields,
  action: dispositionSchema,
  reason: reasonSchema,
  policyVersion: versionSchema,
  at: utcInstantSchema,
  deliveryId: deliveryIdSchema.optional(),
  destination: deliveryDestinationSchema.optional(),
})
const claimReasonSchema = z.enum(['stale_attempt', 'version_conflict', 'policy_changed', 'reservation_expired', 'quiet_hours',
  'delivery_unavailable', 'external_not_authorized', 'recovery_required'])

type Candidate = z.infer<typeof candidateSchema>
type Decision = z.infer<typeof decisionSchema>
type ClaimReason = z.infer<typeof claimReasonSchema>
export type AttentionDecision = Decision & { readonly claimedAt?: UtcInstant; readonly claimReason?: ClaimReason }

export interface AttentionExternalRequest {
  readonly ref: WorkRef
  readonly phase: 'reserve' | 'claim'
  readonly candidateId: string
  readonly candidate: Readonly<Pick<Candidate, 'attemptId' | 'generation' | 'expectedVersion' | 'category' | 'source' | 'urgent'>>
  readonly delivery: Readonly<Pick<Delivery, 'id' | 'destination'>>
  readonly policyVersion: number
  readonly at: UtcInstant
}

export interface AttentionOptions {
  readonly now?: () => UtcInstant
  /** Verify current notification intent, source, and exact route. No I/O or writes. */
  readonly allowExternal?: (request: AttentionExternalRequest) => boolean
}

type AttentionHandoff = (ref: WorkRef, id: DeliveryId) => Promise<OutboxResult>

type FailureCode = ClaimReason | 'invalid_input' | 'not_found' | 'candidate_conflict' | 'not_reserved' | 'already_claimed'
type Failure = { ok: false; code: FailureCode }
const fail = (code: FailureCode): Failure => ({ ok: false, code })
const workspace = (reason: Decision['reason']) => ({ action: 'workspace' as const, reason })
const suppress = (reason: Decision['reason']) => ({ action: 'suppressed' as const, reason })

function corrupt(): never {
  throw new StorageError('corrupt', 'Stored attention state failed validation')
}

function json(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 1024 * 1024 || Buffer.byteLength(value) > 1024 * 1024) return corrupt()
  try {
    return JSON.parse(value)
  } catch {
    return corrupt()
  }
}

function policyFor(db: DatabaseSync, scope: Scope): AttentionPolicy {
  const row = db.prepare(`
    SELECT version, record FROM attention_policies WHERE owner_id = ? AND profile_id = ? ORDER BY version DESC LIMIT 1
  `).get(scope.ownerId, scope.profileId)
  if (!row) return structuredClone(defaultPolicy)
  const parsed = policySchema.safeParse(json(row.record))
  if (!parsed.success || parsed.data.version !== row.version) return corrupt()
  return parsed.data
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

function clock(at: UtcInstant, format: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map(({ type, value }) => [type, value]))
  return { day: `${parts.year?.padStart(4, '0')}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) }
}

function quiet(policy: AttentionPolicy, at: UtcInstant): boolean {
  if (!policy.quietHours) return false
  const minute = clock(at, formatter(policy.timeZone)).minute
  const offset = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  const start = offset(policy.quietHours.start)
  const end = offset(policy.quietHours.end)
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

function dayRange(at: UtcInstant, timeZone: string) {
  const epoch = Date.parse(at)
  const { day } = clock(at, formatter(timeZone))
  return { day, timeZone,
    start: new Date(Math.max(epoch - DAY_LOOKUP_MS, Date.parse('0000-01-01T00:00:00.000Z'))).toISOString(),
    end: new Date(Math.min(epoch + DAY_LOOKUP_MS, Date.parse('9999-12-31T23:59:59.999Z'))).toISOString(),
  }
}

function installDayLookup(db: DatabaseSync): void {
  let cached: { zone: string; format: Intl.DateTimeFormat } | undefined
  // The indexed UTC range bounds the scan. The exact IANA date filter also
  // handles midnight transitions where a local date can stop and recur.
  db.function('dshpa_attention_local_day', { deterministic: true, directOnly: true }, (instant, zone) => {
    const at = utcInstantSchema.safeParse(instant)
    if (!at.success || typeof zone !== 'string') return corrupt()
    if (cached?.zone !== zone) cached = { zone, format: formatter(zone) }
    return clock(at.data, cached.format).day
  })
}

function usage(db: DatabaseSync, ownerId: OwnerId, range: ReturnType<typeof dayRange>): number {
  const count = db.prepare(`
    SELECT COUNT(*) AS count FROM attention_decisions
    WHERE owner_id = ? AND category IN ('result', 'blocker', 'proactive') AND reserved_at BETWEEN ? AND ?
      AND dshpa_attention_local_day(reserved_at, ?) = ?
  `).get(ownerId, range.start, range.end, range.timeZone, range.day)?.count
  return typeof count === 'number' ? count : corrupt()
}

function taskFence(db: DatabaseSync, ref: WorkRef, candidate: Pick<Candidate, 'attemptId' | 'generation' | 'expectedVersion' | 'category'>) {
  const row = db.prepare(`
    SELECT t.version, t.generation, t.attempt_id, a.generation AS attempt_generation, (t.record ->> '$.status') AS status
    FROM tasks t JOIN attempts a ON a.task_id = t.id AND a.id = t.attempt_id
    WHERE t.id = ? AND t.owner_id = ? AND t.profile_id = ?
  `).get(ref.taskId, ref.ownerId, ref.profileId)
  if (!row) return fail('not_found')
  if (row.attempt_id !== candidate.attemptId || row.generation !== candidate.generation
    || row.attempt_generation !== candidate.generation) return fail('stale_attempt')
  if (row.version !== candidate.expectedVersion) return fail('version_conflict')
  const parsed = taskStatusSchema.safeParse(row.status)
  if (!parsed.success) return corrupt()
  const status = parsed.data
  if (candidate.category === 'result' && status !== 'completed') return fail('stale_attempt')
  if (candidate.category === 'blocker' && status !== 'blocked' && status !== 'failed'
    && status !== 'reconciliation_required' && !status.startsWith('waiting_')) return fail('stale_attempt')
  if ((candidate.category === 'progress' || candidate.category === 'proactive')
    && ['completed', 'cancelled', 'failed', 'cancelling', 'reconciliation_required'].includes(status)) return fail('stale_attempt')
  return { ok: true } as const
}

function exactDelivery(db: DatabaseSync, ref: WorkRef, candidate: Pick<Candidate, 'deliveryId' | 'attemptId' | 'generation'>) {
  if (!candidate.deliveryId) return undefined
  const row = db.prepare(`
    SELECT o.record AS delivery, c.record AS conversation
    FROM outbox o JOIN tasks t ON t.id = o.task_id
    JOIN conversations c ON c.id = t.conversation_id AND c.owner_id = t.owner_id AND c.profile_id = t.profile_id
    WHERE o.id = ? AND o.task_id = ? AND o.owner_id = ? AND o.profile_id = ? AND o.attempt_id = ? AND o.generation = ?
  `).get(candidate.deliveryId, ref.taskId, ref.ownerId, ref.profileId, candidate.attemptId, candidate.generation)
  if (!row) return undefined
  const delivery = deliverySchema.safeParse(json(row.delivery))
  const conversation = conversationSchema.safeParse(json(row.conversation))
  if (!delivery.success || !conversation.success || delivery.data.id !== candidate.deliveryId
    || delivery.data.ownerId !== ref.ownerId || delivery.data.profileId !== ref.profileId) return corrupt()
  const { originalDestination } = conversation.data
  const { destination, id, status } = delivery.data
  if (status !== 'pending' || !sameDestination(destination, originalDestination)) return undefined
  return { id, destination }
}

function sameDestination(left: Delivery['destination'], right: Delivery['destination'] | undefined): boolean {
  return left.sourceInstanceId === right?.sourceInstanceId && left.externalDestinationId === right.externalDestinationId
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function decodeDecision(row: Record<string, unknown>): AttentionDecision {
  const parsed = decisionSchema.safeParse(json(row.record))
  const claimed = utcInstantSchema.optional().safeParse(row.claimed_at ?? undefined)
  const reason = claimReasonSchema.optional().safeParse(row.claim_reason ?? undefined)
  if (!parsed.success || !claimed.success || !reason.success || parsed.data.id !== row.id
    || (parsed.data.action === 'reserved'
      ? parsed.data.deliveryId !== row.delivery_id || parsed.data.destination === undefined || parsed.data.at !== row.reserved_at
      : row.reserved_at !== null || claimed.data !== undefined)) return corrupt()
  return { ...parsed.data, ...(claimed.data === undefined ? {} : { claimedAt: claimed.data }),
    ...(reason.data === undefined ? {} : { claimReason: reason.data }) }
}

function urgentAllowed(policy: AttentionPolicy, candidate: Pick<Candidate, 'urgent' | 'category' | 'source'>): boolean {
  return candidate.urgent && policy.urgentRules.some(rule =>
    rule.category === candidate.category && rule.sourceInstanceId === candidate.source.sourceInstanceId)
}

function bypassQuiet(policy: AttentionPolicy, candidate: Pick<Candidate, 'urgent' | 'category' | 'source'>): boolean {
  return candidate.category === 'reminder' || candidate.category === 'query' || urgentAllowed(policy, candidate)
}

/** Same-writer attention policy. Reserving or claiming never grants permission to send. */
export function createAttention(
  access: DatabaseAccess,
  options: AttentionOptions = {},
  resolveHandoff?: () => AttentionHandoff | undefined,
) {
  access(installDayLookup)
  const now = () => utcInstantSchema.parse(options.now?.() ?? new Date().toISOString())
  const allowExternal = options.allowExternal

  function permitted(request: AttentionExternalRequest): boolean {
    try {
      return allowExternal?.(structuredClone(request)) === true
    } catch {
      return false
    }
  }

  function configure(scope: Scope, input: unknown, expectedVersion: number) {
    const parsed = attentionPolicySchema.safeParse(input)
    if (!parsed.success || !scopeSchema.safeParse(scope).success || !versionSchema.safeParse(expectedVersion).success) return fail('invalid_input')
    return access(db => transaction(db, () => {
      if (recoveryMode(db) === 'restore') return fail('recovery_required')
      const current = policyFor(db, scope)
      if (current.version !== expectedVersion) return fail('version_conflict')
      const version = current.version + 1
      if (!Number.isSafeInteger(version)) return fail('invalid_input')
      const policy = { ...parsed.data, version }
      db.prepare('INSERT INTO attention_policies (owner_id, profile_id, version, record) VALUES (?, ?, ?, ?)')
        .run(scope.ownerId, scope.profileId, version, JSON.stringify(policy))
      return { ok: true as const, policy }
    }))
  }

  function consider(ref: WorkRef, input: unknown) {
    const parsed = candidateSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_input')
    const candidate = parsed.data
    const { sourceInstanceId, externalEventId, externalRevision } = candidate.source
    const id = `attention-${hash([ref.ownerId, ref.profileId, sourceInstanceId, externalEventId, externalRevision, candidate.category])}`
    const fingerprint = hash([ref.taskId, candidate])
    return access(db => transaction(db, () => {
      const existing = db.prepare(`
        SELECT id, digest, record, delivery_id, reserved_at, claimed_at, claim_reason FROM attention_decisions
        WHERE id = ? AND owner_id = ? AND profile_id = ?
      `).get(id, ref.ownerId, ref.profileId)
      if (existing) {
        const decision = decodeDecision(existing)
        return existing.digest === fingerprint && decision.taskId === ref.taskId
          ? { ok: true as const, decision, duplicate: true } : fail('candidate_conflict')
      }
      const current = taskFence(db, ref, candidate)
      if (!current.ok) return current
      const at = now()
      const policy = policyFor(db, ref)
      const delivery = exactDelivery(db, ref, candidate)
      const { summary, deliveryId: requestedDeliveryId, ...metadata } = candidate

      function evaluate(): Pick<Decision, 'action' | 'reason'> {
        if (candidate.category === 'progress') return workspace('coalesced_progress')
        if (candidate.category === 'proactive') {
          if (policy.mode === 'off') return suppress('mode_off')
          if (policy.mode === 'observe') return suppress('observe_only')
          if (policy.mode === 'prepare') return workspace('prepare_only')
        }
        if (candidate.deliveryId === undefined) return workspace('workspace_only')
        if (!delivery) return suppress('delivery_unavailable')
        if (!dispatchPermitted(db)) return suppress('recovery_required')
        if (db.prepare('SELECT 1 FROM attention_decisions WHERE delivery_id = ? AND reserved_at IS NOT NULL').get(delivery.id)) {
          return suppress('already_reserved')
        }
        if (!permitted({ ref, phase: 'reserve', candidateId: id, candidate: metadata, delivery, policyVersion: policy.version, at })) {
          return suppress('external_not_authorized')
        }
        if (!bypassQuiet(policy, candidate) && quiet(policy, at)) return suppress('quiet_hours')
        if (unsolicited.has(candidate.category) && usage(db, ref.ownerId, dayRange(at, policy.timeZone)) >= MAX_UNSOLICITED) return suppress('daily_limit')
        const reason = urgentAllowed(policy, candidate) ? 'urgent_exception' : reservationReason[candidate.category]
        return { action: 'reserved', reason }
      }

      const verdict = evaluate()
      const decision = decisionSchema.parse({ id, taskId: ref.taskId, ...metadata, ...verdict, at, policyVersion: policy.version,
        ...(requestedDeliveryId === undefined ? {} : { deliveryId: requestedDeliveryId }),
        ...(verdict.action === 'reserved' ? { destination: delivery?.destination } : {}) })
      db.prepare(`
        INSERT INTO attention_decisions (id, owner_id, profile_id, task_id, attempt_id, generation,
          source_instance_id, external_event_id, external_revision, category, digest, record, delivery_id, reserved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, ref.ownerId, ref.profileId, ref.taskId, candidate.attemptId, candidate.generation,
        sourceInstanceId, externalEventId, externalRevision, candidate.category, fingerprint, JSON.stringify(decision),
        delivery?.id ?? null, verdict.action === 'reserved' ? at : null)
      if (summary !== undefined) {
        db.prepare(`
          INSERT INTO attention_progress (task_id, owner_id, profile_id, decision_id, summary, updated_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET decision_id = excluded.decision_id,
            summary = excluded.summary, updated_at = excluded.updated_at
        `).run(ref.taskId, ref.ownerId, ref.profileId, id, summary, at)
      }
      return { ok: true as const, decision, duplicate: false }
    }))
  }

  function claim(ref: WorkRef, rawId: unknown) {
    const parsed = decisionId.safeParse(rawId)
    if (!parsed.success) return fail('invalid_input')
    return access(db => transaction(db, () => {
      const row = db.prepare(`
        SELECT id, record, delivery_id, reserved_at, claimed_at, claim_reason FROM attention_decisions
        WHERE id = ? AND task_id = ? AND owner_id = ? AND profile_id = ?
      `).get(parsed.data, ref.taskId, ref.ownerId, ref.profileId)
      if (!row) return fail('not_found')
      const decision = decodeDecision(row)
      if (decision.action !== 'reserved') return fail('not_reserved')
      if (decision.claimedAt !== undefined) return fail('already_claimed')
      const policy = policyFor(db, ref)
      const at = now()
      const { attemptId, generation, expectedVersion, category, source, urgent, destination } = decision
      const candidate = { attemptId, generation, expectedVersion, category, source, urgent }
      const delivery = exactDelivery(db, ref, decision)
      const current = taskFence(db, ref, candidate)

      function rejectClaim(code: ClaimReason): Failure {
        db.prepare('UPDATE attention_decisions SET claim_reason = ? WHERE id = ? AND claimed_at IS NULL').run(code, decision.id)
        return fail(code)
      }

      if (!dispatchPermitted(db)) return rejectClaim('recovery_required')
      if (policy.version !== decision.policyVersion || (category === 'proactive' && policy.mode !== 'act')) {
        return rejectClaim('policy_changed')
      }
      if (!current.ok) return rejectClaim(current.code === 'version_conflict' ? current.code : 'stale_attempt')
      const format = formatter(policy.timeZone)
      if (at < decision.at || (unsolicited.has(category) && clock(at, format).day !== clock(decision.at, format).day)) {
        return rejectClaim('reservation_expired')
      }
      if (!delivery || !sameDestination(delivery.destination, destination)) return rejectClaim('delivery_unavailable')
      if (!bypassQuiet(policy, decision) && quiet(policy, at)) return rejectClaim('quiet_hours')
      if (!permitted({ ref, phase: 'claim', candidateId: decision.id, candidate, delivery, policyVersion: policy.version, at })) {
        return rejectClaim('external_not_authorized')
      }
      const written = db.prepare(`
        UPDATE attention_decisions SET claimed_at = ?, claim_reason = NULL WHERE id = ? AND claimed_at IS NULL
      `).run(at, decision.id)
      return written.changes === 1 ? { ok: true as const, deliveryId: delivery.id, destination: delivery.destination }
        : fail('already_claimed')
    }))
  }

  async function deliver(ref: WorkRef, rawId: unknown): Promise<OutboxResult | Failure> {
    const handoff = resolveHandoff?.()
    if (!handoff) return fail('delivery_unavailable')
    const reservation = claim(ref, rawId)
    if (!reservation.ok) return reservation
    // Invoke in the same turn as the attention claim. PA-007 still owns its
    // independent route, disclosure, ordering, and durable provider claim.
    return handoff(ref, reservation.deliveryId)
  }

  function snapshot(scope: Scope) {
    return access(db => {
      const policy = policyFor(db, scope)
      const range = dayRange(now(), policy.timeZone)
      const decisions = db.prepare(`
        SELECT id, record, delivery_id, reserved_at, claimed_at, claim_reason FROM attention_decisions
        WHERE owner_id = ? AND profile_id = ? ORDER BY rowid DESC LIMIT 64
      `).all(scope.ownerId, scope.profileId).map(decodeDecision)
      const progress = db.prepare(`
        SELECT p.task_id AS taskId, d.attempt_id AS attemptId, d.generation, p.summary, p.updated_at AS at
        FROM attention_progress p JOIN attention_decisions d ON d.id = p.decision_id
        WHERE p.owner_id = ? AND p.profile_id = ? ORDER BY p.updated_at DESC, p.task_id LIMIT 64
      `).all(scope.ownerId, scope.profileId).map(row => {
        const value = z.strictObject({ taskId: taskIdSchema, attemptId: attemptIdSchema, generation: generationSchema,
          summary: nonEmptyTextSchema.max(2_048), at: utcInstantSchema }).safeParse(row)
        return value.success ? value.data : corrupt()
      })
      const suppressedToday = db.prepare(`
        SELECT COUNT(*) AS count FROM attention_decisions WHERE owner_id = ? AND profile_id = ?
          AND (record ->> '$.action') = 'suppressed' AND (record ->> '$.at') BETWEEN ? AND ?
          AND dshpa_attention_local_day((record ->> '$.at'), ?) = ?
      `).get(scope.ownerId, scope.profileId, range.start, range.end, range.timeZone, range.day)?.count
      if (typeof suppressedToday !== 'number') return corrupt()
      return { policy, day: range.day, unsolicitedUsed: usage(db, scope.ownerId, range), unsolicitedLimit: MAX_UNSOLICITED,
        suppressedToday, decisions, progress }
    })
  }

  return Object.freeze({ configure, consider, claim, deliver, snapshot })
}
