import { contentHasFile, contentHasImage, LlmError, type GenerateOptions, type LlmFailure, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
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
  readonly inputAdmitted?: boolean
}

type ProviderIssue = ComputeIssue & {
  readonly code: 'provider_rate_limited' | 'provider_authentication' | 'provider_unavailable' | 'provider_rejected'
  readonly retryAfterMs: number
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

const DEFAULT_PROVIDER_COOLDOWN_MS = 60_000
const transportCodes = new Set([
  'TRANSPORT', 'TIMEOUT', 'NETWORK', 'NETWORK_ERROR', 'STREAM_CLOSED', 'SERVER', 'SERVER_ERROR',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])
const authCodes = new Set(['AUTH', 'UNAUTHORIZED', 'FORBIDDEN', 'MISSING_CREDENTIALS', 'HTTP_401', 'HTTP_403'])
type FailureFacts = Pick<LlmFailure, 'code' | 'status' | 'providerRetryAfterMs'>

export function providerComputeIssue(failure: FailureFacts): ProviderIssue {
  const { status, code, providerRetryAfterMs: delay } = failure
  const retryAfterMs = typeof delay === 'number' && Number.isFinite(delay) && delay >= 0
    ? Math.ceil(delay) : DEFAULT_PROVIDER_COOLDOWN_MS
  if (status === 429 || code === 'RATE_LIMIT' || code === 'HTTP_429') return { code: 'provider_rate_limited', retryAfterMs }
  if (status === 401 || status === 403 || authCodes.has(code)) return { code: 'provider_authentication', retryAfterMs: DEFAULT_PROVIDER_COOLDOWN_MS }
  if (status === 408 || (status !== undefined && status >= 500 && status <= 599)
    || transportCodes.has(code) || /^HTTP_5\d{2}$/u.test(code)) return { code: 'provider_unavailable', retryAfterMs }
  return { code: 'provider_rejected', retryAfterMs: DEFAULT_PROVIDER_COOLDOWN_MS }
}

const routeCooldowns = new WeakMap<BudgetService, Map<string, { code: ProviderIssue['code']; until: number }>>()

function cooldownKey(scope: ComputeScope, provider: string, model: string): string {
  return JSON.stringify([scope.ownerId, scope.profileId, provider, model])
}

export function computeCooldown(budget: BudgetService, scope: ComputeScope, provider: string, model: string): ComputeIssue | undefined {
  const routes = routeCooldowns.get(budget)
  const key = cooldownKey(scope, provider, model)
  const cooldown = routes?.get(key)
  if (!cooldown) return undefined
  const retryAfterMs = Math.ceil(cooldown.until - performance.now())
  if (retryAfterMs > 0) return { code: cooldown.code, retryAfterMs }
  routes?.delete(key)
}

export function recordProviderCooldown(
  budget: BudgetService, scope: ComputeScope, route: Pick<GenerateOptions, 'provider' | 'model'>, issue: ProviderIssue,
): ComputeIssue {
  // A request-specific rejection only parks the owning Worker.
  if (issue.code === 'provider_rejected') return issue
  const routes = routeCooldowns.get(budget) ?? new Map()
  routeCooldowns.set(budget, routes)
  const key = cooldownKey(scope, route.provider, route.model)
  const now = performance.now()
  const previous = routes.get(key)?.until ?? 0
  routes.set(key, { code: issue.code, until: Math.max(previous, now + issue.retryAfterMs) })
  return { ...issue, retryAfterMs: Math.max(issue.retryAfterMs, Math.ceil(previous - now)) }
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
  let terminal = false
  let failed = false
  let emitted = 0
  // Bound streamed content even when an adapter disregards maxTokens.
  const maxOutputBytes = bounds.upperOutputTokens * 64
  try {
    for await (const chunk of next()) {
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
        terminal = true
        const { reason } = chunk
        finished = reason.kind !== 'error' && reason.kind !== 'aborted'
        const failure = reason.kind === 'error' ? reason.failure : reason.kind === 'aborted' ? { code: 'TRANSPORT' } : undefined
        if (failure) onIssue(recordProviderCooldown(budget, scope, request, providerComputeIssue(failure)))
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
    if (!terminal && allowed()) {
      const issue = recordProviderCooldown(budget, scope, request, providerComputeIssue({ code: 'STREAM_CLOSED' }))
      onIssue(issue)
      yield computeDenied(issue.code)
    }
  } catch (error) {
    failed = true
    if (error instanceof LlmError && allowed()) onIssue(recordProviderCooldown(budget, scope, request, providerComputeIssue(error.failure)))
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
