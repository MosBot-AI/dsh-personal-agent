import { z } from 'zod'
import {
  capabilityDisclosureSchema, capabilityGenerationSchema, capabilityIdSchema, providerPinSchema,
  type MaybePromise, type ProviderLifecycle, type ProviderResult,
} from './common.js'

const dimensionSchema = z.int().min(1).max(16_384)
const durationSchema = z.int().min(1).max(3_600_000)
const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const mediaTypeSchema = z.string().max(128).regex(/^[a-z\d][a-z\d.+-]*\/[a-z\d][a-z\d.+-]*$/)
export const mediaModalitySchema = z.enum(['image', 'video'])
export const mediaOperationSchema = z.enum(['generate', 'edit'])
const mediaOperationsSchema = z.array(mediaOperationSchema).min(1).max(2)
  .refine(operations => new Set(operations).size === operations.length)

const formatFields = { operations: mediaOperationsSchema, maxWidth: dimensionSchema, maxHeight: dimensionSchema }
export const mediaFormatSchema = z.discriminatedUnion('modality', [
  z.strictObject({ modality: z.literal('image'), ...formatFields }),
  z.strictObject({ modality: z.literal('video'), ...formatFields, maxDurationMs: durationSchema }),
])
export const mediaPricingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('free') }),
  z.strictObject({ kind: z.literal('unknown') }),
  z.strictObject({ kind: z.literal('known'), currency: z.string().regex(/^[A-Z]{3}$/), ceilingMicros: z.int().nonnegative() }),
])
export const mediaCapabilitiesSchema = capabilityDisclosureSchema.extend({
  formats: z.array(mediaFormatSchema).min(1).max(2)
    .refine(formats => new Set(formats.map(format => format.modality)).size === formats.length),
  cancellation: z.enum(['none', 'queued', 'per-job', 'instance']),
  resources: z.strictObject({ compute: z.enum(['cpu', 'gpu', 'remote']), exclusive: z.boolean() }),
  pricing: mediaPricingSchema,
})
export type MediaCapabilities = z.infer<typeof mediaCapabilitiesSchema>

export const mediaAccessSchema = z.strictObject({
  ownerId: capabilityIdSchema,
  profileId: capabilityIdSchema,
  taskId: capabilityIdSchema,
  attemptId: capabilityIdSchema,
  generation: capabilityGenerationSchema,
})
export type MediaAccess = z.infer<typeof mediaAccessSchema>

export function sameMediaAccess(a: MediaAccess, b: MediaAccess): boolean {
  return a.ownerId === b.ownerId && a.profileId === b.profileId && a.taskId === b.taskId
    && a.attemptId === b.attemptId && a.generation === b.generation
}

const specFields = { operation: mediaOperationSchema, width: dimensionSchema, height: dimensionSchema }
export const mediaSpecSchema = z.discriminatedUnion('modality', [
  z.strictObject({ modality: z.literal('image'), ...specFields }),
  z.strictObject({ modality: z.literal('video'), ...specFields, durationMs: durationSchema }),
])
export type MediaSpec = z.infer<typeof mediaSpecSchema>

export const mediaInputArtifactSchema = z.strictObject({
  artifactId: capabilityIdSchema,
  contentHash: contentHashSchema,
  mediaType: mediaTypeSchema,
})
export type MediaInputArtifact = z.infer<typeof mediaInputArtifactSchema>

export const mediaSubmitRequestSchema = z.strictObject({
  access: mediaAccessSchema,
  operationId: capabilityIdSchema,
  workflowId: capabilityIdSchema,
  workflowVersion: capabilityIdSchema,
  model: capabilityIdSchema,
  spec: mediaSpecSchema,
  prompt: z.string().min(1).max(16_384).optional(),
  inputArtifacts: z.array(mediaInputArtifactSchema).max(16)
    .refine(artifacts => new Set(artifacts.map(artifact => artifact.artifactId)).size === artifacts.length).optional(),
})
export type MediaSubmitRequest = z.infer<typeof mediaSubmitRequestSchema>

export const mediaHandleSchema = z.strictObject({
  provider: providerPinSchema.extend({ kind: z.literal('media') }),
  operationId: capabilityIdSchema,
  handleId: capabilityIdSchema,
})
export type MediaHandle = z.infer<typeof mediaHandleSchema>

export const preparedMediaSubmissionSchema = z.strictObject({
  handle: mediaHandleSchema,
  workflowDigest: contentHashSchema,
  seed: z.int().nonnegative().optional(),
})
export type PreparedMediaSubmission = z.infer<typeof preparedMediaSubmissionSchema>

export interface DurableMediaSubmission {
  /** Prepare without sending or creating a backend job. Persist this result before submit. */
  prepare(request: MediaSubmitRequest, signal: AbortSignal): MaybePromise<ProviderResult<PreparedMediaSubmission>>
  /** Dispatch once. After any ambiguous result, inspect the prepared handle. */
  submit(request: MediaSubmitRequest, prepared: PreparedMediaSubmission, signal: AbortSignal): MaybePromise<ProviderResult<MediaHandle>>
}

export const mediaJobRequestSchema = z.strictObject({ access: mediaAccessSchema, handle: mediaHandleSchema })
export type MediaJobRequest = z.infer<typeof mediaJobRequestSchema>

export const mediaJobStatusSchema = z.strictObject({
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']),
  progress: z.number().min(0).max(1).optional(),
})
export type MediaJobStatus = z.infer<typeof mediaJobStatusSchema>

export const mediaOutputSchema = z.strictObject({
  assetId: capabilityIdSchema,
  contentHash: contentHashSchema,
  mediaType: mediaTypeSchema,
  sizeBytes: z.int().positive(),
  width: dimensionSchema,
  height: dimensionSchema,
  durationMs: durationSchema.optional(),
})
export type MediaOutput = z.infer<typeof mediaOutputSchema>
export const mediaOutputsSchema = z.array(mediaOutputSchema).min(1).max(32)
  .refine(outputs => new Set(outputs.map(output => output.assetId)).size === outputs.length)

/** Handles are pinned to the originating provider configuration for every later operation. */
export interface MediaProvider extends ProviderLifecycle {
  readonly capabilities: MediaCapabilities
  readonly durableSubmission?: DurableMediaSubmission
  submit(request: MediaSubmitRequest, signal: AbortSignal): MaybePromise<ProviderResult<MediaHandle>>
  inspect(request: MediaJobRequest, signal: AbortSignal): MaybePromise<ProviderResult<MediaJobStatus>>
  cancel(request: MediaJobRequest, signal: AbortSignal): MaybePromise<ProviderResult<MediaJobStatus>>
  collect(request: MediaJobRequest, signal: AbortSignal): MaybePromise<ProviderResult<MediaOutput[]>>
}
