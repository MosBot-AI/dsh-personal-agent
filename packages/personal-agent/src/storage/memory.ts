import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  capabilityIdSchema, capabilityInstantSchema, memoryAccessSchema, providerPinSchema, sameMemoryAccess, sameProviderPin,
  type MemoryAccess, type MemoryActiveRecord, type MemoryRecord,
} from '@mosbot-ai/dshpa-plugin-api'
import { z } from 'zod'
import { clientIdSchema, commandIdSchema, deviceIdSchema, nonEmptyTextSchema, ownerIdSchema, profileIdSchema, sha256DigestSchema,
  utcInstantSchema } from '../domain/model.js'
import type { OwnerIdentity } from '../policy/identity.js'
import { dispatchPermitted } from './recovery-state.js'
import { StorageError } from './schema.js'

const MAX_RECORDS_PER_SCOPE = 512
const MAX_COMMANDS_PER_PROFILE = 8_192
const MAX_RECEIPT_BYTES = 32_768
const revisionSchema = z.int().positive()
const revisableRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER - 1)
const pinSchema = providerPinSchema.extend({ kind: z.literal('memory') })
const command = commandIdSchema.max(256)

const actorSchema = z.object({ ownerId: ownerIdSchema.max(256), profileId: profileIdSchema.max(256), clientId: clientIdSchema.max(256),
  deviceId: deviceIdSchema.max(256), policyVersion: nonEmptyTextSchema.max(256), verifiedAt: utcInstantSchema })
export type MemoryLedgerActor = Pick<OwnerIdentity, keyof z.infer<typeof actorSchema>>

const recordFields = {
  access: memoryAccessSchema, id: capabilityIdSchema, revision: revisionSchema,
  digest: sha256DigestSchema.optional(), sourceEventIds: z.array(capabilityIdSchema).length(1),
  validFrom: capabilityInstantSchema, validUntil: capabilityInstantSchema.optional(),
  supersededBy: capabilityIdSchema.optional(), forgottenAt: capabilityInstantSchema.optional(),
}

type RecordState = 'pending' | 'active' | 'superseded' | 'forgotten'
function validRecord(record: { state: RecordState; id: string; digest?: string; revision: number; validFrom: string;
  validUntil?: string; forgottenAt?: string; supersededBy?: string }): boolean {
  return (record.state === 'forgotten') === (record.digest === undefined)
    && (record.state === 'forgotten') === (record.forgottenAt !== undefined)
    && (record.state === 'superseded') === (record.supersededBy !== undefined)
    && record.supersededBy !== record.id
    && (record.state !== 'pending' || record.revision === 1)
    && (record.validUntil === undefined || record.validUntil >= record.validFrom)
    && (record.forgottenAt === undefined || record.forgottenAt >= record.validFrom)
}

const ledgerRecordSchema = z.strictObject({ ...recordFields, state: z.enum(['pending', 'active', 'superseded', 'forgotten']),
  origin: z.literal('explicit'), confidence: z.literal(1) }).refine(validRecord)
export type MemoryLedgerRecord = z.infer<typeof ledgerRecordSchema>

const proofSchema = z.strictObject({ ...recordFields, state: z.enum(['active', 'superseded', 'forgotten']),
  origin: z.enum(['explicit', 'inferred']), confidence: z.number().min(0).max(1),
}).refine(validRecord)
export type MemoryLedgerProof = z.infer<typeof proofSchema>

const receiptSchema = z.strictObject({ access: memoryAccessSchema, commandId: command, kind: z.enum(['remember', 'correct', 'forget']),
  status: z.enum(['pending', 'completed']), at: capabilityInstantSchema, pin: pinSchema,
  previous: ledgerRecordSchema.optional(), proposed: ledgerRecordSchema.optional(),
}).refine(receipt => (receipt.kind === 'remember') === (receipt.previous === undefined)
  && (receipt.kind === 'forget') === (receipt.proposed === undefined)
  && (receipt.previous === undefined || (sameMemoryAccess(receipt.access, receipt.previous.access)
    && (receipt.previous.state === 'active' || (receipt.kind === 'forget' && receipt.previous.state === 'superseded'))))
  && (receipt.proposed === undefined || (sameMemoryAccess(receipt.access, receipt.proposed.access)
    && receipt.proposed.state === 'pending' && receipt.proposed.validFrom === receipt.at
    && receipt.proposed.id !== receipt.previous?.id)))
export type MemoryCommandReceipt = z.infer<typeof receiptSchema>

const reserveFields = { access: memoryAccessSchema, commandId: command, pin: pinSchema, at: capabilityInstantSchema }
const targetFields = { recordId: capabilityIdSchema, expectedRevision: revisableRevisionSchema }
const valueFields = { digest: sha256DigestSchema, validUntil: capabilityInstantSchema.optional() }
const reserveSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...reserveFields, ...valueFields, kind: z.literal('remember') }),
  z.strictObject({ ...reserveFields, ...targetFields, ...valueFields, kind: z.literal('correct') }),
  z.strictObject({ ...reserveFields, ...targetFields, kind: z.literal('forget') }),
])
const finishSchema = z.strictObject({ access: memoryAccessSchema, commandId: command, pin: pinSchema,
  proofs: z.array(proofSchema).min(1).max(2).refine(proofs => new Set(proofs.map(proof => proof.id)).size === proofs.length),
})
const pageSchema = z.strictObject({ limit: z.int().min(1).max(64).default(32), after: z.int().positive().optional() })
export type MemoryLedgerPage = z.input<typeof pageSchema>

type FailureCode = 'invalid_input' | 'permission_denied' | 'not_found' | 'conflict' | 'version_conflict' | 'busy' | 'recovery_required' | 'invalid_result'
type MutationResult = { ok: true; receipt: MemoryCommandReceipt; replayed: boolean } | { ok: false; code: FailureCode }
const fail = (code: FailureCode): MutationResult => ({ ok: false, code })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** Digest the canonical value only. The ledger matches record metadata separately. */
export function memoryValueDigest(value: MemoryActiveRecord['value']): string {
  return hash(JSON.stringify(value.kind === 'fact' ? ['fact', value.text] : ['reference', value.ref]))
}

/** Keep provider content out of the core ledger and its receipt proof. */
export function memoryRecordProof(record: MemoryRecord): MemoryLedgerProof {
  const { ownerId, profileId, scope, id, revision, sourceEventIds, validFrom, validUntil, origin, confidence, state } = record
  return { access: { ownerId, profileId, scope }, id, revision, sourceEventIds: [...sourceEventIds], validFrom, validUntil, origin,
    confidence, state, ...(state === 'forgotten' ? { forgottenAt: record.forgottenAt } : { digest: memoryValueDigest(record.value) }),
    ...(state === 'superseded' ? { supersededBy: record.supersededBy } : {}) }
}

function corrupt(): never {
  throw new StorageError('corrupt', 'Stored memory ledger metadata failed validation')
}

function scopeFields({ ownerId, profileId, scope }: MemoryAccess) {
  return [ownerId, profileId, scope.kind, scope.kind === 'profile' ? '' : scope.kind === 'project' ? scope.projectId : scope.taskId] as const
}

export function hasMemoryScope(db: DatabaseSync, input: unknown): boolean {
  const parsed = memoryAccessSchema.safeParse(input)
  if (!parsed.success) return false
  const { ownerId, profileId, scope } = parsed.data
  if (scope.kind === 'profile') return true
  if (scope.kind === 'project') {
    return db.prepare('SELECT 1 FROM projects WHERE id = ? AND owner_id = ? AND profile_id = ?').get(scope.projectId, ownerId, profileId) !== undefined
  }
  return db.prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ? AND profile_id = ?').get(scope.taskId, ownerId, profileId) !== undefined
}

const scopeWhere = 'owner_id = ? AND profile_id = ? AND scope_kind = ? AND scope_id = ?'
const ledgerFields = 'record_id AS id, revision, state, digest, source_id AS sourceId, valid_from AS validFrom, valid_until AS validUntil,\n'
  + 'superseded_by AS supersededBy, forgotten_at AS forgottenAt, pending_command AS pendingCommand, sequence'

function decodeLedger(access: MemoryAccess, row: Record<string, unknown>) {
  const record = ledgerRecordSchema.safeParse({ access, id: row.id, revision: row.revision, state: row.state,
    digest: row.digest ?? undefined, sourceEventIds: [row.sourceId], validFrom: row.validFrom, validUntil: row.validUntil ?? undefined,
    supersededBy: row.supersededBy ?? undefined, forgottenAt: row.forgottenAt ?? undefined, origin: 'explicit', confidence: 1 })
  if (!record.success || !/^memory-[a-f0-9]{64}$/u.test(record.data.id)
    || record.data.sourceEventIds[0] !== `memory-source-${record.data.id.slice('memory-'.length)}`
    || (row.pendingCommand !== null && (typeof row.pendingCommand !== 'string'
    || !sha256DigestSchema.safeParse(row.pendingCommand).success)) || typeof row.sequence !== 'number'
    || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return corrupt()
  return { record: record.data, pendingCommand: row.pendingCommand, sequence: row.sequence }
}

function loadRecord(db: DatabaseSync, access: MemoryAccess, id: string) {
  const row = db.prepare(`SELECT ${ledgerFields} FROM memory_ledger WHERE ${scopeWhere} AND record_id = ?`)
    .get(...scopeFields(access), id)
  return row && decodeLedger(access, row)
}

export function getMemoryRecord(db: DatabaseSync, access: MemoryAccess, id: string): MemoryLedgerRecord | undefined {
  if (!hasMemoryScope(db, access) || !capabilityIdSchema.safeParse(id).success) return undefined
  return loadRecord(db, access, id)?.record
}

export function listMemoryRecords(db: DatabaseSync, access: MemoryAccess, rawPage: MemoryLedgerPage = {}) {
  if (!hasMemoryScope(db, access)) return { items: [] as MemoryLedgerRecord[] }
  const page = pageSchema.safeParse(rawPage)
  if (!page.success) throw new StorageError('invalid_input', 'Memory ledger page is invalid')
  const { limit, after = Number.MAX_SAFE_INTEGER } = page.data
  const rows = db.prepare(`SELECT ${ledgerFields} FROM memory_ledger WHERE ${scopeWhere} AND state = 'active'
    AND sequence < ? ORDER BY sequence DESC LIMIT ?`).all(...scopeFields(access), after, limit + 1)
  const decoded = rows.slice(0, limit).map(row => decodeLedger(access, row))
  return { items: decoded.map(item => item.record), ...(rows.length > limit ? { nextAfter: decoded.at(-1)!.sequence } : {}) }
}

const sourceSchema = z.strictObject({ id: capabilityIdSchema, access: memoryAccessSchema, clientId: clientIdSchema.max(256),
  deviceId: deviceIdSchema.max(256), policyVersion: nonEmptyTextSchema.max(256), verifiedAt: utcInstantSchema, at: capabilityInstantSchema,
}).refine(source => source.at >= source.verifiedAt)
export type MemorySourceReceipt = z.infer<typeof sourceSchema>

export function getMemorySource(db: DatabaseSync, access: MemoryAccess, id: string): MemorySourceReceipt | undefined {
  if (!hasMemoryScope(db, access) || !capabilityIdSchema.safeParse(id).success) return undefined
  const row = db.prepare(`SELECT id, client_id AS clientId, device_id AS deviceId, policy_version AS policyVersion,
    verified_at AS verifiedAt, occurred_at AS at, command_ref AS commandRef FROM memory_sources WHERE ${scopeWhere} AND id = ?`)
    .get(...scopeFields(access), id)
  if (!row) return undefined
  const { commandRef, ...fields } = row
  if (typeof commandRef !== 'string' || !sha256DigestSchema.safeParse(commandRef).success || id !== `memory-source-${commandRef}`) return corrupt()
  const source = sourceSchema.safeParse({ ...fields, access })
  return source.success ? source.data : corrupt()
}

function loadCommand(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT owner_id, profile_id, client_id, command_id, actor_digest, fingerprint, receipt FROM memory_commands WHERE id = ?').get(id)
  if (!row) return undefined
  if (typeof row.receipt !== 'string' || Buffer.byteLength(row.receipt) > MAX_RECEIPT_BYTES
    || !sha256DigestSchema.safeParse(row.fingerprint).success || !sha256DigestSchema.safeParse(row.actor_digest).success) return corrupt()
  try {
    const receipt = receiptSchema.parse(JSON.parse(row.receipt))
    if (receipt.access.ownerId !== row.owner_id || receipt.access.profileId !== row.profile_id || receipt.commandId !== row.command_id
      || id !== hash(JSON.stringify([row.owner_id, row.profile_id, row.client_id, row.command_id]))
      || (receipt.proposed && (receipt.proposed.id !== `memory-${id}` || receipt.proposed.sourceEventIds[0] !== `memory-source-${id}`))) return corrupt()
    return { fingerprint: row.fingerprint, actorDigest: row.actor_digest, receipt }
  } catch { return corrupt() }
}

function commandKey(actor: z.infer<typeof actorSchema>, commandId: string): string {
  return hash(JSON.stringify([actor.ownerId, actor.profileId, actor.clientId, commandId]))
}

function previousFinal(receipt: MemoryCommandReceipt): (MemoryLedgerRecord & { state: 'superseded' | 'forgotten' }) | undefined {
  const previous = receipt.previous
  if (!previous) return undefined
  if (receipt.kind === 'forget') return { ...previous, state: 'forgotten', revision: previous.revision + 1,
    forgottenAt: receipt.at, digest: undefined, supersededBy: undefined }
  const validUntil = previous.validUntil === undefined || receipt.at < previous.validUntil ? receipt.at : previous.validUntil
  return { ...previous, state: 'superseded', revision: previous.revision + 1, validUntil, supersededBy: receipt.proposed!.id }
}

function encodeReceipt(receipt: MemoryCommandReceipt): string {
  const data = JSON.stringify(receiptSchema.parse(receipt))
  if (Buffer.byteLength(data) > MAX_RECEIPT_BYTES) throw new StorageError('invalid_input', 'Memory command receipt is too large')
  return data
}

/** The WorkStore caller holds an atomic writer transaction across this entire reservation. */
export function reserveMemoryCommand(db: DatabaseSync, rawActor: MemoryLedgerActor, input: unknown): MutationResult {
  const actorResult = actorSchema.safeParse(rawActor)
  const parsed = reserveSchema.safeParse(input)
  if (!actorResult.success || !parsed.success) return fail('invalid_input')
  const actor = actorResult.data
  const request = parsed.data
  const { access, commandId, kind, pin } = request
  if (actor.ownerId !== access.ownerId || actor.profileId !== access.profileId || !hasMemoryScope(db, access)) return fail('permission_denied')
  if (!dispatchPermitted(db)) return fail('recovery_required')
  const id = commandKey(actor, commandId)
  const actorDigest = hash(JSON.stringify(actor))
  const fingerprint = hash(JSON.stringify({ ...request, at: undefined, actorDigest }))
  const existing = loadCommand(db, id)
  if (existing) return existing.fingerprint === fingerprint && existing.actorDigest === actorDigest
    ? { ok: true, receipt: existing.receipt, replayed: true } : fail('conflict')
  if (request.at < actor.verifiedAt) return fail('invalid_input')

  const target = request.kind === 'remember' ? undefined : loadRecord(db, access, request.recordId)
  const previous = target?.record
  if (request.kind !== 'remember') {
    if (!previous) return fail('not_found')
    if (previous.revision !== request.expectedRevision) return fail('version_conflict')
    if (target?.pendingCommand !== null) return fail('busy')
    if (previous.state !== 'active' && (request.kind !== 'forget' || previous.state !== 'superseded')) return fail('conflict')
    if (!getMemorySource(db, access, previous.sourceEventIds[0]!)) return corrupt()
  }

  const at = kind === 'correct' && previous && request.at <= previous.validFrom
    ? new Date(Date.parse(previous.validFrom) + 1).toISOString() : request.at
  if (!capabilityInstantSchema.safeParse(at).success || (previous && at < previous.validFrom)
    || (request.kind !== 'forget' && request.validUntil !== undefined && request.validUntil < at)) return fail('invalid_input')
  const commands = db.prepare('SELECT count(*) AS count FROM memory_commands WHERE owner_id = ? AND profile_id = ?')
    .get(access.ownerId, access.profileId)?.count
  if (typeof commands !== 'number' || commands >= MAX_COMMANDS_PER_PROFILE) return fail('busy')
  let proposed: MemoryLedgerRecord | undefined
  if (request.kind !== 'forget') {
    const records = db.prepare(`SELECT count(*) AS count FROM memory_ledger WHERE ${scopeWhere}`).get(...scopeFields(access))?.count
    if (typeof records !== 'number' || records >= MAX_RECORDS_PER_SCOPE) return fail('busy')
    proposed = { access, id: `memory-${id}`, state: 'pending', revision: 1, digest: request.digest,
      sourceEventIds: [`memory-source-${id}`], validFrom: at, validUntil: request.validUntil, origin: 'explicit', confidence: 1 }
  }
  const receipt: MemoryCommandReceipt = { access, commandId, kind, pin, at, status: 'pending', previous, proposed }
  db.prepare(`INSERT INTO memory_commands (id, owner_id, profile_id, client_id, command_id, actor_digest, fingerprint, receipt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, actor.ownerId, actor.profileId, actor.clientId, commandId, actorDigest, fingerprint, encodeReceipt(receipt))

  if (proposed) {
    const sourceId = proposed.sourceEventIds[0]!
    db.prepare(`INSERT INTO memory_sources (id, owner_id, profile_id, scope_kind, scope_id, command_ref, client_id, device_id,
      verified_at, policy_version, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sourceId, ...scopeFields(access), id, actor.clientId, actor.deviceId, actor.verifiedAt, actor.policyVersion, at)
    db.prepare(`INSERT INTO memory_ledger (record_id, owner_id, profile_id, scope_kind, scope_id, state, revision, digest,
      source_id, valid_from, valid_until, pending_command) VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?)`)
      .run(proposed.id, ...scopeFields(access), proposed.digest!, sourceId, at, proposed.validUntil ?? null, id)
  }
  const old = previousFinal(receipt)
  if (previous && old) {
    const changed = db.prepare(`UPDATE memory_ledger SET state = ?, revision = ?, digest = ?, valid_until = ?, superseded_by = ?,
      forgotten_at = ?, pending_command = ? WHERE ${scopeWhere} AND record_id = ? AND revision = ? AND state = ? AND pending_command IS NULL`)
      .run(old.state, old.revision, old.digest ?? null, old.validUntil ?? null, old.supersededBy ?? null, old.forgottenAt ?? null,
        id, ...scopeFields(access), previous.id, previous.revision, previous.state)
    if (changed.changes !== 1) throw new StorageError('version_conflict', 'Memory record changed during reservation')
  }
  return { ok: true, receipt, replayed: false }
}

export function sameMemoryLedgerProof(left: MemoryLedgerProof | MemoryLedgerRecord, right: MemoryLedgerProof | MemoryLedgerRecord): boolean {
  const project = ({ access, id, revision, state, digest, sourceEventIds, validFrom, validUntil, origin, confidence,
    supersededBy, forgottenAt }: MemoryLedgerProof | MemoryLedgerRecord) => [scopeFields(access), id, revision, state, digest,
    sourceEventIds, validFrom, validUntil, origin, confidence, supersededBy, forgottenAt]
  return JSON.stringify(project(left)) === JSON.stringify(project(right))
}

/** Exact provider post-images for a reserved operation, independent of retry time. */
export function expectedMemoryProofs(receipt: MemoryCommandReceipt): MemoryLedgerProof[] {
  const old = previousFinal(receipt)
  const active = receipt.proposed && { ...receipt.proposed, state: 'active' as const }
  return [...(old ? [old] : []), ...(active ? [active] : [])]
}

/** Finish only after trusted readback proves the exact reserved provider operation. */
export function finishMemoryCommand(db: DatabaseSync, rawActor: MemoryLedgerActor, input: unknown): MutationResult {
  const actorResult = actorSchema.safeParse(rawActor)
  const parsed = finishSchema.safeParse(input)
  if (!actorResult.success || !parsed.success) return fail('invalid_input')
  const actor = actorResult.data
  const { access, commandId, pin, proofs } = parsed.data
  if (actor.ownerId !== access.ownerId || actor.profileId !== access.profileId || !hasMemoryScope(db, access)) return fail('permission_denied')
  if (!dispatchPermitted(db)) return fail('recovery_required')
  const id = commandKey(actor, commandId)
  const existing = loadCommand(db, id)
  if (!existing) return fail('not_found')
  const { receipt } = existing
  if (existing.actorDigest !== hash(JSON.stringify(actor)) || !sameMemoryAccess(receipt.access, access)
    || !sameProviderPin(receipt.pin, pin)) return fail('conflict')
  const expected = expectedMemoryProofs(receipt)
  if (proofs.length !== expected.length || !expected.every(record => proofs.some(proof => sameMemoryLedgerProof(proof, record)))) return fail('invalid_result')
  if (receipt.status === 'completed') return { ok: true, receipt, replayed: true }
  for (const record of [previousFinal(receipt), receipt.proposed]) {
    if (!record) continue
    const stored = loadRecord(db, access, record.id)
    if (!stored || stored.pendingCommand !== id || !sameMemoryLedgerProof(stored.record, record)) return corrupt()
    const changed = db.prepare(`UPDATE memory_ledger SET state = ?, pending_command = NULL
      WHERE ${scopeWhere} AND record_id = ? AND pending_command = ?`).run(record.state === 'pending' ? 'active' : record.state,
      ...scopeFields(access), record.id, id)
    if (changed.changes !== 1) throw new StorageError('version_conflict', 'Memory record changed before completion')
  }
  const completed = { ...receipt, status: 'completed' as const }
  const changed = db.prepare('UPDATE memory_commands SET receipt = ? WHERE id = ? AND (receipt ->> \'$.status\') = \'pending\'')
    .run(encodeReceipt(completed), id)
  if (changed.changes !== 1) throw new StorageError('version_conflict', 'Memory receipt changed before completion')
  return { ok: true, receipt: completed, replayed: false }
}
