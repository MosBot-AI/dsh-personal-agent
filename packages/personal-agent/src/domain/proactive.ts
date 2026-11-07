import { z } from 'zod'
import {
  accountIdSchema, attemptIdSchema, generationSchema, nonEmptyTextSchema, projectIdSchema, sha256DigestSchema,
  sourceEventIdSchema, sourceInstanceIdSchema, taskIdSchema, utcInstantSchema, versionSchema, artifactIdSchema,
} from './model.js'

export const proactiveModeSchema = z.enum(['off', 'observe', 'prepare', 'act'])
export type ProactiveMode = z.infer<typeof proactiveModeSchema>
export const proactiveRuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u)
const milliseconds = z.int().positive().max(7 * 86_400_000)
export const proactiveDraftSchema = z.strictObject({
  title: nonEmptyTextSchema.max(128),
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  sourceInstanceId: sourceInstanceIdSchema.max(256),
  accountId: accountIdSchema.max(256),
  threadId: nonEmptyTextSchema.max(512),
  query: nonEmptyTextSchema.max(256),
  freshForMs: milliseconds.default(86_400_000),
  dedupeMs: milliseconds.default(15 * 60_000),
  cooldownMs: milliseconds.default(60_000),
})
const replay = z.strictObject({ at: utcInstantSchema, examined: z.int().nonnegative().max(100), matched: z.int().nonnegative().max(100) })
export const proactiveRuleSchema = z.strictObject({
  id: proactiveRuleIdSchema, version: versionSchema, spec: sha256DigestSchema, draft: proactiveDraftSchema,
  mode: proactiveModeSchema, readGrant: z.boolean(), localGrant: z.boolean(), replay: replay.optional(),
})
export type ProactiveRule = z.infer<typeof proactiveRuleSchema>
export type ProactiveDraftInput = z.input<typeof proactiveDraftSchema>

export const candidateIdSchema = z.string().regex(/^proactive-[a-f0-9]{64}$/u)
export const proactiveCandidateSchema = z.strictObject({
  id: candidateIdSchema, ruleId: proactiveRuleIdSchema, version: versionSchema, spec: sha256DigestSchema,
  eventId: sourceEventIdSchema, mode: proactiveModeSchema, at: utcInstantSchema, attemptId: attemptIdSchema,
  generation: generationSchema, taskVersion: versionSchema, policyVersion: versionSchema,
  status: z.enum(['pending', 'suppressed', 'proposed', 'prepared', 'surfaced']),
  reason: nonEmptyTextSchema.max(64), summary: nonEmptyTextSchema.max(1024).optional(),
  artifactId: artifactIdSchema.optional(), useful: z.boolean().optional(),
})
export type ProactiveCandidate = z.infer<typeof proactiveCandidateSchema>

const modes: readonly ProactiveMode[] = ['off', 'observe', 'prepare', 'act']
export function effectiveProactiveMode(rule: ProactiveMode, policy: ProactiveMode): ProactiveMode {
  return modes[Math.min(modes.indexOf(rule), modes.indexOf(policy))]!
}

export function usefulEvidence(reviewed: number, useful: number): boolean {
  return reviewed >= 20 && useful * 10 >= reviewed * 7
}
