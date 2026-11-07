import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { generationSchema, ownerIdSchema, profileIdSchema, taskStatusSchema, utcInstantSchema, versionSchema } from '../domain/model.js'
import { StorageError } from './schema.js'

const auditScopeSchema = z.strictObject({ ownerId: ownerIdSchema, profileId: profileIdSchema })
const auditOptionsSchema = z.strictObject({
  afterSequence: z.int().nonnegative().default(0),
  limit: z.int().min(1).max(500).default(100),
})
const auditTypeSchema = z.enum([
  'work.create', 'work.cancel', 'work.pause', 'work.resume', 'work.retry', 'work.reopen',
  'start', 'wake_worker', 'record_input', 'recover_attempt', 'wait', 'wake', 'ready', 'release_worker', 'verify',
  'fail', 'confirm_cancel', 'reconcile', 'cancel', 'pause', 'resume', 'retry', 'reopen',
])
const auditEventSchema = z.strictObject({
  sequence: z.int().positive(),
  generation: generationSchema,
  version: versionSchema,
  type: auditTypeSchema.or(z.literal('unknown')),
  status: taskStatusSchema,
  occurredAt: utcInstantSchema,
  hasSourceEvent: z.union([z.literal(0), z.literal(1)]).transform(value => value === 1),
})

export type WorkAuditScope = z.input<typeof auditScopeSchema>
export type WorkAuditOptions = z.input<typeof auditOptionsSchema>

const auditCountsSchema = z.strictObject({
  tasks: z.int().nonnegative(), artifacts: z.int().nonnegative(), effects: z.int().nonnegative(),
  deliveries: z.int().nonnegative(), occurrences: z.int().nonnegative(),
})

/** Export an allowlisted chronology and scoped counts without identifiers or record payloads. */
export function exportWorkAudit(db: DatabaseSync, scope: WorkAuditScope, options: WorkAuditOptions = {}) {
  const parsedScope = auditScopeSchema.safeParse(scope)
  const parsedOptions = auditOptionsSchema.safeParse(options)
  if (!parsedScope.success || !parsedOptions.success) {
    throw new StorageError('invalid_input', 'Audit export scope or page is invalid')
  }
  const { ownerId, profileId } = parsedScope.data
  const { afterSequence, limit } = parsedOptions.data
  const rows = db.prepare(`
    SELECT sequence, generation, version, type, status, occurred_at AS occurredAt,
      source_event_id IS NOT NULL AS hasSourceEvent
    FROM work_events WHERE owner_id = ? AND profile_id = ? AND sequence > ?
    ORDER BY sequence LIMIT ?
  `).all(ownerId, profileId, afterSequence, limit + 1)
  const workEvents = rows.slice(0, limit).map(row => {
    const type = auditTypeSchema.safeParse(row.type)
    const result = auditEventSchema.safeParse({ ...row, type: type.success ? type.data : 'unknown' })
    if (!result.success) throw new StorageError('corrupt', 'Stored work audit metadata is invalid')
    return result.data
  })
  const counts = auditCountsSchema.safeParse(db.prepare(`
    SELECT
      (SELECT count(*) FROM tasks WHERE owner_id = $owner AND profile_id = $profile) AS tasks,
      (SELECT count(*) FROM artifacts WHERE owner_id = $owner AND profile_id = $profile) AS artifacts,
      (SELECT count(*) FROM effects e JOIN tasks t ON t.id = e.task_id
        WHERE t.owner_id = $owner AND t.profile_id = $profile) AS effects,
      (SELECT count(*) FROM outbox WHERE owner_id = $owner AND profile_id = $profile) AS deliveries,
      (SELECT count(*) FROM routine_occurrences WHERE owner_id = $owner AND profile_id = $profile) AS occurrences
  `).get({ $owner: ownerId, $profile: profileId }))
  if (!counts.success) throw new StorageError('corrupt', 'Stored work audit counts are invalid')
  return {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    counts: counts.data,
    workEvents,
    nextAfterSequence: rows.length > limit ? workEvents.at(-1)?.sequence : undefined,
  }
}
