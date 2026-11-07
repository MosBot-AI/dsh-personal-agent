import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  attemptIdSchema, generationSchema, nonEmptyTextSchema, sessionIdSchema, sha256DigestSchema, taskIdSchema,
  utcInstantSchema, workerCursorSchema, WORKER_INPUT_LIMIT, type UtcInstant,
} from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import { StorageError } from '../storage/schema.js'
import type { WorkRef } from '../storage/store.js'
import { workerReportInstructions } from './reports.js'

const MAX_CONTENT_BYTES = 80 * 1024
const inputStatusSchema = z.enum(['intent', 'flushed', 'pending', 'admitted', 'cancelled', 'not_delivered', 'unknown'])
const intentSchema = z.strictObject({
  taskId: taskIdSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  cursor: workerCursorSchema,
  sessionId: sessionIdSchema,
  messageId: z.string().regex(/^dshpa-input-[a-f0-9]{64}$/u),
  digest: sha256DigestSchema,
  content: nonEmptyTextSchema.refine(text => Buffer.byteLength(text) <= MAX_CONTENT_BYTES),
  kind: z.enum(['followup', 'steer']),
})
const journalSchema = intentSchema.extend({
  status: inputStatusSchema,
  flushedAt: utcInstantSchema.optional(),
  observedAt: utcInstantSchema.optional(),
})

export type WorkerInputIntent = z.infer<typeof intentSchema>
export type JournaledWorkerInput = z.infer<typeof journalSchema>
export type InputObservation = 'pending' | 'admitted' | 'cancelled' | 'missing' | 'unknown'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function makeWorkerInput(
  state: WorkState,
  sessionId: WorkerInputIntent['sessionId'],
  input: { cursor: string; text: string },
  kind: WorkerInputIntent['kind'],
): WorkerInputIntent {
  const key = JSON.stringify([state.task.ownerId, state.task.profileId, state.task.id, state.attempt.id,
    state.attempt.generation, input.cursor])
  const content = `${workerReportInstructions(input.cursor)}\n\n${input.text}`
  return intentSchema.parse({
    taskId: state.task.id, attemptId: state.attempt.id, generation: state.attempt.generation,
    cursor: input.cursor, sessionId, messageId: `dshpa-input-${sha256(key)}`, digest: sha256(content), content, kind,
  })
}

export function insertWorkerInput(db: DatabaseSync, state: WorkState, input: WorkerInputIntent): void {
  const parsed = intentSchema.safeParse(input)
  if (!parsed.success || input.taskId !== state.task.id || input.attemptId !== state.attempt.id
    || input.generation !== state.task.generation || input.generation !== state.attempt.generation
    || input.sessionId !== state.attempt.sessionId || input.cursor !== state.attempt.worker?.inputCursor
    || sha256(input.content) !== input.digest) throw new StorageError('stale_attempt', 'Worker input does not match the current attempt')
  db.prepare(`
    INSERT INTO worker_inputs (task_id, attempt_id, generation, cursor, session_id, message_id, digest, content, kind, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent')
  `).run(input.taskId, input.attemptId, input.generation, input.cursor, input.sessionId,
    input.messageId, input.digest, input.content, input.kind)
}

export function acknowledgeWorkerInput(db: DatabaseSync, ref: WorkRef, input: WorkerInputIntent, at: UtcInstant): boolean {
  const result = db.prepare(`
    UPDATE worker_inputs SET status = 'flushed', flushed_at = ?, observed_at = ?
    WHERE task_id = ? AND attempt_id = ? AND generation = ? AND cursor = ? AND status = 'intent'
      AND session_id = ? AND message_id = ? AND digest = ?
      AND EXISTS (
        SELECT 1 FROM tasks t WHERE t.id = worker_inputs.task_id
          AND t.owner_id = ? AND t.profile_id = ? AND t.attempt_id = worker_inputs.attempt_id
          AND t.generation = worker_inputs.generation AND (t.record ->> '$.status') = 'running'
      )
  `).run(at, at, ref.taskId, input.attemptId, input.generation, input.cursor, input.sessionId,
    input.messageId, input.digest, ref.ownerId, ref.profileId)
  return result.changes === 1
}

export function readWorkerInputs(db: DatabaseSync, ref: WorkRef, attemptId: WorkerInputIntent['attemptId']): JournaledWorkerInput[] {
  const rows = db.prepare(`
    SELECT i.task_id AS taskId, i.attempt_id AS attemptId, i.generation, i.cursor, i.session_id AS sessionId,
      i.message_id AS messageId, i.digest, i.content, i.kind, i.status,
      i.flushed_at AS flushedAt, i.observed_at AS observedAt
    FROM worker_inputs i JOIN tasks t ON t.id = i.task_id
    WHERE t.id = ? AND t.owner_id = ? AND t.profile_id = ? AND i.attempt_id = ?
    ORDER BY i.rowid LIMIT ?
  `).all(ref.taskId, ref.ownerId, ref.profileId, attemptId, WORKER_INPUT_LIMIT + 1)
  if (rows.length > WORKER_INPUT_LIMIT) throw new StorageError('corrupt', 'Worker input journal exceeds its attempt limit')
  return rows.map(row => {
    const parsed = journalSchema.safeParse({
      ...row, flushedAt: row.flushedAt ?? undefined, observedAt: row.observedAt ?? undefined,
    })
    if (!parsed.success || sha256(parsed.data.content) !== parsed.data.digest) {
      throw new StorageError('corrupt', 'Worker input journal failed integrity validation')
    }
    return parsed.data
  })
}

export function recordInputObservation(
  db: DatabaseSync, ref: WorkRef, input: JournaledWorkerInput, observation: InputObservation, at: UtcInstant,
): boolean {
  // New inputs cannot enter a provider before the durable flush acknowledgment.
  // An acknowledged input missing from the cold log is still ambiguous.
  const status = observation === 'missing' ? (input.status === 'intent' ? 'not_delivered' : 'unknown') : observation
  const result = db.prepare(`
    UPDATE worker_inputs SET status = ?, observed_at = ?
    WHERE task_id = ? AND attempt_id = ? AND generation = ? AND cursor = ? AND status = ?
      AND session_id = ? AND message_id = ? AND digest = ?
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = worker_inputs.task_id AND t.owner_id = ? AND t.profile_id = ?)
  `).run(status, at, ref.taskId, input.attemptId, input.generation, input.cursor, input.status, input.sessionId,
    input.messageId, input.digest, ref.ownerId, ref.profileId)
  return result.changes === 1
}
