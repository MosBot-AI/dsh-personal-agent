import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  completeRoutineOccurrenceSchema, createRoutineSchema, reserveRoutineMappingSchema, retimeRoutineMappingSchema,
  routineMappingSchema, routineOccurrenceSchema, routineRefSchema, routineSchema, routineScopeSchema,
  runRoutineNowSchema, skipRoutineMisfireSchema, updateRoutineMappingSchema, updateRoutineSchema,
  type GoalAdmission, type Routine, type RoutineAuthority, type RoutineGoal, type RoutineMapping, type RoutineNativeReceipt, type RoutineOccurrence,
  type RoutineRef, type RoutineScope, type RoutineSkipReason, type RoutineTarget,
} from '../domain/routines.js'
import { utcInstantSchema, type UtcInstant } from '../domain/model.js'
import { dispatchPermitted } from './recovery-state.js'
import { StorageError } from './schema.js'

const MAX_ARMED = 64
const MAX_OPEN_MAPPINGS = 128
const limitSchema = z.int().min(1).max(128)
type FailureCode = 'invalid_input' | 'invalid_transition' | 'not_found' | 'version_conflict' | 'permission_denied'
  | 'recovery_required' | 'capacity' | 'conflict' | 'command_conflict'
type Failure = { ok: false; code: FailureCode }
type RoutineResult = { ok: true; routine: Routine } | Failure
type MappingResult = { ok: true; mapping: RoutineMapping; duplicate: boolean } | Failure
type OccurrenceResult = { ok: true; occurrence: RoutineOccurrence; duplicate: boolean } | Failure

export interface RoutineWakeRequest {
  readonly routine: Routine
  readonly goal: RoutineGoal
  readonly occurrence: Pick<RoutineOccurrence, 'id' | 'kind' | 'intendedAt' | 'observedAt'>
  readonly authority: RoutineAuthority
  readonly admission: GoalAdmission
}
export type RoutineWakeResult =
  | { status: 'queued'; taskId: RoutineGoal['taskId']; taskVersion: number; sourceEventId: NonNullable<RoutineOccurrence['sourceEventId']> }
  | { status: 'skipped'; reason: RoutineSkipReason }
type Wake = (request: RoutineWakeRequest) => RoutineWakeResult

function fail(code: FailureCode): Failure {
  return { ok: false, code }
}

function corrupt(): never {
  throw new StorageError('corrupt', 'Stored Routine data failed validation')
}

function decode<T>(raw: unknown, schema: { parse(value: unknown): T }): T {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65_536) return corrupt()
  try {
    return schema.parse(JSON.parse(raw))
  } catch {
    return corrupt()
  }
}

function hash(values: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

function sameAuthority(left: RoutineAuthority | undefined, right: RoutineAuthority | undefined): boolean {
  return left !== undefined && right !== undefined && left.clientId === right.clientId && left.deviceId === right.deviceId
    && left.verifiedAt === right.verifiedAt && left.policyVersion === right.policyVersion
}

function exactScope(scope: RoutineScope): RoutineScope {
  return { ownerId: scope.ownerId, profileId: scope.profileId }
}

export function getRoutine(db: DatabaseSync, ref: RoutineRef): Routine | undefined {
  const row = db.prepare('SELECT record FROM routines WHERE id = ? AND owner_id = ? AND profile_id = ?')
    .get(ref.routineId, ref.ownerId, ref.profileId)
  return row && decode(row.record, routineSchema)
}

export function listRoutines(db: DatabaseSync, scope: RoutineScope, limit = 64): Routine[] {
  return db.prepare('SELECT record FROM routines WHERE owner_id = ? AND profile_id = ? ORDER BY id LIMIT ?')
    .all(scope.ownerId, scope.profileId, limitSchema.parse(limit)).map(row => decode(row.record, routineSchema))
}

export function listArmedRoutines(db: DatabaseSync): Routine[] {
  const rows = db.prepare("SELECT record FROM routines WHERE status = 'armed' ORDER BY id LIMIT ?").all(MAX_ARMED + 1)
  if (rows.length > MAX_ARMED) return corrupt()
  return rows.map(row => decode(row.record, routineSchema))
}

export function listRoutineMappings(db: DatabaseSync, scope?: RoutineScope): RoutineMapping[] {
  const rows = scope === undefined
    ? db.prepare("SELECT record FROM routine_mappings WHERE state <> 'terminal' ORDER BY id LIMIT ?")
      .all(MAX_OPEN_MAPPINGS + 1)
    : db.prepare(`
      SELECT record FROM routine_mappings WHERE state <> 'terminal' AND owner_id = ? AND profile_id = ?
      ORDER BY id LIMIT ?
    `).all(scope.ownerId, scope.profileId, MAX_OPEN_MAPPINGS + 1)
  if (rows.length > MAX_OPEN_MAPPINGS) return corrupt()
  return rows.map(row => decode(row.record, routineMappingSchema))
}

export function listRoutineOccurrences(db: DatabaseSync, scope: RoutineScope, limit = 64): RoutineOccurrence[] {
  return db.prepare(`
    SELECT record FROM routine_occurrences WHERE owner_id = ? AND profile_id = ? ORDER BY observed_at DESC, id LIMIT ?
  `).all(scope.ownerId, scope.profileId, limitSchema.parse(limit)).map(row => decode(row.record, routineOccurrenceSchema))
}

function targetInScope(db: DatabaseSync, scope: RoutineScope, target: RoutineTarget): boolean {
  return target.kind === 'reminder' || db.prepare(`
    SELECT 1 FROM tasks WHERE id = ? AND owner_id = ? AND profile_id = ? AND project_id = ?
  `).get(target.taskId, scope.ownerId, scope.profileId, target.projectId) !== undefined
}

export function createRoutine(db: DatabaseSync, rawScope: RoutineScope, input: unknown, rawAt: UtcInstant): RoutineResult {
  const scope = routineScopeSchema.safeParse(exactScope(rawScope))
  const decoded = createRoutineSchema.safeParse(input)
  const at = utcInstantSchema.safeParse(rawAt)
  if (!scope.success || !decoded.success || !at.success) return fail('invalid_input')
  if (!targetInScope(db, scope.data, decoded.data.target)) return fail('permission_denied')
  if (db.prepare('SELECT 1 FROM routines WHERE id = ?').get(decoded.data.id)) return fail('conflict')
  const routine = routineSchema.parse({
    ...decoded.data, ...scope.data, revision: 1, status: 'draft', updatedAt: at.data,
  })
  db.prepare('INSERT INTO routines (id, record) VALUES (?, ?)').run(routine.id, JSON.stringify(routine))
  return { ok: true, routine }
}

function writeRoutine(db: DatabaseSync, before: Routine, routine: Routine): boolean {
  return db.prepare('UPDATE routines SET record = ? WHERE id = ? AND owner_id = ? AND profile_id = ? AND revision = ?')
    .run(JSON.stringify(routine), before.id, before.ownerId, before.profileId, before.revision).changes === 1
}

export function updateRoutine(db: DatabaseSync, ref: RoutineRef, input: unknown): RoutineResult {
  const decoded = updateRoutineSchema.safeParse(input)
  if (!decoded.success || !routineRefSchema.safeParse(ref).success) return fail('invalid_input')
  const before = getRoutine(db, ref)
  if (!before) return fail('not_found')
  const change = decoded.data
  if (before.revision !== change.expectedRevision) return fail('version_conflict')
  const revision = before.revision + 1
  if (!Number.isSafeInteger(revision) || change.at < before.updatedAt) return fail('invalid_input')
  const base = { ...before, revision, updatedAt: change.at, authority: undefined, nextIntendedAt: undefined }
  let routine: Routine
  switch (change.type) {
    case 'arm': {
      if (before.status !== 'draft' && before.status !== 'paused') return fail('invalid_transition')
      if (!dispatchPermitted(db)) return fail('recovery_required')
      if (!targetInScope(db, ref, before.target)) return fail('permission_denied')
      if (change.authority.verifiedAt > change.at || change.nextIntendedAt <= change.at
        || (before.timing.kind === 'at' && before.timing.at !== change.nextIntendedAt)) return fail('invalid_input')
      const count = db.prepare("SELECT COUNT(*) AS count FROM routines WHERE status = 'armed'").get()?.count
      if (typeof count !== 'number' || count >= MAX_ARMED) return fail('capacity')
      routine = { ...base, status: 'armed', authority: change.authority, nextIntendedAt: change.nextIntendedAt }
      break
    }
    case 'pause':
      if (before.status !== 'armed' && before.status !== 'ended') return fail('invalid_transition')
      routine = { ...base, status: 'paused' }
      break
    case 'edit':
      if (!targetInScope(db, ref, change.intent.target)) return fail('permission_denied')
      routine = { ...base, ...change.intent, status: 'draft' }
      break
  }
  return writeRoutine(db, before, routine) ? { ok: true, routine } : fail('version_conflict')
}

function getMapping(db: DatabaseSync, ref: RoutineRef, id: string): RoutineMapping | undefined {
  const row = db.prepare('SELECT record FROM routine_mappings WHERE id = ? AND routine_id = ? AND owner_id = ? AND profile_id = ?')
    .get(id, ref.routineId, ref.ownerId, ref.profileId)
  return row && decode(row.record, routineMappingSchema)
}

function openMapping(db: DatabaseSync, ref: RoutineRef, revision: number): RoutineMapping | undefined {
  const row = db.prepare(`
    SELECT record FROM routine_mappings WHERE routine_id = ? AND owner_id = ? AND profile_id = ?
      AND routine_revision = ? AND state <> 'terminal'
  `).get(ref.routineId, ref.ownerId, ref.profileId, revision)
  return row && decode(row.record, routineMappingSchema)
}

function writeMapping(db: DatabaseSync, before: RoutineMapping, next: RoutineMapping): boolean {
  return db.prepare('UPDATE routine_mappings SET record = ? WHERE id = ? AND version = ?')
    .run(JSON.stringify(next), before.id, before.version).changes === 1
}

export function reserveRoutineMapping(db: DatabaseSync, ref: RoutineRef, input: unknown): MappingResult {
  const decoded = reserveRoutineMappingSchema.safeParse(input)
  if (!decoded.success || !routineRefSchema.safeParse(ref).success) return fail('invalid_input')
  const request = decoded.data
  const routine = getRoutine(db, ref)
  if (!routine) return fail('not_found')
  if (routine.revision !== request.expectedRevision) return fail('version_conflict')
  if (routine.status !== 'armed' || routine.nextIntendedAt === undefined) return fail('invalid_transition')
  if (!dispatchPermitted(db)) return fail('recovery_required')
  const digest = hash([ref.ownerId, ref.profileId, ref.routineId, routine.revision, request.intendedAt])
  const id = `routine-map-${digest}`
  const existing = getMapping(db, ref, id)
  if (existing) return existing.mailboxId === request.mailboxId
    ? { ok: true, mapping: existing, duplicate: true } : fail('conflict')
  if (request.at < routine.updatedAt || request.nativeWakeAt <= request.at || request.nativeWakeAt < request.intendedAt
    || (request.nativeWakeAt !== request.intendedAt && Date.parse(request.nativeWakeAt) - Date.parse(request.at) > 1_000)
    || request.intendedAt < routine.nextIntendedAt
    || (request.intendedAt !== routine.nextIntendedAt
      && (routine.timing.kind !== 'cron' || routine.misfire !== 'latest'
        || routine.nextIntendedAt >= request.at || request.intendedAt > request.at))) return fail('invalid_input')
  if (openMapping(db, ref, routine.revision)) return fail('conflict')
  const count = db.prepare("SELECT COUNT(*) AS count FROM routine_mappings WHERE state <> 'terminal'").get()?.count
  if (typeof count !== 'number' || count >= MAX_OPEN_MAPPINGS) return fail('capacity')
  const mapping: RoutineMapping = {
    ...ref, id, title: routine.title, routineRevision: routine.revision,
    intendedAt: request.intendedAt, nativeWakeAt: request.nativeWakeAt,
    mailboxId: request.mailboxId, marker: `dshpa-routine:${digest}`, state: 'intent', version: 1,
  }
  if (request.intendedAt !== routine.nextIntendedAt
    && !writeRoutine(db, routine, { ...routine, nextIntendedAt: request.intendedAt })) return fail('version_conflict')
  db.prepare('INSERT INTO routine_mappings (id, record) VALUES (?, ?)').run(id, JSON.stringify(mapping))
  return { ok: true, mapping, duplicate: false }
}

export function updateRoutineMapping(db: DatabaseSync, ref: RoutineRef, input: unknown): MappingResult {
  const decoded = updateRoutineMappingSchema.safeParse(input)
  if (!decoded.success || !routineRefSchema.safeParse(ref).success) return fail('invalid_input')
  const { mappingId, expectedVersion, state, nativeId: requestedId, terminalReason } = decoded.data
  const before = getMapping(db, ref, mappingId)
  if (!before) return fail('not_found')
  if (before.version !== expectedVersion) return fail('version_conflict')
  if (before.nativeId !== undefined && requestedId !== undefined && before.nativeId !== requestedId) return fail('conflict')
  const nativeId = before.nativeId ?? requestedId
  if (before.state === state && before.nativeId === nativeId && before.terminalReason === terminalReason) {
    return { ok: true, mapping: before, duplicate: true }
  }
  if (before.state === 'terminal' || (state === 'bound' && nativeId === undefined)) return fail('invalid_transition')
  if (nativeId !== undefined && db.prepare('SELECT 1 FROM routine_mappings WHERE native_id = ? AND id <> ?')
    .get(nativeId, before.id)) return fail('conflict')
  const version = before.version + 1
  if (!Number.isSafeInteger(version)) return fail('invalid_input')
  const mapping = { ...before, state, nativeId, version, terminalReason }
  return writeMapping(db, before, mapping) ? { ok: true, mapping, duplicate: false } : fail('version_conflict')
}

export function retimeRoutineMapping(db: DatabaseSync, ref: RoutineRef, input: unknown): MappingResult {
  const decoded = retimeRoutineMappingSchema.safeParse(input)
  if (!decoded.success || !routineRefSchema.safeParse(ref).success) return fail('invalid_input')
  const { mappingId, expectedVersion, nativeWakeAt } = decoded.data
  const before = getMapping(db, ref, mappingId)
  if (!before) return fail('not_found')
  if (before.version !== expectedVersion) return fail('version_conflict')
  const routine = getRoutine(db, ref)
  if (before.state !== 'intent' || before.nativeId !== undefined || nativeWakeAt <= before.nativeWakeAt
    || routine?.status !== 'armed' || routine.revision !== before.routineRevision
    || routine.nextIntendedAt !== before.intendedAt) return fail('invalid_transition')
  if (!dispatchPermitted(db)) return fail('recovery_required')
  const version = before.version + 1
  if (!Number.isSafeInteger(version)) return fail('invalid_input')
  const mapping = { ...before, nativeWakeAt, version }
  return writeMapping(db, before, mapping) ? { ok: true, mapping, duplicate: false } : fail('version_conflict')
}

function scheduledOccurrence(db: DatabaseSync, ref: RoutineRef, revision: number, intendedAt: UtcInstant): RoutineOccurrence | undefined {
  const row = db.prepare(`
    SELECT record FROM routine_occurrences
    WHERE routine_id = ? AND owner_id = ? AND profile_id = ? AND routine_revision = ? AND intended_at = ? AND kind = 'scheduled'
  `).get(ref.routineId, ref.ownerId, ref.profileId, revision, intendedAt)
  return row && decode(row.record, routineOccurrenceSchema)
}

function persistOccurrence(
  db: DatabaseSync,
  raw: RoutineOccurrence,
  mappingId?: string,
  manual?: { clientId: string; commandId: string },
): RoutineOccurrence {
  const occurrence = routineOccurrenceSchema.parse(raw)
  db.prepare('INSERT INTO routine_occurrences (id, record, mapping_id, client_id, command_id) VALUES (?, ?, ?, ?, ?)')
    .run(occurrence.id, JSON.stringify(occurrence), mappingId ?? null, manual?.clientId ?? null, manual?.commandId ?? null)
  return occurrence
}

function scheduledBase(ref: RoutineRef, title: string, revision: number, intendedAt: UtcInstant, at: UtcInstant) {
  return {
    ...ref, title, id: `routine-occ-${hash([ref.ownerId, ref.profileId, ref.routineId, revision, intendedAt])}`,
    routineRevision: revision, intendedAt, observedAt: at, kind: 'scheduled' as const,
  }
}

function advance(db: DatabaseSync, before: Routine, nextIntendedAt: UtcInstant | undefined): void {
  const next = { ...before, status: nextIntendedAt === undefined ? 'ended' as const : 'armed' as const, nextIntendedAt }
  if (!writeRoutine(db, before, next)) throw new StorageError('version_conflict', 'Routine changed before advancing')
}

function terminal(db: DatabaseSync, before: RoutineMapping): void {
  if (before.state === 'terminal') return
  const version = before.version + 1
  if (!Number.isSafeInteger(version) || !writeMapping(db, before, { ...before, state: 'terminal', version })) {
    throw new StorageError('version_conflict', 'Native mapping changed before completion')
  }
}

function validSuccessor(routine: Routine, intendedAt: UtcInstant, next: UtcInstant | undefined): boolean {
  return next === undefined || (routine.timing.kind === 'cron' && next > intendedAt)
}

export function skipRoutineMisfire(db: DatabaseSync, ref: RoutineRef, input: unknown): OccurrenceResult {
  const decoded = skipRoutineMisfireSchema.safeParse(input)
  if (!decoded.success || !routineRefSchema.safeParse(ref).success) return fail('invalid_input')
  const { expectedRevision, expectedIntendedAt, nextIntendedAt, at, mappingId, expectedMappingVersion } = decoded.data
  const prior = scheduledOccurrence(db, ref, expectedRevision, expectedIntendedAt)
  if (prior) return { ok: true, occurrence: prior, duplicate: true }
  const routine = getRoutine(db, ref)
  if (!routine) return fail('not_found')
  if (routine.revision !== expectedRevision) return fail('version_conflict')
  if (routine.status !== 'armed' || routine.nextIntendedAt !== expectedIntendedAt) return fail('invalid_transition')
  if (!dispatchPermitted(db)) return fail('recovery_required')
  if (at <= expectedIntendedAt || at < routine.updatedAt || !validSuccessor(routine, expectedIntendedAt, nextIntendedAt)
    || (routine.misfire === 'latest' && (nextIntendedAt === undefined || nextIntendedAt > at))) return fail('invalid_input')
  const pending = openMapping(db, ref, expectedRevision)
  if (pending?.id !== mappingId || (pending && (pending.version !== expectedMappingVersion
    || pending.state !== 'intent' || pending.nativeId !== undefined || pending.routineRevision !== expectedRevision
    || pending.intendedAt !== expectedIntendedAt))) return fail('conflict')
  const occurrence = persistOccurrence(db, {
    ...scheduledBase(ref, routine.title, expectedRevision, expectedIntendedAt, at), status: 'skipped', reason: 'misfire',
  }, mappingId)
  if (pending) terminal(db, pending)
  advance(db, routine, nextIntendedAt)
  return { ok: true, occurrence, duplicate: false }
}

function decide(
  db: DatabaseSync,
  routine: Routine,
  occurrence: RoutineWakeRequest['occurrence'],
  authority: RoutineAuthority | undefined,
  admission: GoalAdmission | undefined,
  wake: Wake,
) {
  if (!dispatchPermitted(db)) return { status: 'skipped', reason: 'recovery_required' } as const
  if (!authority || !sameAuthority(routine.authority, authority)) return { status: 'skipped', reason: 'authority_changed' } as const
  const { target } = routine
  if (target.kind === 'reminder') return { status: 'reminded', reminderText: target.text } as const
  if (!admission?.grantsCurrent) return { status: 'skipped', reason: 'grant_unavailable' } as const
  if (!admission.budgetAvailable) return { status: 'skipped', reason: 'budget_unavailable' } as const
  if (!admission.conditionSatisfied) return { status: 'skipped', reason: 'condition_unmet' } as const
  return wake({ routine, goal: target, occurrence, authority, admission })
}

export function completeRoutineOccurrence(db: DatabaseSync, ref: RoutineRef, input: unknown, wake: Wake): OccurrenceResult {
  const decoded = completeRoutineOccurrenceSchema.safeParse(input)
  if (!decoded.success || !routineRefSchema.safeParse(ref).success) return fail('invalid_input')
  const { mappingId, receipt, intendedAt, nextIntendedAt, at, authority, goalAdmission, skipReason } = decoded.data
  const mapping = getMapping(db, ref, mappingId)
  if (!mapping) return fail('not_found')
  if ((mapping.state !== 'bound' && mapping.state !== 'terminal') || mapping.nativeId !== receipt.nativeId
    || mapping.mailboxId !== receipt.targetSessionId || mapping.marker !== receipt.prompt
    || mapping.nativeWakeAt !== receipt.scheduledAt || receipt.deliveredAt > at) return fail('permission_denied')
  const saved = db.prepare('SELECT record FROM routine_occurrences WHERE mapping_id = ?').get(mappingId)
  if (saved) return { ok: true, occurrence: decode(saved.record, routineOccurrenceSchema), duplicate: true }
  const routine = getRoutine(db, ref)
  if (!routine) return fail('not_found')
  const current = routine.revision === mapping.routineRevision && routine.status === 'armed'
    && routine.nextIntendedAt === mapping.intendedAt
  const advances = current && mapping.state === 'bound'
  const applied = advances ? intendedAt : mapping.intendedAt
  if (applied < mapping.intendedAt || applied > receipt.deliveredAt || (advances && (
    !validSuccessor(routine, applied, nextIntendedAt)
    || (applied !== mapping.intendedAt && (routine.misfire !== 'latest' || routine.timing.kind !== 'cron'))
    || (skipReason === 'misfire' && routine.misfire === 'latest'
      && (routine.timing.kind !== 'cron' || applied !== mapping.intendedAt || nextIntendedAt === undefined
        || nextIntendedAt > at))
  ))) return fail('invalid_input')
  if (scheduledOccurrence(db, ref, mapping.routineRevision, applied)) return fail('conflict')
  const base = scheduledBase(ref, mapping.title, mapping.routineRevision, applied, at)
  const outcome = !current ? { status: 'skipped', reason: 'stale_revision' } as const
    : mapping.state === 'terminal' ? { status: 'skipped', reason: 'mapping_terminal' } as const
      : skipReason === 'misfire' ? { status: 'skipped', reason: 'misfire' } as const
        : decide(db, routine, base, authority, goalAdmission, wake)
  const occurrence = persistOccurrence(db, { ...base, ...outcome, nativeReceipt: receipt }, mapping.id)
  terminal(db, mapping)
  if (advances) advance(db, routine, nextIntendedAt)
  return { ok: true, occurrence, duplicate: false }
}

export function runRoutineNow(db: DatabaseSync, ref: RoutineRef, input: unknown, wake: Wake): OccurrenceResult {
  const decoded = runRoutineNowSchema.safeParse(input)
  if (!decoded.success || !routineRefSchema.safeParse(ref).success) return fail('invalid_input')
  const { expectedRevision, commandId, at, authority, goalAdmission } = decoded.data
  const previous = db.prepare(`
    SELECT record FROM routine_occurrences WHERE kind = 'manual' AND owner_id = ? AND client_id = ? AND command_id = ?
  `).get(ref.ownerId, authority.clientId, commandId)
  if (previous) {
    const occurrence = decode(previous.record, routineOccurrenceSchema)
    return occurrence.profileId === ref.profileId && occurrence.routineId === ref.routineId
      && occurrence.routineRevision === expectedRevision
      ? { ok: true, occurrence, duplicate: true } : fail('command_conflict')
  }
  const routine = getRoutine(db, ref)
  if (!routine) return fail('not_found')
  if (routine.revision !== expectedRevision) return fail('version_conflict')
  if (routine.status !== 'armed' && routine.status !== 'ended') return fail('invalid_transition')
  if (!sameAuthority(routine.authority, authority) || at < routine.updatedAt) return fail('permission_denied')
  if (!dispatchPermitted(db)) return fail('recovery_required')
  const base = {
    ...ref, title: routine.title, id: `routine-occ-${hash([ref.ownerId, authority.clientId, commandId])}`,
    routineRevision: routine.revision, intendedAt: at, observedAt: at, kind: 'manual' as const,
  }
  const outcome = decide(db, routine, base, authority, goalAdmission, wake)
  const occurrence = persistOccurrence(db, { ...base, ...outcome }, undefined, { clientId: authority.clientId, commandId })
  return { ok: true, occurrence, duplicate: false }
}

/** Trusted adapter lookup before removing an exactly acknowledged native timer. */
export function getRoutineRetirement(db: DatabaseSync, nativeId: string): RoutineNativeReceipt | undefined {
  const row = db.prepare(`
    SELECT m.record AS mapping, o.record AS occurrence FROM routine_mappings m
    JOIN routine_occurrences o ON o.mapping_id = m.id WHERE m.native_id = ? AND m.state = 'terminal'
  `).get(nativeId)
  if (!row) return undefined
  const mapping = decode(row.mapping, routineMappingSchema)
  const occurrence = decode(row.occurrence, routineOccurrenceSchema)
  const receipt = occurrence.nativeReceipt
  if (!receipt || receipt.nativeId !== nativeId || mapping.nativeId !== nativeId
    || mapping.mailboxId !== receipt.targetSessionId || mapping.marker !== receipt.prompt
    || mapping.nativeWakeAt !== receipt.scheduledAt) return corrupt()
  return receipt
}
