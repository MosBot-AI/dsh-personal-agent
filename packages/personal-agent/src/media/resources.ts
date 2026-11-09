import type { DatabaseSync } from 'node:sqlite'
import type { MediaAccess } from '@mosbot-ai/dshpa-plugin-api'
import { z } from 'zod'

export const mediaQueueConfigSchema = z.strictObject({
  maxQueued: z.int().min(1).max(128).default(16),
  maxPerAttempt: z.int().min(1).max(32).default(4),
  pollMs: z.int().min(1000).max(60_000).default(2000),
})

export const holdingLease = "state IN ('submitting', 'unknown', 'rendering', 'collecting')"
export const scopeParams = (scope: MediaAccess) => [scope.ownerId, scope.profileId, scope.taskId, scope.attemptId, scope.generation] as const

export function withinMediaQuota(db: DatabaseSync, scope: MediaAccess, config: z.output<typeof mediaQueueConfigSchema>): boolean {
  const queued = db.prepare("SELECT count(*) AS count FROM media_jobs WHERE state = 'queued'").get()!
  const attempt = db.prepare(`SELECT count(*) AS count FROM media_jobs
    WHERE owner_id = ? AND profile_id = ? AND task_id = ? AND attempt_id = ? AND generation = ?`).get(...scopeParams(scope))!
  return Number(queued.count) < config.maxQueued && Number(attempt.count) < config.maxPerAttempt
}
