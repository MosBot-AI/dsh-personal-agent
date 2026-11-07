import type { DatabaseSync } from 'node:sqlite'
import { StorageError } from './schema.js'

export type RecoveryMode = 'normal' | 'reconciling' | 'restore'

export function recoveryMode(db: DatabaseSync): RecoveryMode {
  const row = db.prepare('SELECT mode FROM runtime_recovery WHERE id = 1').get()
  if (row?.mode === 'normal' || row?.mode === 'reconciling' || row?.mode === 'restore') return row.mode
  throw new StorageError('corrupt', 'Invalid runtime recovery mode')
}

/** Identify work that has not yet been fenced or classified after a cold open. */
function needsClassification(db: DatabaseSync): boolean {
  return db.prepare(`
    SELECT 1 WHERE
      EXISTS (
        SELECT 1 FROM tasks t JOIN attempts a ON a.task_id = t.id AND a.id = t.attempt_id
        WHERE json_type(a.record, '$.worker') = 'object'
          AND (
            (t.record ->> '$.status') = 'cancelling'
            OR (
              (a.record ->> '$.worker.releasedAt') IS NULL
              AND (t.record ->> '$.status') IN (
                'queued', 'running', 'verifying', 'paused', 'waiting_input',
                'waiting_approval', 'waiting_event', 'waiting_environment', 'waiting_resource', 'blocked'
              )
            )
          )
      )
      OR EXISTS (SELECT 1 FROM worker_inputs WHERE status IN ('intent', 'flushed'))
      OR EXISTS (SELECT 1 FROM effects WHERE (record ->> '$.status') = 'dispatching')
      OR EXISTS (SELECT 1 FROM outbox WHERE (record ->> '$.status') = 'dispatching')
  `).get() !== undefined
}

/** Called under the process writer guard before a new store is exposed. */
export function markStartupRecovery(db: DatabaseSync): void {
  if (recoveryMode(db) === 'normal' && needsClassification(db)) {
    db.prepare("UPDATE runtime_recovery SET mode = 'reconciling' WHERE id = 1 AND mode = 'normal'").run()
  }
}

export function dispatchPermitted(db: DatabaseSync): boolean {
  const mode = recoveryMode(db)
  if (mode === 'restore') return false
  if (mode === 'normal') return true
  if (needsClassification(db)) return false
  // A restored snapshot can never be reopened by the ordinary startup check.
  db.prepare("UPDATE runtime_recovery SET mode = 'normal' WHERE id = 1 AND mode = 'reconciling'").run()
  return true
}
