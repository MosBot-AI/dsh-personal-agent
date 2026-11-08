import { describe, expect, it, vi } from 'vitest'
import { modelDeploymentSchema, routingPolicyRevisionSchema, type RoutingDecision } from '../../packages/plugin-api/src/model-routing.js'
import { chooseFallback, classifyInferenceFailure, fallbackPolicySchema } from '../../packages/model-routing/src/fallback.js'
import { inspectQuota } from '../../packages/model-routing/src/quota.js'

const now = '2026-11-08T02:00:00.000Z'
const time = Date.parse(now)
const a = { id: 'a', revision: 1 }
const b = { id: 'b', revision: 1 }
const c = { id: 'c', revision: 1 }
const local = { id: 'local', revision: 1 }
const scope = { taskId: 'task', taskAttemptId: 'attempt', generation: 3, acceptanceDigest: 'b'.repeat(64) }
const policy = routingPolicyRevisionSchema.parse({ id: 'policy', revision: 2, mode: 'automatic',
  pools: { fast: [a, b], balanced: [c], deep: [local] }, maxSwitches: 2 })
const prior: Extract<RoutingDecision, { kind: 'dispatch' }> = {
  ...scope, id: 'decision', kind: 'dispatch', policy: { id: 'policy', revision: 2 }, decidedAt: now,
  requirements: { capabilities: ['tools'], dataScope: ['local-data'], inputTokens: 512, outputTokens: 128 },
  excluded: [], deployment: a, effort: 'low', basis: 'rule',
}
function deployment(pin: typeof a, accountId: string, kind: 'network' | 'local' = 'network', contextTokens = 4096) {
  return modelDeploymentSchema.parse({ ...pin, accountId, quotaBucketId: 'shared', provider: pin.id, model: 'model',
    destination: kind === 'local' ? { kind } : { kind, origin: `https://${pin.id}.example.test` },
    capabilities: ['tools'], dataScope: ['local-data'], contextTokens, outputTokens: 512, nativeEfforts: ['basic'],
    effort: { low: { kind: 'provider', id: 'basic' } },
  })
}
const previous = deployment(a, 'shared-account')
const alternate = deployment(c, 'other-account', 'network', 8192)
const fallback = fallbackPolicySchema.parse({ owner: 'core', maxAttempts: 3,
  chains: { 'rate-limit': [b, c], quota: [b, c], budget: [c], context: [b, c] }, terminal: [local] })
const inspect = () => ({ kind: 'ready', incrementalCost: 'paid' }) as const
const options = {
  policy, fallback, prior, previous, visited: [a], candidates: [deployment(b, 'shared-account'), alternate, deployment(local, 'local', 'local')],
  decisionId: 'next', now, inspect,
}

describe('shared quotas and bounded fallback', () => {
  it('distinguishes provider limits, account exhaustion, local budgets, context and authority', () => {
    expect(classifyInferenceFailure({ code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 2000 }, time))
      .toEqual({ reason: 'rate-limit', scope: 'bucket', nextCheckAt: '2026-11-08T02:00:02.000Z' })
    expect(classifyInferenceFailure({ code: 'ACCOUNT_QUOTA', status: 429 }, time)).toEqual({ reason: 'quota', scope: 'account' })
    expect(classifyInferenceFailure({ code: 'budget_exceeded' }, time)).toEqual({ reason: 'budget' })
    expect(classifyInferenceFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }, time)).toEqual({ reason: 'context' })
    expect(classifyInferenceFailure({ code: 'ROUTING_DENIED', status: 403 }, time)).toEqual({ reason: 'authorization' })
    expect(classifyInferenceFailure({ code: 'AUTH', status: 401 }, time)).toEqual({ reason: 'provider-authentication' })
  })

  it('preserves stale and unknown observations and uses bounded rolling usage', () => {
    const bucket = { id: 'bucket', revision: 2, accountId: 'account', requestsPerMinute: 2, tokensPerMinute: 128 }
    const window = { requests: 0, tokens: 0 }
    const base = { bucket, now: time, requestedTokens: 30, window, sinceObservation: window, maxTelemetryAgeMs: 60_000, allowBoundedUnknown: false }
    expect(inspectQuota(base)).toEqual({ kind: 'wait', reason: 'quota-unknown', telemetry: 'unknown' })
    const observation = { bucket, observedAt: '2026-11-08T01:55:00.000Z', provenance: 'provider', status: 'available', remainingTokens: 100 } as const
    expect(inspectQuota({ ...base, observation })).toMatchObject({ kind: 'wait', telemetry: 'stale' })
    expect(inspectQuota({ ...base, observation, allowBoundedUnknown: true })).toEqual({ kind: 'ready', telemetry: 'stale' })
    expect(inspectQuota({ ...base, allowBoundedUnknown: true, window: { requests: 2, tokens: 100, oldestAt: '2026-11-08T01:59:59.000Z' } }))
      .toEqual({ kind: 'wait', reason: 'rate-limit', telemetry: 'unknown', nextCheckAt: '2026-11-08T02:00:59.000Z' })
    expect(inspectQuota({ ...base, observation: { ...observation, observedAt: now }, sinceObservation: { requests: 1, tokens: 80 } }))
      .toEqual({ kind: 'wait', reason: 'quota', telemetry: 'fresh' })
    expect(inspectQuota({ ...base, allowBoundedUnknown: true, block: { reason: 'quota', since: now } }))
      .toEqual({ kind: 'wait', reason: 'quota', telemetry: 'unknown' })
  })

  it('uses the ordered authorized route with the same acceptance, and avoids blocked account aliases and cycles', () => {
    const check = vi.fn(inspect)
    const result = chooseFallback({ ...options, failure: { reason: 'quota', scope: 'account' }, inspect: check })
    expect(result).toMatchObject({ kind: 'fallback', deployment: c, decision: {
      ...scope, id: 'next', basis: 'fallback', requirements: prior.requirements, effort: 'low',
    } })
    expect(check.mock.calls).toHaveLength(1)
    expect(chooseFallback({ ...options, failure: { reason: 'quota', scope: 'account' }, visited: [a, c, local] }))
      .toEqual({ kind: 'wait', reason: 'attempt-limit' })
    expect(chooseFallback({ ...options, failure: { reason: 'authorization' }, inspect: () => { throw new Error('must not inspect') } }))
      .toEqual({ kind: 'stop', reason: 'authorization' })
    expect(chooseFallback({ ...options, fallback: { ...fallback, owner: 'gateway' }, failure: { reason: 'rate-limit' } }))
      .toEqual({ kind: 'wait', reason: 'rate-limit' })
  })

  it('requires zero incremental spend after a hard budget failure and skips destinations without grants', () => {
    expect(chooseFallback({ ...options, failure: { reason: 'budget' } })).toEqual({ kind: 'wait', reason: 'budget' })
    expect(chooseFallback({ ...options, failure: { reason: 'budget' }, inspect: route => ({
      kind: 'ready', incrementalCost: route.id === 'local' ? 'zero' : 'paid',
    }) })).toMatchObject({ kind: 'fallback', deployment: local })
    expect(chooseFallback({ ...options, failure: { reason: 'context' }, inspect: () => ({ kind: 'wait', nextCheckAt: '2026-11-08T02:01:00.000Z' }) }))
      .toEqual({ kind: 'wait', reason: 'context', nextCheckAt: '2026-11-08T02:01:00.000Z' })
  })
})
