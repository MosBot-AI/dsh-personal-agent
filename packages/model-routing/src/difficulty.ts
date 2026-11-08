import { difficultyTierSchema, type DifficultyTier } from '@mosbot-ai/dshpa-plugin-api/model-routing'
import { z } from 'zod'

const count = z.int().nonnegative().max(10_000)
export const difficultySignalsSchema = z.strictObject({
  phase: z.enum(['assess', 'plan', 'execute', 'verify']),
  kind: z.enum(['extract', 'format', 'summarize', 'edit', 'implement', 'plan', 'verify', 'unknown']),
  dependencyCount: count.optional(),
  sourceCount: count.optional(),
  constraintCount: count.optional(),
  scope: z.enum(['single', 'multiple', 'cross-module']).optional(),
  verification: z.enum(['direct', 'multi-step', 'adversarial']).optional(),
  conflictingEvidence: z.boolean().optional(),
  multimodal: z.boolean().optional(),
  priority: z.enum(['interactive', 'balanced', 'quality']).optional(),
})
export type DifficultySignals = Readonly<z.infer<typeof difficultySignalsSchema>>
export const semanticEstimateSchema = z.strictObject({
  tier: difficultyTierSchema, confidence: z.number().min(0).max(1),
})

const base = { extract: 0, format: 0, summarize: 2, edit: 2, implement: 3, plan: 4, verify: 2, unknown: 2 }
const scopeScore = { single: 0, multiple: 1, 'cross-module': 3 }
const verificationScore = { direct: 0, 'multi-step': 1, adversarial: 2 }
const order: readonly DifficultyTier[] = ['simple', 'standard', 'complex']

export function higherTier(left: DifficultyTier, right: DifficultyTier): DifficultyTier {
  return order.indexOf(left) >= order.indexOf(right) ? left : right
}

/** Score trusted task shape rather than scanning user text or measuring prompt length. */
export function estimateDifficulty(signals: DifficultySignals) {
  const {
    kind, phase, dependencyCount, sourceCount, constraintCount, scope, verification, conflictingEvidence, multimodal, priority,
  } = signals
  const score = base[kind] + (phase === 'plan' || phase === 'verify' ? 1 : 0)
    + Math.min(dependencyCount ?? 0, 2)
    + Math.min(Math.floor((sourceCount ?? 0) / 3), 2)
    + Math.min(Math.floor((constraintCount ?? 0) / 3), 2)
    + (scope === undefined ? 0 : scopeScore[scope])
    + (verification === undefined ? 0 : verificationScore[verification])
    + (conflictingEvidence ? 3 : 0) + (multimodal ? 1 : 0)
    + (priority === 'quality' && base[kind] >= 2 ? 1 : 0)
  const complex = conflictingEvidence || scope === 'cross-module' || score >= 6
  const tier: DifficultyTier = complex ? 'complex' : score >= 2 ? 'standard' : 'simple'
  const known = [dependencyCount, sourceCount, constraintCount, scope, verification, conflictingEvidence, multimodal, priority]
    .filter(value => value !== undefined).length
  const confidence = Math.min(kind === 'unknown' ? 0.55 : 1, (known + (kind === 'unknown' ? 1 : 2)) / 10)
  return { tier, confidence, basis: 'deterministic' } as const
}
