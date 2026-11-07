import { z } from 'zod'
import { nonEmptyTextSchema, waitReasonSchema, workerCursorSchema } from '../domain/model.js'
import { artifactIdsSchema } from '../domain/transitions.js'

const MAX_REPORT_BYTES = 16 * 1024
const MAX_INPUT_BYTES = 64 * 1024

const reportFields = {
  cursor: workerCursorSchema,
  summary: nonEmptyTextSchema.refine(text => Buffer.byteLength(text) <= 2_048, 'Worker summary is too large'),
}

const workerReportSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('progress'), ...reportFields }),
  z.strictObject({
    kind: z.literal('waiting'),
    ...reportFields,
    wait: waitReasonSchema.extend({ reason: waitReasonSchema.shape.reason.exclude(['dependency']) }),
  }),
  z.strictObject({ kind: z.literal('ready'), ...reportFields, artifactIds: artifactIdsSchema.max(64) }),
  z.strictObject({
    kind: z.literal('blocked'),
    ...reportFields,
    wait: waitReasonSchema.extend({ reason: z.literal('dependency') }),
  }),
  z.strictObject({ kind: z.literal('failed'), ...reportFields }),
])

export type WorkerReport = z.infer<typeof workerReportSchema>

export const workerInputSchema = z.strictObject({
  cursor: workerCursorSchema,
  text: nonEmptyTextSchema.refine(text => Buffer.byteLength(text) <= MAX_INPUT_BYTES, 'Worker input is too large'),
})

/** A model may report observations. The executor owns task identity and validates the current cursor. */
export function decodeWorkerReport(text: string): WorkerReport | undefined {
  if (typeof text !== 'string' || text.length > MAX_REPORT_BYTES || Buffer.byteLength(text) > MAX_REPORT_BYTES) return undefined
  try {
    const result = workerReportSchema.safeParse(JSON.parse(text))
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

export function workerReportInstructions(cursor: string): string {
  return [
    'Return one JSON object without Markdown or surrounding prose.',
    `Include "cursor": ${JSON.stringify(workerCursorSchema.parse(cursor))}, a short "summary", and one "kind".`,
    'For "progress" or "failed", use the summary to describe the evidence or failure.',
    'For "ready", include "artifactIds" as an array of unique artifact references. Report readiness for verification.',
    'For "waiting", include "wait" with "reason" (input, approval, event, environment, or resource), "referenceId", and "resumeCondition".',
    'For "blocked", include the same "wait" fields with "reason": "dependency" and the exact dependency reference.',
    'A wait may include "deadline" as a UTC instant with milliseconds. Include only the fields for the chosen kind.',
  ].join('\n')
}
