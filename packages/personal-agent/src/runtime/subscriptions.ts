import { z } from 'zod'
import {
  accountIdSchema,
  attemptIdSchema,
  generationSchema,
  nonEmptyTextSchema,
  ownerIdSchema,
  profileIdSchema,
  projectIdSchema,
  sha256DigestSchema,
  sourceEventIdSchema,
  sourceInstanceIdSchema,
  taskIdSchema,
  utcInstantSchema,
  versionSchema,
  workerCursorSchema,
  type SourceEvent,
} from '../domain/model.js'
import { inputStatusSchema } from './input-journal.js'

const ownerScope = { ownerId: ownerIdSchema, profileId: profileIdSchema }
const threadId = nonEmptyTextSchema.max(512)
const mode = z.enum(['context', 'work'])
const summary = nonEmptyTextSchema.max(2_048)
const positiveVersion = versionSchema.min(1)

export const routingAuthoritySchema = z.strictObject({
  policyVersion: nonEmptyTextSchema.max(512),
  verifiedAt: utcInstantSchema,
})
export type RoutingAuthority = z.infer<typeof routingAuthoritySchema>

export const routingEventRefSchema = z.strictObject({ ...ownerScope, eventId: sourceEventIdSchema.max(512) })
export type RoutingEventRef = z.infer<typeof routingEventRefSchema>

export const subscriptionScopeSchema = z.strictObject({
  ...ownerScope,
  sourceInstanceId: sourceInstanceIdSchema.max(512),
  accountId: accountIdSchema.max(512),
  threadId,
})
export type SubscriptionScope = z.infer<typeof subscriptionScopeSchema>
export const subscriptionKeySchema = subscriptionScopeSchema.extend({ taskId: taskIdSchema.max(512) })
export type SubscriptionKey = z.infer<typeof subscriptionKeySchema>
export const subscriptionInputSchema = subscriptionKeySchema.extend({
  projectId: projectIdSchema.max(512),
  mode,
  enabled: z.boolean(),
  authority: routingAuthoritySchema,
  updatedAt: utcInstantSchema,
  expiresAt: utcInstantSchema.optional(),
}).refine(value => value.updatedAt >= value.authority.verifiedAt
  && (value.expiresAt === undefined || value.expiresAt > value.updatedAt))
export const subscriptionSchema = subscriptionInputSchema.safeExtend({ version: positiveVersion })
export type Subscription = z.infer<typeof subscriptionSchema>

export const routingDecisionSchema = z.strictObject({
  kind: z.enum(['ignore', 'clarify', 'propose_task']),
  summary: summary.optional(),
})
export type RoutingDecision = z.infer<typeof routingDecisionSchema>

export const routingDispositionUpdateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('queued') }),
  z.strictObject({ kind: z.literal('rejected'), reason: nonEmptyTextSchema.max(256) }),
  z.strictObject({ kind: z.literal('context'), taskIds: z.array(taskIdSchema).max(64)
    .refine(ids => new Set(ids).size === ids.length).optional() }),
  z.strictObject({ kind: z.literal('assessed'), decision: routingDecisionSchema }),
])
export type RoutingDispositionUpdate = z.infer<typeof routingDispositionUpdateSchema>

export const routingDispositionSchema = z.discriminatedUnion('kind', [
  ...routingDispositionUpdateSchema.options,
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({ kind: z.literal('routed') }),
  z.strictObject({ kind: z.literal('handback'), summary: summary.optional() }),
])
export type RoutingDisposition = z.infer<typeof routingDispositionSchema>

export const routingDeliverySchema = z.strictObject({
  taskId: taskIdSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  cursor: workerCursorSchema,
  mode: z.literal('work'),
  projectId: projectIdSchema,
  subscriptionVersion: positiveVersion,
  taskVersion: positiveVersion,
  inputStatus: inputStatusSchema,
  handbackAt: utcInstantSchema.optional(),
})
export type RoutingDelivery = z.infer<typeof routingDeliverySchema>

export const routingReceiptSchema = z.strictObject({
  eventId: sourceEventIdSchema,
  projectId: projectIdSchema,
  digest: sha256DigestSchema,
  version: positiveVersion,
  authority: routingAuthoritySchema,
  disposition: routingDispositionSchema,
  delivery: routingDeliverySchema.optional(),
})
export type RoutingReceipt = z.infer<typeof routingReceiptSchema>
export type StoredRoutingEvent = { readonly event: SourceEvent; readonly receipt: RoutingReceipt }

export const workerRouteIntentSchema = z.strictObject({
  eventId: sourceEventIdSchema,
  expectedReceiptVersion: positiveVersion,
  projectId: projectIdSchema,
  subscriptionVersion: positiveVersion,
  mode,
  authority: routingAuthoritySchema,
})
export type WorkerRouteIntent = z.infer<typeof workerRouteIntentSchema>

export const workerHandbackSchema = z.strictObject({
  eventId: sourceEventIdSchema,
  cursor: workerCursorSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  expectedVersion: versionSchema,
  summary: summary.optional(),
})
export type WorkerHandback = z.infer<typeof workerHandbackSchema>
