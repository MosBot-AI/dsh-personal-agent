import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  accountIdSchema,
  attemptIdSchema,
  deliverySchema,
  effectSchema,
  generationSchema,
  nonEmptyTextSchema,
  operationIdSchema,
  sha256DigestSchema,
  sourceInstanceIdSchema,
  taskIdSchema,
  utcInstantSchema,
  type Effect,
  type OperationId,
  type OwnerId,
  type ProfileId,
  type UtcInstant,
} from '../domain/model.js'
import { canonicalizeAction, matchesActionBinding, type Action, type ActionBinding } from '../policy/grants.js'
import { recoveryMode } from '../storage/recovery-state.js'
import { StorageError, transaction } from '../storage/schema.js'
import type { WorkRef } from '../storage/store.js'

type DatabaseAccess = <T>(operation: (db: DatabaseSync) => T) => T
type Scope = Readonly<{ ownerId: OwnerId; profileId: ProfileId }>

const receiptIdentity = {
  operationId: operationIdSchema,
  taskId: taskIdSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  sourceInstanceId: sourceInstanceIdSchema,
  accountId: accountIdSchema,
  digest: sha256DigestSchema,
  providerIdempotencyKey: nonEmptyTextSchema.optional(),
}
const replySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...receiptIdentity, kind: z.literal('confirmed'), receiptId: nonEmptyTextSchema.max(256) }),
  z.strictObject({ ...receiptIdentity, kind: z.literal('failed'), failureReason: nonEmptyTextSchema.max(512) }),
  z.strictObject({ kind: z.literal('unknown') }),
])

export type EffectLookupRequest = Readonly<z.infer<z.ZodObject<typeof receiptIdentity>>> & Scope & ActionBinding

export interface EffectLookupRoute extends Scope {
  readonly binding: ActionBinding
  /** Read-only provider lookup. A failure reply must definitively rule out acceptance. */
  lookup(request: EffectLookupRequest, action: Action): unknown | Promise<unknown>
}

export interface EffectRecoveryOptions {
  readonly routes?: readonly EffectLookupRoute[]
  readonly now?: () => UtcInstant
}

type RecoveryError = 'not_found' | 'invalid_input' | 'busy' | 'readback_unavailable' | 'outcome_uncertain' | 'conflict'
export type EffectRecoveryResult = { ok: true; effect: Effect } | { ok: false; code: RecoveryError }
const deny = (code: RecoveryError): EffectRecoveryResult => ({ ok: false, code })
const BATCH_SIZE = 64
const MAX_RECORD_BYTES = 1024 * 1024

function corrupt(): never {
  throw new StorageError('corrupt', 'Stored recovery evidence failed validation')
}

function readJson(record: unknown): unknown {
  if (typeof record !== 'string' || record.length > MAX_RECORD_BYTES || Buffer.byteLength(record) > MAX_RECORD_BYTES) return corrupt()
  try {
    return JSON.parse(record)
  } catch {
    return corrupt()
  }
}

function scoped(left: Scope, right: Scope): boolean {
  return left.ownerId === right.ownerId && left.profileId === right.profileId
}

function classifyBatch(db: DatabaseSync, table: 'effects' | 'outbox'): { count: number; more: boolean } {
  if (recoveryMode(db) === 'normal') return { count: 0, more: false }
  const key = table === 'effects' ? 'operation_id' : 'id'
  const rows = db.prepare(`
    SELECT ${key} AS id, record FROM ${table} WHERE (record ->> '$.status') = 'dispatching' LIMIT ?
  `).all(BATCH_SIZE)
  const update = db.prepare(`UPDATE ${table} SET record = ? WHERE ${key} = ? AND record = ?`)
  let remaining = MAX_RECORD_BYTES
  let count = 0
  for (const row of rows) {
    const input = readJson(row.record)
    const decoded = table === 'effects' ? effectSchema.safeParse(input) : deliverySchema.safeParse(input)
    if (!decoded.success || decoded.data.status !== 'dispatching' || typeof row.record !== 'string') return corrupt()
    const record = decoded.data
    const id = 'operationId' in record ? record.operationId : record.id
    if (id !== row.id) return corrupt()
    const uncertain = JSON.stringify({ ...record, status: 'uncertain', reconciliation: { reason: 'Interrupted dispatch has no confirmed local receipt.' } })
    const bytes = Buffer.byteLength(uncertain)
    if (bytes > MAX_RECORD_BYTES) return corrupt()
    if (bytes > remaining) break
    if (update.run(uncertain, id, row.record).changes !== 1) {
      throw new StorageError('conflict', 'Dispatch claim changed before recovery classification')
    }
    remaining -= bytes
    count++
  }
  return { count, more: count < rows.length || rows.length === BATCH_SIZE }
}

function loadEffect(db: DatabaseSync, ref: WorkRef, operationId: OperationId) {
  const row = db.prepare(`
    SELECT e.record, p.canonical, p.digest, d.grant_id, d.claimed_at
    FROM effects e JOIN tasks t ON t.id = e.task_id
    LEFT JOIN action_proposals p ON p.operation_id = e.operation_id
      AND p.owner_id = t.owner_id AND p.profile_id = t.profile_id AND p.task_id = e.task_id
      AND p.attempt_id = e.attempt_id AND p.generation = e.generation
    LEFT JOIN action_dispatches d ON d.operation_id = p.operation_id
    WHERE e.operation_id = ? AND e.task_id = ? AND t.owner_id = ? AND t.profile_id = ?
  `).get(operationId, ref.taskId, ref.ownerId, ref.profileId)
  if (!row) return undefined
  const effect = effectSchema.safeParse(readJson(row.record))
  if (!effect.success || effect.data.taskId !== ref.taskId || effect.data.operationId !== operationId
    || typeof row.record !== 'string') return corrupt()
  return {
    record: row.record, effect: effect.data,
    canonical: row.canonical, digest: row.digest, grant_id: row.grant_id, claimed_at: row.claimed_at,
  }
}

type StoredEffect = NonNullable<ReturnType<typeof loadEffect>>

function lookupIdentity(row: StoredEffect, ref: WorkRef) {
  const { effect } = row
  if (!('grantId' in effect) || row.grant_id === null || row.canonical === null) return undefined
  const proposal = canonicalizeAction(readJson(row.canonical))
  if (!proposal || !utcInstantSchema.safeParse(row.claimed_at).success || proposal.canonical !== row.canonical
    || proposal.digest !== row.digest || effect.payloadDigest !== row.digest || effect.grantId !== row.grant_id) return corrupt()
  const { action } = proposal
  if (!scoped(action, ref) || action.operationId !== effect.operationId || action.taskId !== effect.taskId
    || action.attemptId !== effect.attemptId || action.generation !== effect.generation) return corrupt()
  const { payload: _payload, policyVersion: _policyVersion, ...identity } = action
  const request: EffectLookupRequest = Object.freeze({ ...identity, digest: proposal.digest,
    ...(effect.providerIdempotencyKey === undefined ? {} : { providerIdempotencyKey: effect.providerIdempotencyKey }) })
  return { action, request }
}

function matchReply(raw: unknown, identity: EffectLookupRequest) {
  const decoded = replySchema.safeParse(raw)
  if (!decoded.success || decoded.data.kind === 'unknown') return undefined
  const reply = decoded.data
  return Object.keys(receiptIdentity).every(key => reply[key as keyof typeof receiptIdentity] === identity[key as keyof typeof receiptIdentity])
    ? reply : undefined
}

/** Startup classification and exact historical readback. This service owns no send operation. */
export function createEffectRecovery(access: DatabaseAccess, options: EffectRecoveryOptions = {}) {
  const active = new Set<OperationId>()
  const routes = options.routes?.map(route => ({
    ownerId: route.ownerId, profileId: route.profileId,
    binding: Object.freeze({ ...route.binding, dataScope: Object.freeze([...route.binding.dataScope]), limits: Object.freeze({ ...route.binding.limits }) }),
    lookup: route.lookup.bind(route),
  })) ?? []
  const now = () => utcInstantSchema.parse(options.now?.() ?? new Date().toISOString())

  function classifyInterrupted() {
    function classify(table: 'effects' | 'outbox'): number {
      let total = 0
      let batch: ReturnType<typeof classifyBatch>
      do {
        batch = access(db => transaction(db, () => classifyBatch(db, table)))
        total += batch.count
      } while (batch.more)
      return total
    }
    return { effects: classify('effects'), deliveries: classify('outbox') }
  }

  async function reconcile(ref: WorkRef, operationId: OperationId): Promise<EffectRecoveryResult> {
    if (!operationIdSchema.safeParse(operationId).success) return deny('invalid_input')
    if (active.has(operationId)) return deny('busy')
    const row = access(db => loadEffect(db, ref, operationId))
    if (!row) return deny('not_found')
    const { effect } = row
    if (effect.status === 'confirmed' || effect.status === 'failed') return { ok: true, effect }
    if (effect.status !== 'uncertain' && effect.status !== 'manual_reconciliation' && effect.status !== 'dispatching') {
      return deny('readback_unavailable')
    }
    const lookup = lookupIdentity(row, ref)
    if (!lookup) return deny('readback_unavailable')
    const candidates = routes.filter(route => scoped(route, ref) && matchesActionBinding(lookup.action, route.binding))
    const route = candidates.length === 1 ? candidates[0] : undefined
    if (!route) return deny('readback_unavailable')

    active.add(operationId)
    try {
      let reply: ReturnType<typeof matchReply>
      try {
        reply = matchReply(await route.lookup(lookup.request, lookup.action), lookup.request)
      } catch {
        reply = undefined
      }
      return access(db => transaction(db, () => {
        const current = loadEffect(db, ref, operationId)
        if (!current || current.record !== row.record || current.canonical !== row.canonical
          || current.digest !== row.digest || current.grant_id !== row.grant_id || current.claimed_at !== row.claimed_at) return deny('conflict')
        const checkedAt = now()
        const reconciliation = { reason: reply ? 'The exact provider operation was reconciled.' : 'The provider could not confirm the exact operation.', checkedAt }
        const next = effectSchema.parse(reply?.kind === 'confirmed'
          ? { ...effect, status: 'confirmed', receipt: { providerReceiptId: reply.receiptId, recordedAt: checkedAt }, reconciliation }
          : reply?.kind === 'failed'
            ? { ...effect, status: 'failed', failureReason: 'The provider confirmed that the operation was not accepted.', reconciliation }
            : { ...effect, status: effect.status === 'manual_reconciliation' ? effect.status : 'uncertain', reconciliation })
        const update = db.prepare('UPDATE effects SET record = ? WHERE operation_id = ? AND record = ?')
          .run(JSON.stringify(next), operationId, row.record)
        if (update.changes !== 1) return deny('conflict')
        return reply ? { ok: true, effect: next } : deny('outcome_uncertain')
      }))
    } finally {
      active.delete(operationId)
    }
  }

  return Object.freeze({ classifyInterrupted, reconcile, isActive: () => active.size > 0 })
}
