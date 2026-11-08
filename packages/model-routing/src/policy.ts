import { createHash } from 'node:crypto'
import { capabilityGenerationSchema, capabilityIdSchema, capabilityInstantSchema } from '@mosbot-ai/dshpa-plugin-api'
import {
  deploymentPinSchema, logicalEffortSchema, modelDeploymentSchema, routingDecisionSchema, routingPolicyRevisionSchema,
  routingRequirementsSchema, type DeploymentPin, type DifficultyTier, type LogicalEffort, type ModelDeployment,
  type RoutingDecision, type RoutingRequirements, type SemanticBudget,
} from '@mosbot-ai/dshpa-plugin-api/model-routing'
import { z } from 'zod'
import { difficultySignalsSchema, estimateDifficulty, higherTier, semanticEstimateSchema, type DifficultySignals } from './difficulty.js'

const overrideSchema = z.strictObject({ deployment: deploymentPinSchema, effort: logicalEffortSchema.optional() })
const requestSchema = z.strictObject({
  id: capabilityIdSchema,
  taskId: capabilityIdSchema,
  taskAttemptId: capabilityIdSchema,
  generation: capabilityGenerationSchema,
  acceptanceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  decidedAt: capabilityInstantSchema,
  readiness: z.enum(['ready', 'missing-input', 'permission']),
  request: z.enum(['initial', 'escalation']).default('initial'),
  requirements: routingRequirementsSchema,
  signals: difficultySignalsSchema,
  policy: routingPolicyRevisionSchema,
  deployments: z.array(modelDeploymentSchema).max(96),
  override: overrideSchema.optional(),
})
type Request = z.infer<typeof requestSchema>
type Override = Readonly<z.infer<typeof overrideSchema>>
type Dispatch = Extract<RoutingDecision, { kind: 'dispatch' }>
type Wait = Extract<RoutingDecision, { kind: 'wait' }>
type Difficulty = NonNullable<RoutingDecision['difficulty']>
type Exclusion = RoutingDecision['excluded'][number]
type Admission = 'ready' | Extract<Exclusion['reason'], 'destination' | 'budget' | 'quota' | 'policy' | 'unavailable'>

export interface RoutingTaskFence {
  readonly taskId: string
  readonly taskAttemptId: string
  readonly generation: number
  readonly acceptanceDigest: string
  readonly policy: DeploymentPin
}

const qualitySchema = z.strictObject({
  decision: routingDecisionSchema,
  result: z.enum(['quality', 'missing-input', 'permission', 'other']),
  switches: z.int().nonnegative(),
})
export type VerifiedRoutingQuality = Readonly<z.infer<typeof qualitySchema>>

export interface RoutingPolicyCore {
  /** Core checks live account/destination authority, quota and budget without reserving a model call. */
  inspect(fence: RoutingTaskFence, deployment: Readonly<ModelDeployment>, requirements: RoutingRequirements): Admission
  authorizeOverride?(fence: RoutingTaskFence, override: Override): boolean
  /** Read the verifier's latest decision and switch count from authoritative Task state. */
  quality?(fence: RoutingTaskFence): VerifiedRoutingQuality | undefined
  /** Claim the separate semantic budget and deduplicate the phase key before invoking estimate. */
  classify?(fence: RoutingTaskFence, key: string, budget: SemanticBudget, estimate: () => Promise<unknown>, signal: AbortSignal): Promise<unknown>
}
export type SemanticEstimator = (signals: DifficultySignals, budget: SemanticBudget, signal: AbortSignal) => Promise<unknown>
type Result = { ok: true; decision: RoutingDecision } | { ok: false; code: 'invalid_input' | 'cancelled' }

const pinKey = (pin: DeploymentPin) => JSON.stringify([pin.id, pin.revision])
const pinOf = ({ id, revision }: DeploymentPin): DeploymentPin => ({ id, revision })
const nextTier = { simple: 'standard', standard: 'complex', complex: 'complex' } as const

function sameRequirements(left: RoutingRequirements, right: RoutingRequirements): boolean {
  return left.inputTokens === right.inputTokens && left.outputTokens === right.outputTokens
    && left.capabilities.length === right.capabilities.length && left.capabilities.every(value => right.capabilities.includes(value))
    && left.dataScope.length === right.dataScope.length && left.dataScope.every(value => right.dataScope.includes(value))
}

function checkDeployment(deployment: ModelDeployment, requirements: RoutingRequirements): Exclusion['reason'] | undefined {
  if (!requirements.capabilities.every(feature => deployment.capabilities.includes(feature))) return 'capability'
  if (requirements.inputTokens + requirements.outputTokens > deployment.contextTokens
    || requirements.outputTokens > deployment.outputTokens) return 'context'
  if (!requirements.dataScope.every(label => deployment.dataScope.includes(label))) return 'destination'
  return undefined
}

function inspect(core: RoutingPolicyCore, fence: RoutingTaskFence, deployment: ModelDeployment, requirements: RoutingRequirements) {
  const structural = checkDeployment(deployment, requirements)
  if (structural) return structural
  try {
    const admission = core.inspect(fence, structuredClone(deployment), structuredClone(requirements))
    if (admission === 'ready') return undefined
    if (admission === 'destination' || admission === 'budget' || admission === 'quota' || admission === 'policy') return admission
  } catch { /* A failed authority read excludes the deployment. */ }
  return 'unavailable' as const
}

function waitReason(exclusions: readonly Exclusion[]): Wait['reason'] {
  if (exclusions.some(item => item.reason === 'budget')) return 'budget'
  if (exclusions.some(item => item.reason === 'quota')) return 'quota'
  if (exclusions.some(item => item.reason === 'destination' || item.reason === 'policy')) return 'permission'
  return 'unavailable'
}

async function withDeadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  const timed = Promise.withResolvers<undefined>()
  const stop = () => timed.resolve(undefined)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try { return await Promise.race([pending, timed.promise]) }
  finally { signal.removeEventListener('abort', stop) }
}

async function classify(core: RoutingPolicyCore, fence: RoutingTaskFence, request: Request, budget: SemanticBudget,
  estimator: SemanticEstimator, signal?: AbortSignal) {
  const signals = Object.freeze({ ...request.signals })
  if (Buffer.byteLength(JSON.stringify(signals)) > budget.maxInputTokens) return undefined
  const key = createHash('sha256').update(JSON.stringify([
    fence.taskId, fence.taskAttemptId, fence.generation, fence.policy.id, fence.policy.revision, signals.phase,
  ])).digest('hex')
  const timeout = AbortSignal.timeout(budget.timeoutMs)
  const scoped = signal ? AbortSignal.any([signal, timeout]) : timeout
  let invoked = false
  try {
    const pending = core.classify!(fence, key, { ...budget }, async () => {
      if (invoked || scoped.aborted) throw new Error('Semantic admission is no longer available')
      invoked = true
      return estimator(signals, { ...budget }, scoped)
    }, scoped)
    const result = await withDeadline(pending, scoped)
    return invoked && !scoped.aborted ? semanticEstimateSchema.safeParse(result).data : undefined
  } catch {
    return undefined
  }
}

function chooseEffort(deployment: ModelDeployment, effort: LogicalEffort | undefined, mayOmit: boolean) {
  if (effort === undefined) return undefined
  const mapping = deployment.effort[effort]
  if (mapping && mapping.kind !== 'thinking-budget') return effort
  return mayOmit ? undefined : 'unsupported' as const
}

function strongerEffort(deployment: ModelDeployment, previous: LogicalEffort | undefined, next: LogicalEffort | undefined): boolean {
  if (previous === undefined || next === undefined) return false
  const before = deployment.effort[previous]
  const after = deployment.effort[next]
  return before?.kind === 'provider' && after?.kind === 'provider'
    && deployment.nativeEfforts.indexOf(after.id) > deployment.nativeEfforts.indexOf(before.id)
}

/** Decide on a route before any native model request is assembled. */
export async function decideRouting(input: unknown, core: RoutingPolicyCore,
  options: { estimator?: SemanticEstimator; signal?: AbortSignal } = {}): Promise<Result> {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success) return { ok: false, code: 'invalid_input' }
  const request = parsed.data
  const { policy, requirements, override } = request
  const { signal, estimator } = options
  if (signal?.aborted) return { ok: false, code: 'cancelled' }
  const fence: RoutingTaskFence = Object.freeze({
    taskId: request.taskId, taskAttemptId: request.taskAttemptId, generation: request.generation,
    acceptanceDigest: request.acceptanceDigest, policy: Object.freeze(pinOf(policy)),
  })
  const catalog = new Map(request.deployments.map(deployment => [pinKey(deployment), deployment]))
  if (catalog.size !== request.deployments.length) return { ok: false, code: 'invalid_input' }
  const excluded: Exclusion[] = []
  const base = { ...fence, id: request.id, decidedAt: request.decidedAt, requirements }
  let difficulty: Difficulty | undefined
  let waitedForSemantic = false
  function decision(value: Pick<Wait, 'kind' | 'reason'> | Pick<Dispatch, 'kind' | 'deployment' | 'basis' | 'effort'>): Result {
    return { ok: true, decision: routingDecisionSchema.parse({
      ...base, ...value, ...(difficulty && { difficulty }), excluded: excluded.slice(0, 64),
    }) }
  }
  const wait = (reason: Wait['reason']) => decision({ kind: 'wait', reason })
  if (request.readiness !== 'ready') return wait(request.readiness)

  const pins = policy.mode === 'fixed' ? [policy.deployment] : Object.values(policy.pools).flat()
  const configured = new Map(pins.map(pin => [pinKey(pin), pin]))
  if (override) {
    try {
      if (request.request !== 'initial' || !configured.has(pinKey(override.deployment))
        || core.authorizeOverride?.(fence, structuredClone(override)) !== true) return wait('permission')
    } catch { return wait('permission') }
  }

  let previous: Dispatch | undefined
  if (request.request === 'escalation') {
    if (policy.mode !== 'automatic') return wait('policy')
    let quality: VerifiedRoutingQuality | undefined
    try { quality = qualitySchema.safeParse(core.quality?.(fence)).data } catch { return wait('policy') }
    if (!quality || quality.result === 'other') return wait('policy')
    if (quality.result !== 'quality') return wait(quality.result)
    const prior = quality.decision
    if (prior.kind !== 'dispatch' || prior.id === request.id || prior.taskId !== fence.taskId
      || prior.taskAttemptId !== fence.taskAttemptId || prior.generation !== fence.generation
      || prior.acceptanceDigest !== fence.acceptanceDigest || pinKey(prior.policy) !== pinKey(policy)
      || !sameRequirements(prior.requirements, requirements) || !configured.has(pinKey(prior.deployment))
      || prior.basis === 'override' || prior.basis === 'fixed' || quality.switches >= policy.maxSwitches) return wait('policy')
    previous = prior
  }

  const eligible = new Map<string, ModelDeployment>()
  const considered = override ? [[pinKey(override.deployment), override.deployment] as const] : configured.entries()
  for (const [key, pin] of considered) {
    const deployment = catalog.get(key)
    const reason = deployment ? inspect(core, fence, deployment, requirements) : 'unavailable'
    if (reason) excluded.push({ deployment: pinOf(pin), reason })
    else if (deployment) eligible.set(key, deployment)
  }
  if (eligible.size === 0) return wait(waitReason(excluded))

  if (policy.mode === 'automatic' && !override) {
    difficulty = estimateDifficulty(request.signals)
    if (previous) {
      const priorTier = previous.difficulty?.tier ?? difficulty.tier
      difficulty = { ...difficulty, tier: higherTier(difficulty.tier, nextTier[priorTier]) }
    } else if (difficulty.confidence < policy.lowConfidence.threshold) {
      const reachable = Object.values(policy.rules).some(rule => policy.pools[rule.pool].some(pin => {
        const deployment = eligible.get(pinKey(pin))
        return deployment !== undefined && chooseEffort(deployment, rule.effort, policy.unsupportedEffort === 'omit') !== 'unsupported'
      }))
      let estimate: z.infer<typeof semanticEstimateSchema> | undefined
      if (reachable && policy.semantic && estimator && core.classify) {
        waitedForSemantic = true
        estimate = await classify(core, fence, request, policy.semantic, estimator, signal)
      }
      if (signal?.aborted) return { ok: false, code: 'cancelled' }
      difficulty = estimate && estimate.confidence >= policy.lowConfidence.threshold
        ? { tier: higherTier(difficulty.tier, estimate.tier), confidence: estimate.confidence, basis: 'semantic' }
        : { ...difficulty, tier: higherTier(difficulty.tier, policy.lowConfidence.minimumTier), basis: 'conservative' }
    }
  }

  const rule = policy.mode === 'automatic' && difficulty ? policy.rules[difficulty.tier] : undefined
  const choices = override ? [override.deployment] : policy.mode === 'fixed' ? [policy.deployment]
    : policy.pools[rule!.pool]
  const desired = override ? override.effort ?? (policy.mode === 'fixed' ? policy.effort : undefined)
    : policy.mode === 'fixed' ? policy.effort : rule?.effort
  const basis = override ? 'override' : policy.mode === 'fixed' ? 'fixed' : previous ? 'escalation' : 'rule'
  for (const pin of choices) {
    const deployment = eligible.get(pinKey(pin))
    if (!deployment) continue
    if (signal?.aborted) return { ok: false, code: 'cancelled' }
    // Semantic admission can wait. Recheck authority and budget before returning the concrete decision.
    if (waitedForSemantic) {
      const reason = inspect(core, fence, deployment, requirements)
      if (reason) { excluded.push({ deployment: pinOf(pin), reason }); continue }
    }
    const mayOmit = !override && policy.mode === 'automatic' && policy.unsupportedEffort === 'omit'
    const effort = chooseEffort(deployment, desired, mayOmit)
    if (effort === 'unsupported') {
      excluded.push({ deployment: pinOf(pin), reason: 'effort' })
      continue
    }
    if (previous && pinKey(previous.deployment) === pinKey(pin) && !strongerEffort(deployment, previous.effort, effort)) continue
    return decision({ kind: 'dispatch', deployment: pinOf(pin), effort, basis })
  }
  const selected = new Set(choices.map(pinKey))
  const selectedExclusions = excluded.filter(row => selected.has(pinKey(row.deployment)))
  return wait(previous && selectedExclusions.length === 0 ? 'policy' : waitReason(selectedExclusions))
}
