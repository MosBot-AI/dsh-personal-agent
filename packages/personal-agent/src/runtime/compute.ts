import { contentHasFile, contentHasImage, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { BudgetRequest, BudgetService } from './budget.js'

export const computeLimitsSchema = z.strictObject({
  maxInputBytes: z.int().min(256).max(1024 * 1024).default(128 * 1024),
  maxOutputTokens: z.int().min(16).max(65_536).default(1_536),
  maxTurns: z.int().min(1).max(256).default(24),
  maxStepsPerTurn: z.int().min(1).max(64).default(6),
  maxWallTimeMs: z.int().min(50).max(600_000).default(120_000),
})

export type ComputeLimits = z.infer<typeof computeLimitsSchema>
export type ComputeScope = Omit<BudgetRequest, 'provider' | 'model' | 'upperInputTokens' | 'upperOutputTokens'>
export type ComputeTaskFence = NonNullable<BudgetRequest['task']>

export interface ComputeIssue {
  readonly code: string
  readonly retryAfterMs?: number
}

export interface WorkerComputeOptions {
  readonly budget: BudgetService
  readonly limits?: Partial<ComputeLimits>
}

export interface NativeWorkerCompute {
  readonly budget: BudgetService
  readonly limits: ComputeLimits
  readonly initiallyUnattended?: boolean
  scope(unattended: boolean): ComputeScope | undefined
}

// Include a framing allowance above serialized text size. Quoted routes
// still use their configured conservative cost ceiling, not this estimate
// as a reported provider token count.
const FRAMING_BYTES_PER_MESSAGE = 64

export function conservativeRequestBounds(
  request: GenerateOptions,
  limits: ComputeLimits,
): { upperInputTokens: number; upperOutputTokens: number } | undefined {
  const output = request.maxTokens
  if (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 1
    || output > limits.maxOutputTokens || (request.tools?.length ?? 0) > 0) return undefined
  let bytes = Buffer.byteLength(request.system ?? '') + FRAMING_BYTES_PER_MESSAGE
  for (const message of request.messages) {
    if (contentHasFile(message.content) || contentHasImage(message.content)) return undefined
    bytes += Buffer.byteLength(JSON.stringify(message)) + FRAMING_BYTES_PER_MESSAGE
    if (bytes > limits.maxInputBytes) return undefined
  }
  return bytes <= limits.maxInputBytes ? { upperInputTokens: bytes, upperOutputTokens: output } : undefined
}

export function computeDenied(code: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message: 'Model computation is currently unavailable.' } } }
}

function outputBytes(chunk: StreamChunk): number {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return Buffer.byteLength(chunk.text)
    case 'tool-call-delta':
      return Buffer.byteLength(chunk.argumentsDelta)
    case 'block-end':
      return Buffer.byteLength(JSON.stringify(chunk.block))
    default:
      return 0
  }
}

interface MeteredStream {
  readonly budget: BudgetService
  readonly request: GenerateOptions
  readonly limits: ComputeLimits
  readonly scope: ComputeScope
  readonly next: () => AsyncIterable<StreamChunk>
  readonly onIssue: (issue: ComputeIssue) => void
  readonly current?: () => boolean
}

const routeCooldowns = new WeakMap<BudgetService, Map<string, number>>()

function cooldownKey(scope: ComputeScope, provider: string, model: string): string {
  return JSON.stringify([scope.ownerId, scope.profileId, provider, model])
}

export function computeCooldown(budget: BudgetService, scope: ComputeScope, provider: string, model: string): ComputeIssue | undefined {
  const routes = routeCooldowns.get(budget)
  const key = cooldownKey(scope, provider, model)
  const until = routes?.get(key)
  if (until === undefined) return undefined
  const retryAfterMs = Math.ceil(until - performance.now())
  if (retryAfterMs > 0) return { code: 'provider_rate_limited', retryAfterMs }
  routes?.delete(key)
}

function recordCooldown(budget: BudgetService, scope: ComputeScope, request: GenerateOptions, delay: number | undefined): ComputeIssue {
  const retryAfterMs = typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : 60_000
  const routes = routeCooldowns.get(budget) ?? new Map<string, number>()
  routeCooldowns.set(budget, routes)
  const key = cooldownKey(scope, request.provider, request.model)
  const now = performance.now()
  const previous = routes.get(key) ?? 0
  routes.set(key, Math.max(previous, now + retryAfterMs))
  return { code: 'provider_rate_limited', retryAfterMs: Math.max(retryAfterMs, Math.ceil(previous - now)) }
}

/** The sole next() call is downstream of the synchronous durable claim. */
export async function* meteredStream({
  budget, request, limits, scope, next, onIssue, current,
}: MeteredStream): AsyncIterable<StreamChunk> {
  const allowed = () => request.signal?.aborted !== true && (current === undefined || current() === true)
  const bounds = conservativeRequestBounds(request, limits)
  if (!bounds || !allowed()) {
    onIssue({ code: 'compute_limit' })
    yield computeDenied('compute_limit')
    return
  }
  const cooldown = computeCooldown(budget, scope, request.provider, request.model)
  if (cooldown) {
    onIssue(cooldown)
    yield computeDenied(cooldown.code)
    return
  }
  let claim: ReturnType<BudgetService['begin']>
  try {
    claim = budget.begin({ ...scope, provider: request.provider, model: request.model, ...bounds })
  } catch {
    onIssue({ code: 'meter_unavailable' })
    yield computeDenied('meter_unavailable')
    return
  }
  if (!claim.ok) {
    const code = claim.code === 'pricing_unavailable' ? 'price_unknown' : claim.code
    onIssue({ code })
    yield computeDenied(code)
    return
  }

  const { reservation } = claim
  let usage: TokenUsage | undefined
  let finished = false
  let failed = false
  let emitted = 0
  // Bound streamed content even when an adapter disregards maxTokens.
  const maxOutputBytes = bounds.upperOutputTokens * 64
  try {
    for await (const chunk of next()) {
      const rateLimit = chunk.type === 'finish' && chunk.reason.kind === 'error' && chunk.reason.failure.status === 429
        ? recordCooldown(budget, scope, request, chunk.reason.failure.providerRetryAfterMs) : undefined
      if (!allowed()) {
        failed = true
        onIssue({ code: 'compute_limit' })
        yield computeDenied('compute_limit')
        return
      }
      emitted += outputBytes(chunk)
      if (emitted > maxOutputBytes) {
        failed = true
        onIssue({ code: 'compute_limit' })
        yield computeDenied('compute_limit')
        return
      }
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') {
        const { reason } = chunk
        finished = reason.kind !== 'error' && reason.kind !== 'aborted'
        if (rateLimit) onIssue(rateLimit)
        if (finished && usage && (usage.outputTokens > bounds.upperOutputTokens
          || usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > bounds.upperInputTokens)) {
          onIssue({ code: 'compute_limit' })
          // Keep the observed terminal usage for settlement while withholding
          // the result that exceeded the admitted bounds.
          yield computeDenied('compute_limit')
          return
        }
      }
      yield chunk
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      if (failed || !finished || !usage || !budget.settle(reservation, usage)) budget.uncertain(reservation)
    } catch {
      // A failed write leaves its durable claim for conservative recovery.
      onIssue({ code: 'meter_unavailable' })
    }
  }
}
