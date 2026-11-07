import { z } from 'zod'
import { artifactIdSchema, projectIdSchema, sha256DigestSchema, taskIdSchema, versionSchema } from '../domain/model.js'

export const skillInputLimit = 1_024
export const skillOutputLimit = 8_192
export const skillProjectLimit = 24
export const skillVersionLimit = 24
const id = z.uuid()
const revision = z.int().positive().max(skillVersionLimit)
const name = z.string().trim().min(1).max(100)
const field = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u)
const inputs = z.record(field, z.string().min(1).max(skillInputLimit))
  .refine(value => Object.keys(value).length <= 8)
export const skillSourceSchema = z.strictObject({ taskId: taskIdSchema.max(256), artifactId: artifactIdSchema.max(256) })
export const skillProofSchema = skillSourceSchema.extend({
  taskVersion: versionSchema, artifactVersion: z.int().positive(), digest: sha256DigestSchema,
})
const fixture = z.strictObject({ source: skillSourceSchema, inputs })
const draft = z.strictObject({
  name, template: z.string().min(1).max(4_096),
  sources: z.array(skillSourceSchema).min(2).max(4),
  fixtures: z.array(fixture).min(1).max(4),
})
const project = { projectId: projectIdSchema.max(256) }
const skill = { ...project, skillId: id }
const exact = { ...skill, revision, digest: sha256DigestSchema }
const selection = { ...exact, expectedSelection: versionSchema }
export const skillRequestSchemas = [
  z.strictObject({ type: z.literal('skill_list'), ...project }),
  z.strictObject({ type: z.literal('skill_inspect'), ...skill, revision }),
  z.strictObject({ type: z.literal('skill_propose'), ...skill, expectedLatest: versionSchema, draft }),
  z.strictObject({ type: z.literal('skill_evaluate'), ...exact }),
  z.strictObject({ type: z.literal('skill_activate'), ...selection }),
  z.strictObject({ type: z.literal('skill_rollback'), ...selection }),
  z.strictObject({ type: z.literal('skill_run'), ...exact, runId: id, inputs }),
  z.strictObject({ type: z.literal('skill_feedback'), ...exact, runId: id, feedback: z.enum(['accepted', 'correction']) }),
] as const

export const skillSpecSchema = z.strictObject({
  name: draft.shape.name, template: draft.shape.template,
  inputSchema: z.strictObject({
    type: z.literal('object'), required: z.array(field).min(1).max(8),
    valueType: z.literal('string'), maxLength: z.literal(skillInputLimit), additionalProperties: z.literal(false),
  }),
  outputSchema: z.strictObject({ type: z.literal('string'), mediaType: z.literal('text/markdown'),
    maxLength: z.literal(skillOutputLimit) }),
  requiredCapabilities: z.tuple([z.literal('render-markdown')]),
  sources: z.array(skillProofSchema).min(2).max(4),
  fixtures: z.array(fixture.extend({ source: skillProofSchema })).min(1).max(4),
})
export type SkillSpec = z.infer<typeof skillSpecSchema>
export type SkillProof = z.infer<typeof skillProofSchema>
export type SkillRequestInput = z.input<(typeof skillRequestSchemas)[number]>
export type SkillRequest = z.infer<(typeof skillRequestSchemas)[number]>

const header = z.strictObject({
  skillId: id, latest: revision, active: revision.nullable(), selection: versionSchema,
  name: name.optional(),
})
const detail = z.strictObject({
  revision, digest: sha256DigestSchema, spec: skillSpecSchema.optional(),
  evaluation: z.array(z.boolean()).min(1).max(4).nullable(),
  approved: z.boolean(), accepted: versionSchema, corrections: versionSchema, rollbacks: versionSchema,
})
const feedback = z.enum(['accepted', 'correction'])
export const skillResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ok: z.literal(true), kind: z.literal('skill_list'), ...project, skills: z.array(header).max(skillProjectLimit) }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('skill_revision'), ...project, skill: header, detail }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('skill_output'), ...exact, runId: id,
    text: z.string().min(1).max(skillOutputLimit), feedback: feedback.nullable() }),
])
export type SkillResponse = z.infer<typeof skillResponseSchema>
