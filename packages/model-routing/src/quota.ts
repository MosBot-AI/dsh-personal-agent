import type { QuotaBucket, QuotaObservation } from '@mosbot-ai/dshpa-plugin-api/model-routing'

export const quotaWindowMs = 60_000
export type QuotaFreshness = 'fresh' | 'stale' | 'unknown'
export interface QuotaUsage {
  readonly requests: number
  readonly tokens: number
  readonly oldestAt?: string
}
export interface QuotaBlock {
  readonly reason: 'rate-limit' | 'quota'
  readonly since: string
  readonly nextCheckAt?: string
}
export type QuotaAdmission =
  | { readonly kind: 'ready'; readonly telemetry: QuotaFreshness }
  | { readonly kind: 'wait'; readonly reason: 'rate-limit' | 'quota' | 'quota-unknown';
      readonly telemetry: QuotaFreshness; readonly nextCheckAt?: string }

export function nextQuotaCheck(now: number, delay: number): string | undefined {
  const check = now + Math.ceil(delay)
  return Number.isFinite(check) && check > now && check < Date.parse('9999-12-31T23:59:59.999Z')
    ? new Date(check).toISOString() : undefined
}

function laterThan(now: number, value?: string): string | undefined {
  return value !== undefined && Date.parse(value) > now ? value : undefined
}

/** Evaluate one exact account/bucket. The caller supplies usage and telemetry from the same transaction. */
export function inspectQuota(input: {
  readonly bucket: QuotaBucket
  readonly now: number
  readonly requestedTokens: number
  readonly window: QuotaUsage
  readonly sinceObservation: QuotaUsage
  readonly observation?: QuotaObservation
  readonly block?: QuotaBlock
  readonly allowBoundedUnknown: boolean
  readonly maxTelemetryAgeMs: number
}): QuotaAdmission {
  const { bucket, now, window, sinceObservation, requestedTokens, observation, block } = input
  const exact = observation?.bucket.id === bucket.id && observation.bucket.revision === bucket.revision
    && observation.provenance !== 'unknown'
  const age = exact ? now - Date.parse(observation.observedAt) : Number.NaN
  const telemetry = !exact || age < 0 ? 'unknown' : age <= input.maxTelemetryAgeMs ? 'fresh' : 'stale'
  const wait = (reason: Extract<QuotaAdmission, { kind: 'wait' }>['reason'], nextCheckAt?: string): QuotaAdmission =>
    ({ kind: 'wait', reason, telemetry, ...(nextCheckAt === undefined ? {} : { nextCheckAt }) })

  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(requestedTokens) || requestedTokens < 1
    || !Number.isSafeInteger(window.requests) || window.requests < 0 || !Number.isSafeInteger(window.tokens) || window.tokens < 0
    || !Number.isSafeInteger(sinceObservation.requests) || sinceObservation.requests < 0
    || !Number.isSafeInteger(sinceObservation.tokens) || sinceObservation.tokens < 0
    || (window.oldestAt !== undefined && Date.parse(window.oldestAt) > now)) return wait('quota-unknown')
  if (block?.reason === 'quota') return wait('quota', laterThan(now, block.nextCheckAt))
  const cooldown = block && laterThan(now, block.nextCheckAt)
  if (block?.reason === 'rate-limit' && (block.nextCheckAt === undefined || cooldown)) return wait('rate-limit', cooldown)

  if ((bucket.requestsPerMinute !== undefined && window.requests >= bucket.requestsPerMinute)
    || (bucket.tokensPerMinute !== undefined && window.tokens + requestedTokens > bucket.tokensPerMinute)) {
    const oldest = window.oldestAt === undefined ? now : Date.parse(window.oldestAt)
    return wait('rate-limit', requestedTokens > (bucket.tokensPerMinute ?? Number.MAX_SAFE_INTEGER)
      ? undefined : nextQuotaCheck(now, oldest + quotaWindowMs - now))
  }
  if (telemetry === 'fresh' && observation) {
    const reset = laterThan(now, observation.resetAt)
    if (observation.status === 'cooldown') return wait('rate-limit', reset)
    if (observation.status === 'exhausted'
      || (observation.remainingRequests !== undefined && observation.remainingRequests <= sinceObservation.requests)
      || (observation.remainingTokens !== undefined && observation.remainingTokens < sinceObservation.tokens + requestedTokens)) {
      return wait('quota', reset)
    }
    if (observation.status === 'available' && (observation.provenance === 'provider' || observation.provenance === 'local')
      && (observation.remainingRequests !== undefined || observation.remainingTokens !== undefined)) return { kind: 'ready', telemetry }
  }
  if (input.allowBoundedUnknown && bucket.requestsPerMinute !== undefined && bucket.tokensPerMinute !== undefined) {
    return { kind: 'ready', telemetry }
  }
  return wait('quota-unknown')
}
