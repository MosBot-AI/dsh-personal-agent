import { z } from 'zod'
import { nonEmptyTextSchema, projectIdSchema, projectSchema, taskIdSchema, utcInstantSchema, versionSchema } from './model.js'

export const projectPlanDraftSchema = z.strictObject({
  title: nonEmptyTextSchema.max(256),
  purpose: nonEmptyTextSchema.max(4096),
  successCriteria: z.array(nonEmptyTextSchema.max(1024)).min(1).max(16),
  milestones: projectSchema.shape.milestones.max(16).refine(items => items.every(item => item.title.length <= 256
    && (item.deadline?.localIntent?.length ?? 0) <= 512)),
  reviewCadence: projectSchema.shape.reviewCadence,
  priority: z.enum(['high', 'normal', 'low']),
})

export const planRevisionSchema = z.strictObject({
  project: projectSchema,
  rationale: nonEmptyTextSchema.max(4096).optional(),
  recordedAt: utcInstantSchema.optional(),
})
export type ProjectPlanDraft = z.infer<typeof projectPlanDraftSchema>
export type ProjectPlanInput = z.input<typeof projectPlanDraftSchema>
export type PlanRevision = z.infer<typeof planRevisionSchema>

export const taskPrerequisitesSchema = z.array(taskIdSchema.max(256)).max(16)
  .refine(ids => new Set(ids).size === ids.length)

export const projectPlanTargetSchema = z.strictObject({ projectId: projectIdSchema, expectedRevision: versionSchema })
export const workerPlanStepsSchema = z.array(nonEmptyTextSchema.max(1024)).min(1).max(8)
  .refine(steps => new Set(steps).size === steps.length)

const priorities = { high: 0, normal: 1, low: 2 } as const

/** Stable review ordering. Equal priorities and deadlines leave a real owner choice. */
export function comparePlanPriority(
  a: { priority?: keyof typeof priorities; due?: string },
  b: { priority?: keyof typeof priorities; due?: string },
): number {
  return priorities[a.priority ?? 'normal'] - priorities[b.priority ?? 'normal']
    || (a.due ?? '\uffff').localeCompare(b.due ?? '\uffff')
}
