import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { capabilityIdSchema } from '@mosbot-ai/dshpa-plugin-api'
import {
  inferenceAttemptSchema, modelDeploymentSchema, quotaBucketSchema, quotaObservationSchema,
  routingDecisionSchema, routingPolicyRevisionSchema, type QuotaBucket, type QuotaObservation,
} from '@mosbot-ai/dshpa-plugin-api/model-routing'
import { inspectQuota, quotaWindowMs, type QuotaAdmission, type QuotaBlock, type QuotaUsage } from '@mosbot-ai/dshpa-model-routing/quota'
import { z } from 'zod'
import { ownerIdSchema, profileIdSchema, utcInstantSchema, versionSchema, type UtcInstant } from '../domain/model.js'
import { claimRoutedBudget, type BudgetService } from '../runtime/budget.js'
import { StorageError, transaction } from './schema.js'
import type { WorkRef } from './store.js'

const failureSchema = z.strictObject({
  reason: z.enum(['rate-limit', 'quota', 'budget', 'context', 'provider-authentication', 'unavailable', 'authorization', 'cancelled', 'rejected']),
  scope: z.enum(['bucket', 'account']).optional(),
  nextCheckAt: utcInstantSchema.optional(),
})
const scopeSchema = z.strictObject({ ownerId: ownerIdSchema, profileId: profileIdSchema })
type Scope = z.infer<typeof scopeSchema>
const attemptId = capabilityIdSchema
const beginSchema = z.strictObject({
  attempt: inferenceAttemptSchema,
  decision: routingDecisionSchema,
  deployment: modelDeploymentSchema,
  bucket: quotaBucketSchema,
  policy: routingPolicyRevisionSchema,
  expectedVersion: versionSchema,
  maxAttempts: z.int().min(1).max(9),
  unattended: z.boolean(),
})
const rowSchema = z.strictObject({
  id: attemptId, decisionId: capabilityIdSchema, seriesId: capabilityIdSchema, previousId: attemptId.nullable(),
  chainId: attemptId, fenceDigest: z.string().regex(/^[a-f0-9]{64}$/u), ordinal: z.int().min(1).max(9),
  taskAttemptId: capabilityIdSchema, generation: z.int().nonnegative(),
  deploymentId: capabilityIdSchema, deploymentRevision: z.int().positive(),
  accountId: capabilityIdSchema, bucketId: capabilityIdSchema, bucketRevision: z.int().positive(),
  budgetId: z.uuid(), status: z.enum(['streaming', 'completed', 'failed', 'interrupted']),
  budgetStatus: z.enum(['claimed', 'settled', 'uncertain']), partial: z.union([z.literal(0), z.literal(1)]),
  failure: z.string().nullable(), createdAt: utcInstantSchema, updatedAt: utcInstantSchema,
})
const select = `
  SELECT a.id, a.decision_id AS decisionId, a.series_id AS seriesId, a.previous_id AS previousId,
    a.chain_id AS chainId, a.fence_digest AS fenceDigest, a.ordinal, a.task_attempt_id AS taskAttemptId,
    a.generation, a.deployment_id AS deploymentId, a.deployment_revision AS deploymentRevision,
    a.account_id AS accountId, a.bucket_id AS bucketId, a.bucket_revision AS bucketRevision,
    a.budget_id AS budgetId, a.status, b.status AS budgetStatus, a.partial, a.failure,
    a.created_at AS createdAt, a.updated_at AS updatedAt
  FROM inference_attempts a JOIN budget_reservations b ON b.id = a.budget_id
  WHERE a.owner_id = ? AND a.profile_id = ? AND a.task_id = ?
`

function readJson<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  if (typeof value === 'string' && value.length <= 8192) {
    try {
      const parsed = schema.safeParse(JSON.parse(value))
      if (parsed.success) return parsed.data
    } catch { /* Corrupt metadata is quarantined by WorkStore. */ }
  }
  throw new StorageError('corrupt', 'Invalid inference ledger metadata')
}

function decode(row: unknown) {
  const parsed = rowSchema.safeParse(row)
  if (!parsed.success) throw new StorageError('corrupt', 'Invalid inference claim record')
  return { ...parsed.data, partial: parsed.data.partial === 1,
    failure: parsed.data.failure === null ? undefined : readJson(failureSchema, parsed.data.failure) }
}
export type StoredInferenceAttempt = ReturnType<typeof decode>

const scopeKey = (scope: Scope) => [scope.ownerId, scope.profileId] as const
const taskKey = (ref: WorkRef) => [...scopeKey(ref), ref.taskId] as const
const samePin = (a: { id: string; revision: number }, b: { id: string; revision: number }) => a.id === b.id && a.revision === b.revision

function read(db: DatabaseSync, ref: WorkRef, id: string): StoredInferenceAttempt | undefined {
  const row = db.prepare(select + ' AND a.id = ?').get(...taskKey(ref), id)
  return row && decode(row)
}

function quotaUse(db: DatabaseSync, scope: Scope, bucket: QuotaBucket, since: string, inclusive: boolean): QuotaUsage {
  const row = db.prepare(`
    SELECT COUNT(*) AS requests, COALESCE(SUM(b.upper_input_tokens + b.upper_output_tokens), 0) AS tokens,
      MIN(a.created_at) AS oldestAt
    FROM inference_attempts a JOIN budget_reservations b ON b.id = a.budget_id
    WHERE a.owner_id = ? AND a.account_id = ? AND a.bucket_id = ?
      AND a.created_at ${inclusive ? '>=' : '>'} ?
  `).get(scope.ownerId, bucket.accountId, bucket.id, since)
  const parsed = z.strictObject({ requests: z.int().nonnegative(), tokens: z.int().nonnegative(), oldestAt: utcInstantSchema.nullable() }).safeParse(row)
  if (!parsed.success) throw new StorageError('corrupt', 'Invalid quota usage aggregate')
  return { ...parsed.data, oldestAt: parsed.data.oldestAt ?? undefined }
}

function readObservation(db: DatabaseSync, scope: Scope, bucket: QuotaBucket): QuotaObservation | undefined {
  const row = db.prepare(`
    SELECT record FROM inference_quota_observations WHERE owner_id = ? AND account_id = ? AND bucket_id = ?
  `).get(scope.ownerId, bucket.accountId, bucket.id)
  return row && readJson(quotaObservationSchema, row.record)
}

function block(db: DatabaseSync, scope: Scope, account: string, bucket: string, value: QuotaBlock): void {
  db.prepare(`
    INSERT INTO inference_quota_blocks (owner_id, account_id, bucket_id, reason, since, next_check_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, account_id, bucket_id) DO UPDATE SET
      reason = excluded.reason, since = excluded.since,
      next_check_at = CASE WHEN excluded.reason = 'rate-limit'
        THEN CASE WHEN inference_quota_blocks.next_check_at IS NULL OR excluded.next_check_at IS NULL THEN NULL
          ELSE MAX(inference_quota_blocks.next_check_at, excluded.next_check_at) END ELSE excluded.next_check_at END
    WHERE inference_quota_blocks.since <= excluded.since AND (inference_quota_blocks.reason <> 'quota' OR excluded.reason = 'quota')
  `).run(scope.ownerId, account, bucket, value.reason, value.since, value.nextCheckAt ?? null)
}

function currentBlock(db: DatabaseSync, scope: Scope, bucket: QuotaBucket, at: UtcInstant): QuotaBlock | undefined {
  const row = db.prepare(`
    SELECT reason, since, next_check_at AS nextCheckAt FROM inference_quota_blocks
    WHERE owner_id = ? AND account_id = ? AND bucket_id IN ('', ?)
      AND (reason = 'quota' OR next_check_at IS NULL OR next_check_at > ?)
    ORDER BY (reason = 'quota') DESC, (next_check_at IS NULL) DESC, next_check_at DESC LIMIT 1
  `).get(scope.ownerId, bucket.accountId, bucket.id, at)
  if (!row) return undefined
  const parsed = z.strictObject({ reason: z.enum(['rate-limit', 'quota']), since: utcInstantSchema, nextCheckAt: utcInstantSchema.nullable() }).safeParse(row)
  if (!parsed.success) throw new StorageError('corrupt', 'Invalid quota block')
  return { ...parsed.data, nextCheckAt: parsed.data.nextCheckAt ?? undefined }
}

export function markColdInferenceAttempts(db: DatabaseSync): void {
  db.prepare("UPDATE inference_attempts SET status = 'interrupted' WHERE status = 'streaming'").run()
}

export function createInferenceLedger(access: <T>(fn: (db: DatabaseSync) => T) => T, budget: BudgetService, options: {
  now?: () => UtcInstant
  allowBoundedUnknown?: boolean
  maxTelemetryAgeMs?: number
} = {}) {
  const maxTelemetryAgeMs = z.int().min(1).max(24 * 60 * 60_000).parse(options.maxTelemetryAgeMs ?? 5 * 60_000)
  const now = () => utcInstantSchema.parse(options.now?.() ?? new Date().toISOString())
  function quota(db: DatabaseSync, scope: Scope, bucket: QuotaBucket, at: UtcInstant, requestedTokens: number): QuotaAdmission {
    const observation = readObservation(db, scope, bucket)
    const window = quotaUse(db, scope, bucket, new Date(Date.parse(at) - quotaWindowMs).toISOString(), false)
    const fresh = observation && samePin(observation.bucket, bucket) && observation.observedAt <= at
      && Date.parse(at) - Date.parse(observation.observedAt) <= maxTelemetryAgeMs
    const sinceObservation = fresh ? quotaUse(db, scope, bucket, observation.observedAt, true) : { requests: 0, tokens: 0 }
    return inspectQuota({ bucket, now: Date.parse(at), requestedTokens, window, sinceObservation, observation,
      block: currentBlock(db, scope, bucket, at), allowBoundedUnknown: options.allowBoundedUnknown === true, maxTelemetryAgeMs })
  }

  return Object.freeze({
    quota(scope: Scope, input: unknown, requestedTokens: number): QuotaAdmission {
      const bucket = quotaBucketSchema.parse(input)
      return access(db => quota(db, scopeSchema.parse(scope), bucket, now(), requestedTokens))
    },

    /** The authenticated provider adapter owns observation provenance and any account-wide reset. */
    recordQuota(scope: Scope, account: string, input: unknown, reset?: 'account' | 'bucket'): boolean {
      const owner = scopeSchema.safeParse(scope)
      const identity = capabilityIdSchema.safeParse(account)
      const parsed = quotaObservationSchema.safeParse(input)
      if (!owner.success || !identity.success || !parsed.success || parsed.data.observedAt > now()) return false
      const observation = parsed.data
      if (reset && (observation.provenance !== 'provider' || observation.status !== 'available'
        || ((observation.remainingRequests ?? 0) < 1 && (observation.remainingTokens ?? 0) < 1))) return false
      return access(db => transaction(db, () => {
        const ids = [owner.data.ownerId, identity.data, observation.bucket.id] as const
        const updated = db.prepare(`
          INSERT INTO inference_quota_observations (owner_id, account_id, bucket_id, observed_at, record)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id, account_id, bucket_id) DO UPDATE
          SET observed_at = excluded.observed_at, record = excluded.record
          WHERE inference_quota_observations.observed_at < excluded.observed_at
        `).run(...ids, observation.observedAt, JSON.stringify(observation))
        if (updated.changes !== 1) return false
        if (observation.provenance === 'provider' && observation.status === 'exhausted') {
          block(db, owner.data, account, observation.bucket.id, { reason: 'quota', since: observation.observedAt, nextCheckAt: observation.resetAt })
        } else if (reset) {
          db.prepare(`
            DELETE FROM inference_quota_blocks WHERE owner_id = ? AND account_id = ?
              AND bucket_id = ? AND since <= ?
          `).run(owner.data.ownerId, account, reset === 'account' ? '' : observation.bucket.id, observation.observedAt)
        }
        return true
      }))
    },

    begin(ref: WorkRef, raw: unknown) {
      const input = beginSchema.safeParse(raw)
      if (!input.success) return { ok: false, code: 'invalid_input' } as const
      const { attempt, decision, deployment, bucket, policy, expectedVersion, maxAttempts, unattended } = input.data
      if (decision.kind !== 'dispatch' || attempt.status !== 'planned'
        || attempt.taskId !== ref.taskId || decision.taskId !== ref.taskId
        || attempt.taskAttemptId !== decision.taskAttemptId || attempt.generation !== decision.generation
        || attempt.decisionId !== decision.id || !samePin(attempt.deployment, deployment) || !samePin(decision.deployment, deployment)
        || !samePin(policy, decision.policy)
        || (policy.mode === 'fixed' ? !samePin(policy.deployment, deployment)
          : !Object.values(policy.pools).some(pool => pool.some(pin => samePin(pin, deployment))))
        || attempt.accountId !== deployment.accountId || attempt.quotaBucketId !== deployment.quotaBucketId
        || deployment.accountId !== bucket.accountId || deployment.quotaBucketId !== bucket.id
        || (attempt.previousAttemptId !== undefined) !== (decision.basis === 'fallback' || decision.basis === 'escalation')) {
        return { ok: false, code: 'invalid_input' } as const
      }
      const { requirements } = decision
      const digest = createHash('sha256').update(JSON.stringify([decision.acceptanceDigest, policy, maxAttempts, unattended,
        { ...requirements, capabilities: [...requirements.capabilities].sort(), dataScope: [...requirements.dataScope].sort() },
      ])).digest('hex')
      let refused: 'active' | 'duplicate' | 'chain' | 'quota' = 'duplicate'
      let quotaWait: Extract<QuotaAdmission, { kind: 'wait' }> | undefined
      const claimed = claimRoutedBudget(budget, {
        ownerId: ref.ownerId, profileId: ref.profileId, provider: deployment.provider, model: deployment.model, unattended,
        task: { taskId: ref.taskId, attemptId: attempt.taskAttemptId, generation: attempt.generation, expectedVersion },
        upperInputTokens: requirements.inputTokens, upperOutputTokens: requirements.outputTokens,
      }, (db, reservation) => {
        if (db.prepare("SELECT 1 FROM inference_attempts WHERE task_id = ? AND status = 'streaming'").get(ref.taskId)) {
          refused = 'active'
          return false
        }
        if (db.prepare(`
          SELECT 1 FROM inference_attempts WHERE id = ? OR (
            task_id = ? AND task_attempt_id = ? AND generation = ? AND (decision_id = ? OR series_id = ?))
        `).get(attempt.id, ref.taskId, attempt.taskAttemptId, attempt.generation, decision.id, attempt.requestSeriesId)) return false

        let ordinal = 1
        let chainId = attempt.id
        if (attempt.previousAttemptId) {
          const prior = read(db, ref, attempt.previousAttemptId)
          if (policy.mode !== 'automatic' || !prior || prior.taskAttemptId !== attempt.taskAttemptId
            || prior.generation !== attempt.generation || prior.fenceDigest !== digest
            || (decision.basis === 'fallback' ? !['failed', 'interrupted'].includes(prior.status) : prior.status !== 'completed')
            || prior.ordinal >= maxAttempts || prior.ordinal > policy.maxSwitches
            || db.prepare('SELECT 1 FROM inference_attempts WHERE chain_id = ? AND ordinal > ?').get(prior.chainId, prior.ordinal)
            || (decision.basis === 'fallback' && db.prepare(`
              SELECT 1 FROM inference_attempts WHERE chain_id = ? AND deployment_id = ?
            `).get(prior.chainId, deployment.id))) {
            refused = 'chain'
            return false
          }
          ordinal = prior.ordinal + 1
          chainId = prior.chainId
        }
        const allowed = quota(db, ref, bucket, reservation.createdAt, requirements.inputTokens + requirements.outputTokens)
        if (allowed.kind === 'wait') {
          refused = 'quota'
          quotaWait = allowed
          return false
        }
        db.prepare(`
          INSERT INTO inference_attempts (id, owner_id, profile_id, task_id, task_attempt_id, generation,
            decision_id, series_id, previous_id, chain_id, fence_digest, ordinal, deployment_id, deployment_revision,
            account_id, bucket_id, bucket_revision, budget_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'streaming', ?, ?)
        `).run(attempt.id, ...taskKey(ref), attempt.taskAttemptId, attempt.generation, decision.id, attempt.requestSeriesId,
          attempt.previousAttemptId ?? null, chainId, digest, ordinal, deployment.id, deployment.revision,
          bucket.accountId, bucket.id, bucket.revision, reservation.id, reservation.createdAt, reservation.createdAt)
        return true
      })
      if (claimed.ok) return { ok: true, reservation: claimed.reservation } as const
      return claimed.code === 'invalid_transition'
        ? { ok: false, code: refused, quota: quotaWait } as const
        : claimed
    },

    get: (ref: WorkRef, id: string) => access(db => read(db, ref, id)),
    history: (ref: WorkRef, id: string) => access(db => {
      const current = read(db, ref, id)
      return current ? db.prepare(select + ' AND a.chain_id = ? ORDER BY a.ordinal LIMIT 9').all(...taskKey(ref), current.chainId).map(decode) : []
    }),
    partial: (ref: WorkRef, id: string) => access(db => db.prepare(`
      UPDATE inference_attempts SET partial = 1, updated_at = MAX(updated_at, ?) WHERE owner_id = ? AND profile_id = ?
        AND task_id = ? AND id = ? AND status = 'streaming'
    `).run(now(), ...taskKey(ref), id).changes === 1),

    finish(ref: WorkRef, id: string, failure?: unknown): boolean {
      const decoded = failureSchema.optional().safeParse(failure)
      if (!decoded.success) return false
      const failed = decoded.data
      const at = now()
      return access(db => transaction(db, () => {
        const row = read(db, ref, id)
        if (!row || row.status !== 'streaming' || row.budgetStatus === 'claimed' || at < row.updatedAt) return false
        const status = !failed ? 'completed' : row.partial || failed.reason === 'cancelled' ? 'interrupted' : 'failed'
        db.prepare("UPDATE inference_attempts SET status = ?, failure = ?, updated_at = ? WHERE id = ?")
          .run(status, failed ? JSON.stringify(failed) : null, at, id)
        if (failed?.reason === 'rate-limit' || failed?.reason === 'quota') {
          block(db, ref, row.accountId, failed.scope === 'account' ? '' : row.bucketId,
            { reason: failed.reason, since: at, nextCheckAt: failed.nextCheckAt })
        }
        return true
      }))
    },
    /** The coordinator verifies the exact provider fee readback before calling this entry point. */
    reconcileFee(ref: WorkRef, id: string, usage: unknown): boolean {
      const row = access(db => read(db, ref, id))
      return row !== undefined && row.budgetStatus === 'uncertain'
        && budget.reconcile({ ownerId: ref.ownerId, profileId: ref.profileId, id: row.budgetId }, usage)
    },
  })
}

export type InferenceLedger = ReturnType<typeof createInferenceLedger>
