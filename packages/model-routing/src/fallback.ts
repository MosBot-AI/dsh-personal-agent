import {
  deploymentPinSchema, type DeploymentPin, type ModelDeployment, type RoutingDecision, type RoutingPolicyRevision,
} from '@mosbot-ai/dshpa-plugin-api/model-routing'
import { z } from 'zod'
import { nextQuotaCheck } from './quota.js'

const reasons = z.enum(['rate-limit', 'quota', 'budget', 'context', 'provider-authentication', 'unavailable'])
type Reroutable = z.infer<typeof reasons>
export type InferenceFailure = {
  readonly reason: Reroutable | 'authorization' | 'cancelled' | 'rejected'
  readonly scope?: 'bucket' | 'account'
  readonly nextCheckAt?: string
}

const chain = z.array(deploymentPinSchema).max(16).refine(pins => new Set(pins.map(pin => pin.id)).size === pins.length)
export const fallbackPolicySchema = z.strictObject({
  owner: z.enum(['core', 'gateway']),
  maxAttempts: z.int().min(1).max(9),
  chains: z.partialRecord(reasons, chain),
  terminal: chain.default([]),
})
export type FallbackPolicy = z.infer<typeof fallbackPolicySchema>
type Facts = { readonly code: string; readonly status?: number; readonly providerRetryAfterMs?: number }
const auth = new Set(['AUTH', 'UNAUTHORIZED', 'FORBIDDEN', 'MISSING_CREDENTIAL', 'MISSING_CREDENTIALS', 'INVALID_CREDENTIAL', 'HTTP_401', 'HTTP_403'])
const unavailable = new Set(['TRANSPORT', 'TIMEOUT', 'NETWORK', 'NETWORK_ERROR', 'STREAM_CLOSED', 'SERVER',
  'SERVER_ERROR', 'NO_ADAPTER', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'])

/** Classify stable provider and Core codes without interpreting model or provider prose. */
export function classifyInferenceFailure(facts: Facts, now: number): InferenceFailure {
  const { code, status, providerRetryAfterMs } = facts
  if (code === 'ROUTING_DENIED' || code === 'PERMISSION_DENIED' || code === 'SAFETY' || code === 'CONTENT_FILTER') {
    return { reason: 'authorization' }
  }
  if (code === 'CANCELLED' || code === 'ABORTED') return { reason: 'cancelled' }
  if (code === 'budget_exceeded' || code === 'pricing_unavailable' || code === 'price_unknown') return { reason: 'budget' }
  if (code === 'CONTEXT_WINDOW_EXCEEDED' || code === 'context_budget_exceeded' || code === 'IMAGE_OFFLOAD_REQUIRED') return { reason: 'context' }
  if (code === 'ACCOUNT_QUOTA') return { reason: 'quota', scope: 'account' }
  if (code === 'QUOTA' || status === 402) return { reason: 'quota', scope: 'bucket' }
  if (code === 'RATE_LIMIT' || code === 'HTTP_429' || status === 429) {
    const delay = providerRetryAfterMs !== undefined && providerRetryAfterMs >= 0 && Number.isFinite(providerRetryAfterMs)
      ? Math.max(1, providerRetryAfterMs) : 60_000
    return { reason: 'rate-limit', scope: 'bucket', nextCheckAt: nextQuotaCheck(now, delay) }
  }
  if (auth.has(code) || status === 401 || status === 403) return { reason: 'provider-authentication' }
  if (unavailable.has(code) || status === 408 || (status !== undefined && status >= 500 && status <= 599)
    || /^HTTP_5\d{2}$/u.test(code)) return { reason: 'unavailable' }
  return { reason: 'rejected' }
}

type Dispatch = Extract<RoutingDecision, { kind: 'dispatch' }>
type Result =
  | { readonly kind: 'fallback'; readonly deployment: ModelDeployment; readonly decision: Dispatch }
  | { readonly kind: 'wait'; readonly reason: InferenceFailure['reason'] | 'attempt-limit'; readonly nextCheckAt?: string }
  | { readonly kind: 'stop'; readonly reason: 'authorization' | 'cancelled' | 'rejected' }
type Admission = { readonly kind: 'ready'; readonly incrementalCost: 'zero' | 'paid' | 'unknown' }
  | { readonly kind: 'wait'; readonly nextCheckAt?: string }

const key = ({ id, revision }: DeploymentPin) => JSON.stringify([id, revision])

/** Select a fresh inference route. Admission is read-only here and must be claimed atomically at dispatch. */
export function chooseFallback(input: {
  readonly failure: InferenceFailure
  readonly policy: RoutingPolicyRevision
  readonly fallback: FallbackPolicy
  readonly prior: Dispatch
  readonly previous: ModelDeployment
  readonly visited: readonly DeploymentPin[]
  readonly candidates: readonly ModelDeployment[]
  readonly decisionId: string
  readonly now: string
  /** Core verifies the destination grant, quota, compatible route and live budget for this Task. */
  readonly inspect: (deployment: ModelDeployment, prior: Dispatch) => Admission
}): Result {
  const { failure, policy, fallback, prior, previous, visited } = input
  const reason = failure.reason
  if (reason === 'authorization' || reason === 'cancelled' || reason === 'rejected') return { kind: 'stop', reason }
  const nextCheck = (value?: string) => value !== undefined && value > input.now ? value : undefined
  let nextCheckAt = nextCheck(failure.nextCheckAt)
  const wait = (cause: Extract<Result, { kind: 'wait' }>['reason'] = reason): Result =>
    ({ kind: 'wait', reason: cause, ...(nextCheckAt === undefined ? {} : { nextCheckAt }) })
  if (fallback.owner !== 'core' || policy.mode !== 'automatic' || prior.basis === 'override' || prior.basis === 'fixed'
    || key(prior.policy) !== key(policy) || key(prior.deployment) !== key(previous)
    || !visited.some(pin => key(pin) === key(previous)) || prior.id === input.decisionId) return wait()
  if (visited.length >= fallback.maxAttempts || visited.length > policy.maxSwitches) return wait('attempt-limit')

  const configured = new Set(Object.values(policy.pools).flat().map(key))
  const seen = new Set(visited.map(pin => pin.id))
  const choices = [
    ...(fallback.chains[reason] ?? []).map(pin => ({ pin, terminal: false })),
    ...fallback.terminal.map(pin => ({ pin, terminal: true })),
  ]
  const { requirements, effort } = prior
  for (const { pin, terminal } of choices) {
    if (seen.has(pin.id) || !configured.has(key(pin))) continue
    seen.add(pin.id)
    const deployment = input.candidates.find(candidate => key(candidate) === key(pin))
    if (!deployment || (terminal && deployment.destination.kind !== 'local')
      || (deployment.provider === previous.provider && deployment.model === previous.model && deployment.accountId === previous.accountId)
      || (reason === 'quota' && deployment.accountId === previous.accountId
        && (failure.scope === 'account' || deployment.quotaBucketId === previous.quotaBucketId))
      || (reason === 'rate-limit' && deployment.accountId === previous.accountId && deployment.quotaBucketId === previous.quotaBucketId)
      || (reason === 'provider-authentication' && deployment.accountId === previous.accountId)
      || (reason === 'context' && deployment.contextTokens <= previous.contextTokens)
      || requirements.outputTokens > deployment.outputTokens
      || requirements.inputTokens + requirements.outputTokens > deployment.contextTokens
      || !requirements.capabilities.every(value => deployment.capabilities.includes(value))
      || !requirements.dataScope.every(value => deployment.dataScope.includes(value))) continue
    const mapped = effort === undefined ? undefined : deployment.effort[effort]
    if (effort !== undefined && (!mapped || mapped.kind === 'thinking-budget')) continue
    let admitted: Admission
    try { admitted = input.inspect(structuredClone(deployment), structuredClone(prior)) } catch { continue }
    if (admitted.kind === 'wait') {
      const time = nextCheck(admitted.nextCheckAt)
      if (time && (!nextCheckAt || time < nextCheckAt)) nextCheckAt = time
      continue
    }
    if ((terminal || reason === 'budget') && admitted.incrementalCost !== 'zero') continue
    return { kind: 'fallback', deployment, decision: { ...prior, id: input.decisionId, decidedAt: input.now,
      deployment: { id: pin.id, revision: pin.revision }, basis: 'fallback' } }
  }
  return wait()
}
