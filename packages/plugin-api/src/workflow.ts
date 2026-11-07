import { z } from 'zod'
import {
  capabilityDisclosureSchema, capabilityIdSchema, type MaybePromise, type ProviderLifecycle, type ProviderResult,
} from './common.js'
import {
  mediaAccessSchema, mediaInputArtifactSchema, mediaModalitySchema, mediaOperationSchema, mediaSubmitRequestSchema,
  type MediaHandle,
} from './media.js'

export type WorkflowJsonObject = { [key: string]: WorkflowJsonValue }
export type WorkflowJsonValue = string | number | boolean | null | WorkflowJsonValue[] | WorkflowJsonObject

const fieldNameSchema = z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
const maxWorkflowJsonBytes = 64 * 1024

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Bound depth and work before cloning so cyclic or deeply nested provider output is rejected.
function isBoundedJson(root: unknown): root is WorkflowJsonValue {
  const pending = [{ value: root, depth: 0 }]
  let nodes = 0
  let bytes = 0
  while (pending.length) {
    const next = pending.pop()!
    if (++nodes > 2_048 || next.depth > 12 || bytes > maxWorkflowJsonBytes) return false
    const { value, depth } = next
    if (value === null || typeof value === 'boolean') continue
    if (typeof value === 'number' && Number.isFinite(value)) continue
    if (typeof value === 'string') {
      if (value.length > 16_384) return false
      bytes += Buffer.byteLength(value)
      continue
    }
    if (Array.isArray(value)) {
      if (value.length > 128 || Object.getPrototypeOf(value) !== Array.prototype
        || Reflect.ownKeys(value).length !== value.length + 1) return false
      for (let index = 0; index < value.length; index++) {
        const item = Object.getOwnPropertyDescriptor(value, index)
        if (!item?.enumerable || !('value' in item)) return false
        pending.push({ value: item.value, depth: depth + 1 })
      }
      continue
    }
    if (!isJsonObject(value)) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length > 64) return false
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || key.length === 0 || key.length > 128 || forbiddenKeys.has(key)
        || !descriptor?.enumerable || !('value' in descriptor)) return false
      bytes += Buffer.byteLength(key)
      pending.push({ value: descriptor.value, depth: depth + 1 })
    }
  }
  return bytes <= maxWorkflowJsonBytes && Buffer.byteLength(JSON.stringify(root)) <= maxWorkflowJsonBytes
}

export const workflowJsonValueSchema = z.custom<WorkflowJsonValue>(isBoundedJson)
  .transform(value => structuredClone(value))
export const workflowJsonObjectSchema = z.custom<WorkflowJsonObject>(value => isJsonObject(value) && isBoundedJson(value))
  .transform(value => structuredClone(value))

export const workflowFieldSchema = z.strictObject({
  name: fieldNameSchema.refine(name => !forbiddenKeys.has(name)),
  type: z.enum(['text', 'number', 'boolean', 'artifact', 'json']),
  required: z.boolean(),
})
export type WorkflowField = z.infer<typeof workflowFieldSchema>
const fieldsSchema = z.array(workflowFieldSchema).max(32)
  .refine(fields => new Set(fields.map(field => field.name)).size === fields.length)

export function matchesWorkflowFields(fields: readonly WorkflowField[], input: WorkflowJsonObject): boolean {
  const byName = new Map(fields.map(field => [field.name, field]))
  if (fields.some(field => field.required && !Object.hasOwn(input, field.name))) return false
  return Object.entries(input).every(([name, value]) => {
    switch (byName.get(name)?.type) {
      case 'text': return typeof value === 'string'
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'boolean': return typeof value === 'boolean'
      case 'artifact': return mediaInputArtifactSchema.safeParse(value).success
      case 'json': return true
      default: return false
    }
  })
}

export const workflowRequirementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('media'), modality: mediaModalitySchema, operation: mediaOperationSchema }),
  z.strictObject({ kind: z.literal('tool'), toolId: capabilityIdSchema }),
])
export const workflowCapabilitiesSchema = capabilityDisclosureSchema.extend({
  workflowVersion: capabilityIdSchema,
  inputs: fieldsSchema,
  outputs: fieldsSchema,
  steps: z.array(z.strictObject({ id: capabilityIdSchema, checkpoint: z.boolean() })).min(1).max(64)
    .refine(steps => new Set(steps.map(step => step.id)).size === steps.length),
  requires: z.array(workflowRequirementSchema).max(32).refine(requirements =>
    new Set(requirements.map(requirement => requirement.kind === 'tool'
      ? JSON.stringify(['tool', requirement.toolId])
      : JSON.stringify(['media', requirement.modality, requirement.operation]))).size === requirements.length),
})
export type WorkflowCapabilities = z.infer<typeof workflowCapabilitiesSchema>

export const workflowCheckpointSchema = z.strictObject({ stepId: capabilityIdSchema, data: workflowJsonObjectSchema })
export const workflowRequestSchema = z.strictObject({
  access: mediaAccessSchema,
  operationId: capabilityIdSchema,
  workflowVersion: capabilityIdSchema,
  input: workflowJsonObjectSchema,
  checkpoint: workflowCheckpointSchema.optional(),
})
export type WorkflowRequest = z.infer<typeof workflowRequestSchema>
export const workflowResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('checkpoint'), checkpoint: workflowCheckpointSchema }),
  z.strictObject({ kind: z.literal('completed'), output: workflowJsonObjectSchema }),
])
export type WorkflowResult = z.infer<typeof workflowResultSchema>

export const workflowMediaRequestSchema = mediaSubmitRequestSchema.omit({ access: true, operationId: true })
export const workflowToolRequestSchema = z.strictObject({ toolId: capabilityIdSchema, args: workflowJsonObjectSchema })
export type WorkflowMediaRequest = z.infer<typeof workflowMediaRequestSchema>
export type WorkflowToolRequest = z.infer<typeof workflowToolRequestSchema>

/** The consumer supplies policy-checked services scoped to the current workflow invocation. */
export interface WorkflowServices {
  requestMedia(request: WorkflowMediaRequest, signal: AbortSignal): MaybePromise<ProviderResult<MediaHandle>>
  requestTool(request: WorkflowToolRequest, signal: AbortSignal): MaybePromise<ProviderResult<WorkflowJsonValue>>
}

export interface CreationWorkflowProvider extends ProviderLifecycle {
  readonly capabilities: WorkflowCapabilities
  run(request: WorkflowRequest, services: WorkflowServices, signal: AbortSignal): MaybePromise<ProviderResult<WorkflowResult>>
}
