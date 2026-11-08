import { z } from 'zod'
import {
  capabilityDestinationSchema, capabilityGenerationSchema, capabilityIdSchema, capabilityInstantSchema,
  capabilityRevisionSchema, credentialRefSchema,
} from './common.js'

const ids = z.array(capabilityIdSchema).max(64).refine(values => new Set(values).size === values.length)
const tokens = z.int().positive().max(32_000_000)
const units = z.int().nonnegative()
const stamp = { id: capabilityIdSchema, revision: capabilityRevisionSchema }
const task = { taskId: capabilityIdSchema, taskAttemptId: capabilityIdSchema, generation: capabilityGenerationSchema }
const feature = z.enum(['tools', 'images', 'structured-output'])
const features = z.array(feature).max(3).refine(values => new Set(values).size === values.length)

export const deploymentPinSchema = z.strictObject(stamp)
export const logicalEffortSchema = z.enum(['low', 'medium', 'high'])
export const effortMappingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('provider'), id: capabilityIdSchema }),
  z.strictObject({ kind: z.literal('thinking-budget'), tokens }),
  z.strictObject({ kind: z.literal('adapter-default') }),
])

export const modelDeploymentSchema = z.strictObject({
  ...stamp,
  accountId: capabilityIdSchema,
  quotaBucketId: capabilityIdSchema,
  provider: capabilityIdSchema,
  model: capabilityIdSchema,
  destination: capabilityDestinationSchema,
  credential: credentialRefSchema.optional(),
  pricing: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('unknown') }),
    z.strictObject({ kind: z.literal('configured'), revision: capabilityRevisionSchema }),
  ]).default({ kind: 'unknown' }),
  dataScope: ids,
  capabilities: features,
  contextTokens: tokens,
  outputTokens: tokens,
  /** Provider-declared order from least to greatest selectable effort. */
  nativeEfforts: ids,
  effort: z.partialRecord(logicalEffortSchema, effortMappingSchema),
}).refine(value => value.outputTokens <= value.contextTokens && Object.values(value.effort).every(mapping =>
  mapping.kind !== 'provider' || value.nativeEfforts.includes(mapping.id)))

export const quotaBucketSchema = z.strictObject({
  ...stamp,
  accountId: capabilityIdSchema,
  requestsPerMinute: z.int().positive().optional(),
  tokensPerMinute: tokens.optional(),
})

export const quotaObservationSchema = z.strictObject({
  bucket: z.strictObject(stamp),
  observedAt: capabilityInstantSchema,
  provenance: z.enum(['local', 'provider', 'estimate', 'unknown']),
  status: z.enum(['available', 'cooldown', 'exhausted', 'unknown']),
  remainingRequests: units.optional(),
  remainingTokens: units.optional(),
  resetAt: capabilityInstantSchema.optional(),
}).refine(value => (value.provenance !== 'unknown'
  || (value.status === 'unknown' && value.remainingRequests === undefined && value.remainingTokens === undefined))
  && (value.resetAt === undefined || value.resetAt >= value.observedAt))

export const difficultyTierSchema = z.enum(['simple', 'standard', 'complex'])
export const routingPoolSchema = z.enum(['fast', 'balanced', 'deep'])
const pool = z.array(deploymentPinSchema).min(1).max(32).refine(values => new Set(values.map(value => value.id)).size === values.length)
const rule = z.strictObject({ pool: routingPoolSchema, effort: logicalEffortSchema.optional() })
const defaultRules = {
  simple: { pool: 'fast', effort: 'low' },
  standard: { pool: 'balanced', effort: 'medium' },
  complex: { pool: 'deep', effort: 'high' },
} as const
export const semanticBudgetSchema = z.strictObject({
  maxInputTokens: tokens.max(4096),
  maxOutputTokens: tokens.max(128),
  ceilingMicros: z.int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  timeoutMs: z.int().min(10).max(5000),
})
const confidence = z.number().min(0).max(1)
export const routingPolicyRevisionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...stamp, mode: z.literal('fixed'), deployment: deploymentPinSchema, effort: logicalEffortSchema.optional() }),
  z.strictObject({ ...stamp, mode: z.literal('automatic'),
    pools: z.strictObject({ fast: pool, balanced: pool, deep: pool }), maxSwitches: z.int().min(0).max(8),
    rules: z.strictObject({ simple: rule, standard: rule, complex: rule }).default(defaultRules),
    lowConfidence: z.strictObject({ threshold: confidence, minimumTier: z.enum(['standard', 'complex']) })
      .default({ threshold: 0.65, minimumTier: 'standard' }),
    unsupportedEffort: z.enum(['exclude', 'omit']).default('exclude'),
    semantic: semanticBudgetSchema.optional(),
  }),
])

export const routingRequirementsSchema = z.strictObject({
  capabilities: features,
  dataScope: ids,
  inputTokens: tokens,
  outputTokens: tokens,
})

const candidateExclusion = z.strictObject({
  deployment: deploymentPinSchema,
  reason: z.enum(['capability', 'context', 'destination', 'effort', 'quota', 'budget', 'policy', 'unavailable']),
})
const decision = {
  id: capabilityIdSchema,
  ...task,
  policy: z.strictObject(stamp),
  decidedAt: capabilityInstantSchema,
  requirements: routingRequirementsSchema,
  acceptanceDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  difficulty: z.strictObject({ tier: difficultyTierSchema, confidence,
    basis: z.enum(['deterministic', 'semantic', 'conservative']).optional() }).optional(),
  excluded: z.array(candidateExclusion).max(64),
}
export const routingDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...decision, kind: z.literal('dispatch'),
    deployment: deploymentPinSchema, effort: logicalEffortSchema.optional(),
    basis: z.enum(['fixed', 'override', 'rule', 'escalation', 'fallback']) }),
  z.strictObject({ ...decision, kind: z.literal('wait'),
    reason: z.enum(['policy', 'permission', 'missing-input', 'budget', 'quota', 'unavailable']), nextCheckAt: capabilityInstantSchema.optional() }),
])

const usage = z.strictObject({
  inputTokens: units, outputTokens: units, cacheReadTokens: units.optional(), cacheWriteTokens: units.optional(),
})
export const inferenceAttemptSchema = z.strictObject({
  id: capabilityIdSchema,
  ...task,
  decisionId: capabilityIdSchema,
  requestSeriesId: capabilityIdSchema,
  previousAttemptId: capabilityIdSchema.optional(),
  deployment: deploymentPinSchema,
  accountId: capabilityIdSchema,
  quotaBucketId: capabilityIdSchema,
  status: z.enum(['planned', 'streaming', 'completed', 'interrupted', 'failed', 'uncertain']),
  createdAt: capabilityInstantSchema,
  budgetReservationIds: ids,
  pricingRevision: capabilityRevisionSchema.optional(),
  usage: usage.optional(),
}).refine(value => value.previousAttemptId !== value.id
  && (value.status !== 'planned' || (value.usage === undefined && value.budgetReservationIds.length === 0)))

export type DeploymentPin = z.infer<typeof deploymentPinSchema>
export type DifficultyTier = z.infer<typeof difficultyTierSchema>
export type SemanticBudget = z.infer<typeof semanticBudgetSchema>
export type LogicalEffort = z.infer<typeof logicalEffortSchema>
export type EffortMapping = z.infer<typeof effortMappingSchema>
export type ModelDeployment = z.infer<typeof modelDeploymentSchema>
export type QuotaBucket = z.infer<typeof quotaBucketSchema>
export type QuotaObservation = z.infer<typeof quotaObservationSchema>
export type RoutingPolicyRevision = z.infer<typeof routingPolicyRevisionSchema>
export type RoutingRequirements = z.infer<typeof routingRequirementsSchema>
export type RoutingDecision = z.infer<typeof routingDecisionSchema>
export type InferenceAttempt = z.infer<typeof inferenceAttemptSchema>
