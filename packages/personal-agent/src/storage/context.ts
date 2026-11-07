import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { readScopedArtifact } from '../artifacts/store.js'
import {
  checkpointCaptureSchema, contextCheckpointSchema, contextEvidencePointerSchema, contextExclusionSchema,
  contextPointerId, contextPointerKey, MAX_CHECKPOINT_BYTES, MAX_CHECKPOINT_POINTERS,
  type CheckpointCaptureResult, type ContextCheckpoint, type ContextEvidencePointer, type ContextExclusionResult,
  type ContextPointer,
} from '../context/checkpoint.js'
import {
  artifactIdSchema, generationSchema, sessionIdSchema, sourceEventIdSchema, sourceEventSchema, utcInstantSchema,
  type ArtifactId, type AttemptId, type SessionId, type SourceEvent, type SourceEventId, type Task, type UtcInstant,
} from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import { readWorkerInputContext, WORKER_CONTEXT_SOURCE_LIMIT, workerContextSourceIdsSchema } from '../runtime/input-journal.js'
import { recoveryMode } from './recovery-state.js'
import { getRoutingEvent, getSubscription } from './routing.js'
import { StorageError } from './schema.js'
import type { WorkRef } from './store.js'

const pointerPageSchema = z.strictObject({
  kind: z.enum(['event', 'artifact']),
  limit: z.int().min(1).max(64).default(16),
  after: z.int().positive().optional(),
  at: utcInstantSchema.optional(),
})
export type ContextPointerPage = z.input<typeof pointerPageSchema>

function corrupt(): never {
  throw new StorageError('corrupt', 'Stored context record failed validation')
}

function boundedJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value)
    return json !== undefined && Buffer.byteLength(json) <= MAX_CHECKPOINT_BYTES ? json : undefined
  } catch {
    return undefined
  }
}

function parseStored<T>(raw: unknown, schema: z.ZodType<T>): T {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_CHECKPOINT_BYTES) return corrupt()
  try {
    return schema.parse(JSON.parse(raw))
  } catch {
    return corrupt()
  }
}

function workRef(task: Task) {
  return { ownerId: task.ownerId, profileId: task.profileId, taskId: task.id }
}

function membership(db: DatabaseSync, task: Task, id: SourceEventId) {
  const routed = getRoutingEvent(db, { ownerId: task.ownerId, profileId: task.profileId, eventId: id })
  if (routed) {
    const { event, receipt } = routed
    if (receipt.projectId !== task.projectId) return undefined
    if (receipt.disposition.kind === 'context' && receipt.disposition.taskIds?.includes(task.id)) {
      return { event, receipt, mode: 'context' } as const
    }
    if (receipt.delivery?.taskId === task.id && receipt.delivery.projectId === task.projectId) {
      return { event, receipt, mode: 'work' } as const
    }
    return undefined
  }
  const row = db.prepare(`
    SELECT s.record FROM source_events s
    WHERE s.id = ? AND s.owner_id = ? AND s.profile_id = ?
      AND EXISTS (SELECT 1 FROM work_events w WHERE w.task_id = ? AND w.source_event_id = s.id)
  `).get(id, task.ownerId, task.profileId, task.id)
  if (!row) return undefined
  const event = parseStored(row.record, sourceEventSchema)
  if (event.id !== id || event.ownerId !== task.ownerId || event.profileId !== task.profileId) return corrupt()
  return { event }
}

export function isContextExcluded(db: DatabaseSync, task: Task, pointer: ContextEvidencePointer): boolean {
  return db.prepare(`
    SELECT 1 FROM context_exclusions WHERE task_id = ? AND owner_id = ? AND profile_id = ?
      AND subject_kind = ? AND subject_id = ?
  `).get(task.id, task.ownerId, task.profileId, pointer.kind, contextPointerId(pointer)) !== undefined
}

export function getContextSource(db: DatabaseSync, task: Task, id: SourceEventId, at: UtcInstant): SourceEvent | undefined {
  if (isContextExcluded(db, task, { kind: 'event', eventId: id })) return undefined
  const found = membership(db, task, id)
  if (!found || found.event.receivedAt > at) return undefined
  if (!found.receipt) return found.event
  const { event, receipt, mode } = found
  if (event.actor.accountId === undefined || event.threadId === undefined) return corrupt()
  const subscription = getSubscription(db, {
    ...workRef(task), sourceInstanceId: event.sourceInstanceId, accountId: event.actor.accountId, threadId: event.threadId,
  })
  if (!subscription?.enabled || subscription.mode !== mode || subscription.projectId !== task.projectId
    || subscription.authority.policyVersion !== receipt.authority.policyVersion
    || subscription.authority.verifiedAt !== receipt.authority.verifiedAt
    || (receipt.delivery !== undefined && subscription.version !== receipt.delivery.subscriptionVersion)
    || subscription.updatedAt > event.occurredAt || (subscription.expiresAt !== undefined && at >= subscription.expiresAt)) {
    return undefined
  }
  return event
}

export function workerInputContextAvailable(db: DatabaseSync, task: Task, raw: unknown, at: UtcInstant,
  pendingRoute?: SourceEventId): boolean {
  const sources = workerContextSourceIdsSchema.optional().safeParse(raw)
  return sources.success && (sources.data?.every(id => id === pendingRoute
    ? !isContextExcluded(db, task, { kind: 'event', eventId: id })
    : getContextSource(db, task, id, at) !== undefined) ?? true)
}

/** Recover every source that might still be visible in the exact Attempt's native history. */
export function workerContextSources(db: DatabaseSync, ref: WorkRef, attemptId: AttemptId): SourceEventId[] | undefined {
  const attempt = db.prepare(`
    SELECT a.generation, (a.record ->> '$.sessionId') AS sessionId, json_type(a.record, '$.worker') AS workerType,
      (t.record -> '$.provenance.sourceEventIds') AS taskSources
    FROM tasks t JOIN attempts a ON a.task_id = t.id
    WHERE t.id = ? AND t.owner_id = ? AND t.profile_id = ? AND a.id = ?
  `).get(ref.taskId, ref.ownerId, ref.profileId, attemptId)
  if (!attempt) return undefined
  const generation = generationSchema.safeParse(attempt.generation)
  const session = sessionIdSchema.optional().safeParse(attempt.sessionId ?? undefined)
  if (!generation.success || !session.success || (attempt.workerType !== null && attempt.workerType !== 'object')) return corrupt()
  const journal = readWorkerInputContext(db, ref, attemptId, generation.data, session.data)
  if (!journal) return undefined
  if ((attempt.workerType === 'object') !== (journal.inputCount > 0)) return corrupt()
  const { sources } = journal
  function merge(ids: readonly unknown[]): boolean {
    for (const raw of ids) {
      const id = sourceEventIdSchema.safeParse(raw)
      if (!id.success) return corrupt()
      if (id.data.length > 512) return false
      sources.add(id.data)
      if (sources.size > WORKER_CONTEXT_SOURCE_LIMIT) return false
    }
    return true
  }
  if (!merge(parseStored(attempt.taskSources, z.array(sourceEventIdSchema)))) return undefined
  const routed = db.prepare(`
    SELECT d.event_id AS sourceId FROM routing_deliveries d JOIN worker_inputs i
      ON i.task_id = d.task_id AND i.attempt_id = d.attempt_id AND i.generation = d.generation AND i.cursor = d.cursor
    WHERE d.task_id = ? AND d.attempt_id = ? AND d.generation = ? AND i.status NOT IN ('cancelled', 'not_delivered')
    ORDER BY d.event_id LIMIT ?
  `).all(ref.taskId, attemptId, generation.data, WORKER_CONTEXT_SOURCE_LIMIT + 1)
  if (!merge(routed.map(row => row.sourceId))) return undefined
  if (journal.legacy) {
    const legacy = db.prepare(`
      SELECT DISTINCT w.source_event_id AS sourceId FROM work_events w
      WHERE w.task_id = ? AND w.attempt_id = ? AND w.generation = ? AND w.source_event_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM routing_deliveries d JOIN worker_inputs i
            ON i.task_id = d.task_id AND i.attempt_id = d.attempt_id AND i.generation = d.generation AND i.cursor = d.cursor
          WHERE d.event_id = w.source_event_id AND d.task_id = w.task_id AND d.task_version = w.version
            AND i.status IN ('cancelled', 'not_delivered')
        )
      ORDER BY w.source_event_id LIMIT ?
    `).all(ref.taskId, attemptId, generation.data, WORKER_CONTEXT_SOURCE_LIMIT + 1)
    if (!merge(legacy.map(row => row.sourceId))) return undefined
  }
  // Policy consumers must recheck even excluded or revoked IDs from history.
  return [...sources].sort()
}

export function getContextArtifact(db: DatabaseSync, task: Task, id: ArtifactId, at: UtcInstant) {
  if (isContextExcluded(db, task, { kind: 'artifact', artifactId: id })) return undefined
  const sealed = readScopedArtifact(db, workRef(task), id)
  return sealed?.artifact.provenance.sourceEventIds.every(sourceId => getContextSource(db, task, sourceId, at) !== undefined)
    ? sealed : undefined
}

export function listContextPointers(db: DatabaseSync, task: Task, rawPage: ContextPointerPage, now: UtcInstant):
  { items: ContextEvidencePointer[]; nextAfter?: number } {
  const page = pointerPageSchema.safeParse(rawPage)
  if (!page.success) throw new StorageError('invalid_input', 'Context pointer page is invalid')
  const { kind, limit, after, at = now } = page.data
  const rows = kind === 'event' ? db.prepare(`
    SELECT s.id, s.rowid AS position FROM source_events s
    WHERE s.owner_id = ? AND s.profile_id = ? AND (? IS NULL OR s.rowid < ?)
      AND NOT EXISTS (SELECT 1 FROM context_exclusions x WHERE x.task_id = ? AND x.subject_kind = 'event' AND x.subject_id = s.id)
      AND (
        EXISTS (SELECT 1 FROM work_events w WHERE w.task_id = ? AND w.source_event_id = s.id)
        OR EXISTS (
          SELECT 1 FROM routing_receipts r LEFT JOIN routing_deliveries d ON d.event_id = r.event_id
          WHERE r.event_id = s.id AND r.project_id = ? AND (
            d.task_id = ? OR (r.kind = 'context' AND EXISTS (
              SELECT 1 FROM json_each(r.disposition, '$.taskIds') WHERE value = ?
            ))
          )
        )
      )
    ORDER BY s.rowid DESC LIMIT ?
  `).all(task.ownerId, task.profileId, after ?? null, after ?? null, task.id, task.id, task.projectId, task.id, task.id, limit + 1)
    : db.prepare(`
      SELECT a.id, a.rowid AS position FROM artifacts a WHERE a.task_id = ? AND a.owner_id = ? AND a.profile_id = ?
        AND (? IS NULL OR a.rowid < ?) AND NOT EXISTS (
          SELECT 1 FROM context_exclusions x WHERE x.task_id = a.task_id AND x.subject_kind = 'artifact' AND x.subject_id = a.id
        )
      ORDER BY a.rowid DESC LIMIT ?
    `).all(task.id, task.ownerId, task.profileId, after ?? null, after ?? null, limit + 1)
  const scanned = rows.slice(0, limit)
  const items: ContextEvidencePointer[] = []
  for (const row of scanned) {
    if (kind === 'event') {
      const id = sourceEventIdSchema.safeParse(row.id)
      if (!id.success) return corrupt()
      if (getContextSource(db, task, id.data, at)) items.push({ kind, eventId: id.data })
    } else {
      const id = artifactIdSchema.safeParse(row.id)
      if (!id.success) return corrupt()
      items.push({ kind, artifactId: id.data })
    }
  }
  if (rows.length <= limit) return { items }
  const position = scanned.at(-1)?.position
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1) return corrupt()
  return { items, nextAfter: position }
}

export function excludeContextPointer(db: DatabaseSync, task: Task, rawPointer: unknown, rawExclusion: unknown): ContextExclusionResult {
  const pointer = contextEvidencePointerSchema.safeParse(rawPointer)
  const exclusion = contextExclusionSchema.safeParse(rawExclusion)
  if (!pointer.success || !exclusion.success) return { ok: false, code: 'invalid_input' }
  const id = contextPointerId(pointer.data)
  const subject = [task.id, task.ownerId, task.profileId, pointer.data.kind, id] as const
  const existing = db.prepare(`
    SELECT kind, excluded_at AS at FROM context_exclusions WHERE task_id = ? AND owner_id = ? AND profile_id = ?
      AND subject_kind = ? AND subject_id = ?
  `).get(...subject)
  if (existing) {
    const prior = contextExclusionSchema.safeParse(existing)
    if (!prior.success) return corrupt()
    if (prior.data.kind === 'forgotten' || prior.data.kind === exclusion.data.kind) {
      return { ok: true, exclusion: prior.data, replayed: true }
    }
    if (exclusion.data.at < prior.data.at) return { ok: false, code: 'version_conflict' }
    db.prepare(`
      UPDATE context_exclusions SET kind = 'forgotten', excluded_at = ? WHERE task_id = ? AND owner_id = ? AND profile_id = ?
        AND subject_kind = ? AND subject_id = ?
    `).run(exclusion.data.at, ...subject)
  } else {
    const exists = pointer.data.kind === 'event' ? membership(db, task, pointer.data.eventId) !== undefined
      : db.prepare('SELECT 1 FROM artifacts WHERE task_id = ? AND owner_id = ? AND profile_id = ? AND id = ?')
        .get(task.id, task.ownerId, task.profileId, pointer.data.artifactId) !== undefined
    if (!exists) return { ok: false, code: 'source_unavailable' }
    db.prepare(`
      INSERT INTO context_exclusions (task_id, owner_id, profile_id, subject_kind, subject_id, kind, excluded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(...subject, exclusion.data.kind, exclusion.data.at)
  }
  return { ok: true, exclusion: exclusion.data, replayed: false }
}

function checkpointRow(db: DatabaseSync, state: WorkState, sessionId: SessionId): ContextCheckpoint | undefined {
  const { task, attempt } = state
  const row = db.prepare(`
    SELECT record FROM context_checkpoints WHERE task_id = ? AND owner_id = ? AND profile_id = ? AND attempt_id = ?
      AND generation = ? AND session_id = ? ORDER BY revision DESC LIMIT 1
  `).get(task.id, task.ownerId, task.profileId, attempt.id, attempt.generation, sessionId)
  if (!row) return undefined
  const checkpoint = parseStored(row.record, contextCheckpointSchema)
  if (checkpoint.projectId !== task.projectId || checkpoint.taskVersion > task.version) return corrupt()
  return checkpoint
}

function availablePointers(db: DatabaseSync, task: Task, at: UtcInstant) {
  const cache = new Map<string, boolean>()
  return (pointer: ContextPointer): boolean => {
    const key = contextPointerKey(pointer)
    if (!cache.has(key)) {
      const available = pointer.kind === 'task' ? pointer.taskId === task.id
        : pointer.kind === 'event' ? getContextSource(db, task, pointer.eventId, at) !== undefined
        : getContextArtifact(db, task, pointer.artifactId, at) !== undefined
      cache.set(key, available)
    }
    return cache.get(key) === true
  }
}

function visible(checkpoint: ContextCheckpoint, available: (pointer: ContextPointer) => boolean): ContextCheckpoint {
  return { ...checkpoint,
    decisions: checkpoint.decisions.filter(decision => decision.sources.every(available)),
    questions: checkpoint.questions.filter(question => question.sources.every(available)),
    pointers: checkpoint.pointers.filter(available),
  }
}

export function getLatestContextCheckpoint(db: DatabaseSync, state: WorkState, sessionId: SessionId, at: UtcInstant) {
  const checkpoint = checkpointRow(db, state, sessionId)
  return checkpoint && visible(checkpoint, availablePointers(db, state.task, at))
}

/** Caller resolves the scoped work and session in the same write transaction. */
export function captureContextCheckpoint(db: DatabaseSync, state: WorkState, enrolled: (sessionId: SessionId) => boolean,
  input: unknown): CheckpointCaptureResult {
  if (boundedJson(input) === undefined) return { ok: false, code: 'invalid_input' }
  const parsed = checkpointCaptureSchema.safeParse(input)
  if (!parsed.success) return { ok: false, code: 'invalid_input' }
  if (recoveryMode(db) === 'restore') return { ok: false, code: 'recovery_required' }
  const { sessionId, compactionId, attemptId, generation, expectedVersion, at, nativeSeq } = parsed.data
  const { task, attempt } = state
  if (attempt.id !== attemptId || attempt.generation !== generation || task.generation !== generation) {
    return { ok: false, code: 'stale_attempt' }
  }
  if (expectedVersion !== task.version || at < task.updatedAt) return { ok: false, code: 'version_conflict' }
  if (!enrolled(sessionId)) return { ok: false, code: 'not_found' }
  const digest = createHash('sha256').update(JSON.stringify({ ...parsed.data, at: undefined })).digest('hex')
  const available = availablePointers(db, task, at)
  const existing = db.prepare(`
    SELECT request_digest, record FROM context_checkpoints WHERE task_id = ? AND owner_id = ? AND profile_id = ?
      AND session_id = ? AND compaction_id = ?
  `).get(task.id, task.ownerId, task.profileId, sessionId, compactionId)
  if (existing) {
    if (existing.request_digest !== digest) return { ok: false, code: 'checkpoint_conflict' }
    const checkpoint = parseStored(existing.record, contextCheckpointSchema)
    if (checkpoint.projectId !== task.projectId || checkpoint.taskVersion !== task.version || checkpoint.attemptId !== attempt.id
      || checkpoint.generation !== generation) return corrupt()
    return { ok: true, checkpoint: visible(checkpoint, available), replayed: true }
  }
  const explicit = [...(parsed.data.pointers ?? []), ...(parsed.data.decisions ?? []).flatMap(decision => decision.sources),
    ...(parsed.data.questions ?? []).flatMap(question => question.sources)]
  if (new Set(explicit.map(contextPointerKey)).size > MAX_CHECKPOINT_POINTERS) return { ok: false, code: 'invalid_input' }
  if (!explicit.every(available)) return { ok: false, code: 'source_unavailable' }
  const previous = checkpointRow(db, state, sessionId)
  const revision = (previous?.revision ?? 0) + 1
  if (!Number.isSafeInteger(revision) || (previous && at < previous.createdAt)) return { ok: false, code: 'version_conflict' }
  const decisions = parsed.data.decisions ?? previous?.decisions.filter(decision => decision.sources.every(available)) ?? []
  const questions = parsed.data.questions ?? previous?.questions.filter(question => question.sources.every(available)) ?? []
  const automatic: ContextPointer[] = [
    ...task.provenance.sourceEventIds.slice(0, MAX_CHECKPOINT_POINTERS).map(eventId => ({ kind: 'event', eventId } as const)),
    ...attempt.artifactIds.slice(0, MAX_CHECKPOINT_POINTERS).map(artifactId => ({ kind: 'artifact', artifactId } as const)),
    ...listContextPointers(db, task, { kind: 'event', limit: 8, at }, at).items,
  ]
  const unique = new Map<string, ContextPointer>()
  for (const pointer of [{ kind: 'task', taskId: task.id } as const, ...(parsed.data.pointers ?? [])]) {
    unique.set(contextPointerKey(pointer), pointer)
  }
  if (unique.size > MAX_CHECKPOINT_POINTERS) return { ok: false, code: 'invalid_input' }
  for (const pointer of [...(previous?.pointers ?? []), ...automatic]) {
    if (unique.size === MAX_CHECKPOINT_POINTERS) break
    if (available(pointer)) unique.set(contextPointerKey(pointer), pointer)
  }
  const id = createHash('sha256').update(JSON.stringify([task.ownerId, task.profileId, task.id, sessionId, compactionId])).digest('hex')
  const checkpoint = contextCheckpointSchema.parse({
    ...workRef(task), id, revision, sessionId, compactionId, attemptId, generation, projectId: task.projectId,
    taskVersion: task.version, createdAt: at, objective: task.requestedOutcome, constraints: task.constraints,
    acceptance: task.acceptance, decisions, questions, pointers: [...unique.values()],
    ...(nativeSeq === undefined ? {} : { nativeSeq }), ...(task.wait === undefined ? {} : { wait: task.wait }),
  })
  const record = boundedJson(checkpoint)
  if (record === undefined) return { ok: false, code: 'invalid_input' }
  db.prepare('INSERT INTO context_checkpoints (id, request_digest, record) VALUES (?, ?, ?)').run(id, digest, record)
  return { ok: true, checkpoint, replayed: false }
}
