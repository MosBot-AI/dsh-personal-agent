import { z } from 'zod'

export const nonEmptyTextSchema = z.string().refine(value => value.trim().length > 0, 'Expected non-empty text')

function opaqueIdSchema<Brand extends string>() {
  return z.string().regex(/^[^\s\p{Cc}]+$/u, 'Expected an opaque identifier').brand<Brand>()
}

export const ownerIdSchema = opaqueIdSchema<'OwnerId'>()
export const profileIdSchema = opaqueIdSchema<'ProfileId'>()
export const accountIdSchema = opaqueIdSchema<'AccountId'>()
export const deviceIdSchema = opaqueIdSchema<'DeviceId'>()
export const clientIdSchema = opaqueIdSchema<'ClientId'>()
export const commandIdSchema = opaqueIdSchema<'CommandId'>()
export const sourceInstanceIdSchema = opaqueIdSchema<'SourceInstanceId'>()
export const sourceEventIdSchema = opaqueIdSchema<'SourceEventId'>()
export const conversationIdSchema = opaqueIdSchema<'ConversationId'>()
export const sessionIdSchema = opaqueIdSchema<'SessionId'>()
export const projectIdSchema = opaqueIdSchema<'ProjectId'>()
export const taskIdSchema = opaqueIdSchema<'TaskId'>()
export const attemptIdSchema = opaqueIdSchema<'AttemptId'>()
export const mandateIdSchema = opaqueIdSchema<'MandateId'>()
export const grantIdSchema = opaqueIdSchema<'GrantId'>()
export const requestIdSchema = opaqueIdSchema<'RequestId'>()
export const operationIdSchema = opaqueIdSchema<'OperationId'>()
export const deliveryIdSchema = opaqueIdSchema<'DeliveryId'>()
export const artifactIdSchema = opaqueIdSchema<'ArtifactId'>()
export const memoryRecordIdSchema = opaqueIdSchema<'MemoryRecordId'>()
export const scheduleIdSchema = opaqueIdSchema<'ScheduleId'>()
export const ruleIdSchema = opaqueIdSchema<'RuleId'>()

export type OwnerId = z.infer<typeof ownerIdSchema>
export type ProfileId = z.infer<typeof profileIdSchema>
export type AccountId = z.infer<typeof accountIdSchema>
export type DeviceId = z.infer<typeof deviceIdSchema>
export type ClientId = z.infer<typeof clientIdSchema>
export type CommandId = z.infer<typeof commandIdSchema>
export type SourceInstanceId = z.infer<typeof sourceInstanceIdSchema>
export type SourceEventId = z.infer<typeof sourceEventIdSchema>
export type ConversationId = z.infer<typeof conversationIdSchema>
export type SessionId = z.infer<typeof sessionIdSchema>
export type ProjectId = z.infer<typeof projectIdSchema>
export type TaskId = z.infer<typeof taskIdSchema>
export type AttemptId = z.infer<typeof attemptIdSchema>
export type MandateId = z.infer<typeof mandateIdSchema>
export type GrantId = z.infer<typeof grantIdSchema>
export type RequestId = z.infer<typeof requestIdSchema>
export type OperationId = z.infer<typeof operationIdSchema>
export type DeliveryId = z.infer<typeof deliveryIdSchema>
export type ArtifactId = z.infer<typeof artifactIdSchema>
export type MemoryRecordId = z.infer<typeof memoryRecordIdSchema>
export type ScheduleId = z.infer<typeof scheduleIdSchema>
export type RuleId = z.infer<typeof ruleIdSchema>

export const versionSchema = z.int().nonnegative()
export const generationSchema = versionSchema
export const utcInstantSchema = z.iso.datetime({ precision: 3 }).brand<'UtcInstant'>()
export type UtcInstant = z.infer<typeof utcInstantSchema>
export const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest')
export const timeZoneSchema = z.string().refine(value => {
  if (!/^[A-Za-z]/.test(value)) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}, 'Expected an IANA time zone')

const ownership = { ownerId: ownerIdSchema, profileId: profileIdSchema }
const textListSchema = z.array(nonEmptyTextSchema)

export const ownerSchema = z.strictObject({ id: ownerIdSchema })
export const profileSchema = z.strictObject({
  id: profileIdSchema,
  ownerId: ownerIdSchema,
  verifiedAccounts: z.array(z.strictObject({
    sourceInstanceId: sourceInstanceIdSchema,
    accountId: accountIdSchema,
    verifiedAt: utcInstantSchema,
  })),
  verifiedDevices: z.array(z.strictObject({ deviceId: deviceIdSchema, verifiedAt: utcInstantSchema })),
  policyVersion: nonEmptyTextSchema,
})

export const sourceActorSchema = z.strictObject({
  kind: z.enum(['person', 'service']),
  externalActorId: nonEmptyTextSchema,
  accountId: accountIdSchema.optional(),
  deviceId: deviceIdSchema.optional(),
})

export const sourceEventSchema = z.strictObject({
  id: sourceEventIdSchema,
  ...ownership,
  sourceInstanceId: sourceInstanceIdSchema,
  externalEventId: nonEmptyTextSchema,
  externalRevision: nonEmptyTextSchema,
  actor: sourceActorSchema,
  body: z.json(),
  occurredAt: utcInstantSchema,
  receivedAt: utcInstantSchema,
  threadId: nonEmptyTextSchema.optional(),
  provenance: z.strictObject({ url: z.url().optional(), description: nonEmptyTextSchema.optional() }),
})

export const deliveryDestinationSchema = z.strictObject({
  sourceInstanceId: sourceInstanceIdSchema,
  externalDestinationId: nonEmptyTextSchema,
})

export const conversationSchema = z.strictObject({
  id: conversationIdSchema,
  ...ownership,
  sessionIds: z.array(sessionIdSchema),
  lastCheckpointId: nonEmptyTextSchema.optional(),
  originalDestination: deliveryDestinationSchema,
})

export const taskDeadlineSchema = z.strictObject({
  at: utcInstantSchema,
  timeZone: timeZoneSchema,
  localIntent: nonEmptyTextSchema.optional(),
})

export const projectSchema = z.strictObject({
  id: projectIdSchema,
  ...ownership,
  kind: z.enum(['project', 'goal']),
  title: nonEmptyTextSchema,
  purpose: nonEmptyTextSchema,
  resourceRefs: textListSchema,
  status: z.enum(['active', 'paused', 'completed', 'cancelled']),
  successCriteria: textListSchema.min(1),
  planRevision: versionSchema,
  milestones: z.array(z.strictObject({
    title: nonEmptyTextSchema,
    deadline: taskDeadlineSchema.optional(),
  })),
  reviewCadence: z.strictObject({ intervalDays: z.int().positive(), timeZone: timeZoneSchema }).optional(),
})

export const computeWaitPrefix = 'dshpa:compute:'
export const indefiniteWait = utcInstantSchema.parse('9999-12-31T23:59:59.999Z')

export const waitReasonSchema = z.strictObject({
  reason: z.enum(['input', 'approval', 'event', 'environment', 'resource', 'dependency']),
  referenceId: nonEmptyTextSchema,
  deadline: utcInstantSchema.optional(),
  notBefore: utcInstantSchema.optional(),
  resumeCondition: nonEmptyTextSchema,
})

export function waitAllowsWake(wait: WaitReason | undefined, at: UtcInstant): boolean {
  return wait?.notBefore === undefined || (wait.notBefore !== indefiniteWait && at >= wait.notBefore)
}

export const acceptanceSchema = z.strictObject({
  criteria: textListSchema.min(1),
  requiresArtifact: z.boolean(),
  requiresReceipt: z.boolean(),
})

export const taskDefinitionSchema = z.strictObject({
  requestedOutcome: nonEmptyTextSchema,
  constraints: textListSchema,
  acceptance: acceptanceSchema,
  nextAction: nonEmptyTextSchema.optional(),
  deadline: taskDeadlineSchema.optional(),
})

export const taskStatusSchema = z.enum([
  'queued', 'running', 'verifying', 'completed', 'waiting_input', 'waiting_approval',
  'waiting_event', 'waiting_environment', 'waiting_resource', 'blocked', 'failed', 'paused',
  'cancelling', 'cancelled', 'reconciliation_required',
])

const requiredWaitReason: Partial<Record<TaskStatus, WaitReason['reason']>> = {
  waiting_input: 'input',
  waiting_approval: 'approval',
  waiting_event: 'event',
  waiting_environment: 'environment',
  waiting_resource: 'resource',
  blocked: 'dependency',
}

export const taskSchema = z.strictObject({
  id: taskIdSchema,
  ...ownership,
  projectId: projectIdSchema,
  conversationId: conversationIdSchema.optional(),
  ...taskDefinitionSchema.shape,
  provenance: z.strictObject({ sourceEventIds: z.array(sourceEventIdSchema) }),
  version: versionSchema,
  generation: generationSchema,
  status: taskStatusSchema,
  attemptId: attemptIdSchema,
  wait: waitReasonSchema.optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
}).refine(task => {
  const reason = requiredWaitReason[task.status]
  if (reason !== undefined) return task.wait?.reason === reason
  return task.wait === undefined || task.status === 'paused' || task.status === 'reconciliation_required'
}, { path: ['wait'], error: 'Wait reason must match the task status' })
  .refine(task => task.updatedAt >= task.createdAt, { path: ['updatedAt'], error: 'Task update precedes creation' })

export const mandateRefSchema = z.strictObject({
  id: mandateIdSchema,
  ...ownership,
  policyVersion: nonEmptyTextSchema,
}).readonly()

export const attemptScopeSchema = z.strictObject({ capabilities: textListSchema, dataScope: textListSchema })
export const workerCursorSchema = z.string().max(256).regex(/^[^\s\p{Cc}]+$/u)
export const WORKER_INPUT_LIMIT = 64
export const workerExecutionSchema = z.strictObject({
  presetId: nonEmptyTextSchema,
  cwd: nonEmptyTextSchema,
  provider: nonEmptyTextSchema,
  model: nonEmptyTextSchema,
  inputCursor: workerCursorSchema,
  inputHistory: z.array(workerCursorSchema).min(1).max(WORKER_INPUT_LIMIT),
  releasedAt: utcInstantSchema.optional(),
}).refine(worker => worker.inputHistory.at(-1) === worker.inputCursor
  && new Set(worker.inputHistory).size === worker.inputHistory.length,
{ path: ['inputHistory'], error: 'Worker history must end at the current unique cursor' })

export const attemptStatusSchema = z.enum([
  'queued', 'running', 'waiting', 'paused', 'verifying', 'cancelling', 'completed', 'failed', 'cancelled',
])

export const attemptOutcomeSchema = z.strictObject({
  status: z.enum(['completed', 'failed', 'cancelled']),
  summary: nonEmptyTextSchema,
  receiptId: nonEmptyTextSchema.optional(),
})

const startedAttemptStatuses: ReadonlySet<AttemptStatus> = new Set([
  'running', 'verifying', 'cancelling', 'completed', 'failed',
])

export const attemptSchema = z.strictObject({
  id: attemptIdSchema,
  taskId: taskIdSchema,
  generation: generationSchema,
  status: attemptStatusSchema,
  mandate: mandateRefSchema,
  artifactIds: z.array(artifactIdSchema),
  executor: nonEmptyTextSchema.optional(),
  agentId: nonEmptyTextSchema.optional(),
  sessionId: sessionIdSchema.optional(),
  scope: attemptScopeSchema.optional(),
  worker: workerExecutionSchema.optional(),
  startedAt: utcInstantSchema.optional(),
  endedAt: utcInstantSchema.optional(),
  heartbeatAt: utcInstantSchema.optional(),
  outcome: attemptOutcomeSchema.optional(),
}).refine(attempt => {
  if (attempt.worker !== undefined && (attempt.sessionId === undefined || attempt.startedAt === undefined)) return false
  if (attempt.startedAt !== undefined) return attempt.executor !== undefined
  return !startedAttemptStatuses.has(attempt.status)
    && attempt.executor === undefined && attempt.agentId === undefined
    && attempt.sessionId === undefined && attempt.scope === undefined
    && attempt.artifactIds.length === 0
}, { path: ['startedAt'], error: 'Attempt execution data requires a start time and executor' })
  .refine(attempt => {
    const terminal = attempt.status === 'completed' || attempt.status === 'failed' || attempt.status === 'cancelled'
    if (terminal) return attempt.endedAt !== undefined && attempt.outcome?.status === attempt.status
    return attempt.endedAt === undefined && attempt.outcome === undefined
  }, { path: ['outcome'], error: 'Only terminal attempts have an end time and a matching outcome' })
  .refine(attempt => attempt.endedAt === undefined || attempt.startedAt === undefined || attempt.endedAt >= attempt.startedAt,
    { path: ['endedAt'], error: 'Attempt end precedes start' })
  .refine(attempt => attempt.heartbeatAt === undefined || (
    attempt.startedAt !== undefined && attempt.heartbeatAt >= attempt.startedAt &&
    (attempt.endedAt === undefined || attempt.heartbeatAt <= attempt.endedAt)
  ), { path: ['heartbeatAt'], error: 'Heartbeat must occur within the attempt lifetime' })
  .refine(attempt => {
    const releasedAt = attempt.worker?.releasedAt
    return releasedAt === undefined || (attempt.status !== 'running' && attempt.startedAt !== undefined
      && releasedAt >= attempt.startedAt && (attempt.endedAt === undefined || releasedAt <= attempt.endedAt))
  }, { path: ['worker', 'releasedAt'], error: 'Worker release must occur within the attempt lifetime' })

export type Owner = z.infer<typeof ownerSchema>
export type Profile = z.infer<typeof profileSchema>
export type SourceEvent = z.infer<typeof sourceEventSchema>
export type Conversation = z.infer<typeof conversationSchema>
export type Project = z.infer<typeof projectSchema>
export type Task = z.infer<typeof taskSchema>
export type TaskStatus = z.infer<typeof taskStatusSchema>
export type WaitReason = z.infer<typeof waitReasonSchema>
export type Attempt = z.infer<typeof attemptSchema>
export type AttemptStatus = z.infer<typeof attemptStatusSchema>
export type MandateRef = z.infer<typeof mandateRefSchema>

const principalSchema = z.strictObject({
  ...ownership,
  accountId: accountIdSchema.optional(),
  deviceId: deviceIdSchema.optional(),
})

const actionScopeSchema = z.strictObject({
  kind: nonEmptyTextSchema,
  resourceRef: nonEmptyTextSchema,
  accountId: accountIdSchema.optional(),
  recipient: nonEmptyTextSchema.optional(),
  dataScope: textListSchema,
  limits: z.strictObject({ maxUses: z.int().positive().optional() }),
})

export const grantSchema = z.strictObject({
  id: grantIdSchema,
  ...ownership,
  approvingPrincipal: principalSchema,
  action: actionScopeSchema,
  expiresAt: utcInstantSchema,
  approvalEvidence: z.strictObject({ requestId: requestIdSchema, approvedAt: utcInstantSchema }),
  policyVersion: nonEmptyTextSchema,
  revokedAt: utcInstantSchema.optional(),
}).refine(grant => grant.ownerId === grant.approvingPrincipal.ownerId && grant.profileId === grant.approvingPrincipal.profileId,
  { path: ['approvingPrincipal'], error: 'The approving principal must belong to the grant owner and profile' })

const requestFields = {
  id: requestIdSchema,
  ...ownership,
  taskId: taskIdSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  displayText: nonEmptyTextSchema,
  expiresAt: utcInstantSchema,
}

export const approvalSchema = z.strictObject({
  kind: z.literal('approval'),
  ...requestFields,
  action: actionScopeSchema.extend({ payloadDigest: sha256DigestSchema }),
  policyVersion: nonEmptyTextSchema,
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
  responseActor: principalSchema.optional(),
}).refine(request => (request.status === 'approved' || request.status === 'denied') === (request.responseActor !== undefined),
  { path: ['responseActor'], error: 'A decided approval requires a response actor' })
  .refine(request => request.responseActor === undefined || (
    request.ownerId === request.responseActor.ownerId && request.profileId === request.responseActor.profileId
  ), { path: ['responseActor'], error: 'The response actor must belong to the request owner and profile' })

export const questionSchema = z.strictObject({
  kind: z.literal('question'),
  ...requestFields,
  question: nonEmptyTextSchema,
  status: z.enum(['pending', 'answered', 'expired', 'cancelled']),
  response: z.strictObject({ actor: principalSchema, text: nonEmptyTextSchema }).optional(),
}).refine(request => (request.status === 'answered') === (request.response !== undefined),
  { path: ['response'], error: 'An answered question requires a response' })
  .refine(request => request.response === undefined || (
    request.ownerId === request.response.actor.ownerId && request.profileId === request.response.actor.profileId
  ), { path: ['response', 'actor'], error: 'The response actor must belong to the request owner and profile' })

export const interactionRequestSchema = z.discriminatedUnion('kind', [approvalSchema, questionSchema])

export const providerReceiptSchema = z.strictObject({
  providerReceiptId: nonEmptyTextSchema,
  recordedAt: utcInstantSchema,
})

export const effectReconciliationSchema = z.strictObject({
  reason: nonEmptyTextSchema,
  checkedAt: utcInstantSchema.optional(),
  providerLookupId: nonEmptyTextSchema.optional(),
})

const effectBaseSchema = z.strictObject({
  operationId: operationIdSchema,
  taskId: taskIdSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  intent: nonEmptyTextSchema,
  payloadDigest: sha256DigestSchema,
  providerIdempotencyKey: nonEmptyTextSchema.optional(),
})
const grantedEffectSchema = effectBaseSchema.extend({ grantId: grantIdSchema })

export const effectSchema = z.discriminatedUnion('status', [
  effectBaseSchema.extend({ status: z.literal('prepared') }),
  grantedEffectSchema.extend({ status: z.enum(['authorized', 'dispatching']) }),
  grantedEffectSchema.extend({
    status: z.literal('confirmed'),
    receipt: providerReceiptSchema,
    reconciliation: effectReconciliationSchema.optional(),
  }),
  grantedEffectSchema.extend({
    status: z.literal('failed'),
    failureReason: nonEmptyTextSchema,
    reconciliation: effectReconciliationSchema.optional(),
  }),
  grantedEffectSchema.extend({
    status: z.enum(['uncertain', 'manual_reconciliation']),
    reconciliation: effectReconciliationSchema,
  }),
])

const outboxBaseSchema = z.strictObject({
  id: deliveryIdSchema,
  ...ownership,
  destination: deliveryDestinationSchema,
  payload: z.strictObject({ text: nonEmptyTextSchema.optional(), artifactIds: z.array(artifactIdSchema) })
    .refine(payload => payload.text !== undefined || payload.artifactIds.length > 0, 'Expected text or an artifact reference'),
  dedupeKey: nonEmptyTextSchema,
  retries: z.int().nonnegative(),
})

export const deliverySchema = z.discriminatedUnion('status', [
  outboxBaseSchema.extend({ status: z.literal('pending'), nextAttemptAt: utcInstantSchema.optional() }),
  outboxBaseSchema.extend({ status: z.literal('dispatching') }),
  outboxBaseSchema.extend({ status: z.literal('uncertain'), reconciliation: effectReconciliationSchema }),
  outboxBaseSchema.extend({ status: z.enum(['accepted', 'delivered', 'read']), receipt: providerReceiptSchema }),
  outboxBaseSchema.extend({ status: z.literal('failed'), failureReason: nonEmptyTextSchema }),
])
export const outboxItemSchema = deliverySchema

export const artifactSchema = z.strictObject({
  id: artifactIdSchema,
  ...ownership,
  attemptId: attemptIdSchema,
  contentHash: sha256DigestSchema,
  storageRef: nonEmptyTextSchema,
  mediaType: z.string().regex(/^[^\s/]+\/[^\s/]+$/, 'Expected a media type'),
  provenance: z.strictObject({ sourceEventIds: z.array(sourceEventIdSchema) }),
  visibility: z.enum(['private', 'shared']),
  retainUntil: utcInstantSchema.optional(),
})

export const memoryRecordSchema = z.strictObject({
  id: memoryRecordIdSchema,
  ...ownership,
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('profile') }),
    z.strictObject({ kind: z.literal('project'), projectId: projectIdSchema }),
    z.strictObject({ kind: z.literal('task'), taskId: taskIdSchema }),
  ]),
  value: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('fact'), text: nonEmptyTextSchema }),
    z.strictObject({ kind: z.literal('reference'), ref: nonEmptyTextSchema }),
  ]),
  sourceEventIds: z.array(sourceEventIdSchema).min(1),
  validFrom: utcInstantSchema,
  validUntil: utcInstantSchema.optional(),
  origin: z.enum(['explicit', 'inferred']),
  confidence: z.number().min(0).max(1),
  supersededBy: memoryRecordIdSchema.optional(),
  deletionVersion: versionSchema.optional(),
}).refine(record => record.validUntil === undefined || record.validUntil >= record.validFrom,
  { path: ['validUntil'], error: 'Memory validity ends before it starts' })

export const scheduleSchema = z.strictObject({
  id: scheduleIdSchema,
  ...ownership,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('task'), taskId: taskIdSchema }),
    z.strictObject({ kind: z.literal('rule'), ruleId: ruleIdSchema }),
  ]),
  timeZone: timeZoneSchema,
  nextOccurrenceAt: utcInstantSchema.optional(),
  localTimeIntent: nonEmptyTextSchema,
  recurrenceRule: nonEmptyTextSchema.optional(),
  missedRunPolicy: z.enum(['skip', 'latest']),
  lease: z.strictObject({ holderId: nonEmptyTextSchema, expiresAt: utcInstantSchema }).optional(),
  lastResult: z.strictObject({
    occurrenceAt: utcInstantSchema,
    status: z.enum(['queued', 'skipped', 'failed']),
  }).optional(),
})

export type Grant = z.infer<typeof grantSchema>
export type Approval = z.infer<typeof approvalSchema>
export type Question = z.infer<typeof questionSchema>
export type Effect = z.infer<typeof effectSchema>
export type Delivery = z.infer<typeof deliverySchema>
export type OutboxItem = z.infer<typeof outboxItemSchema>
export type Artifact = z.infer<typeof artifactSchema>
export type MemoryRecord = z.infer<typeof memoryRecordSchema>
export type Schedule = z.infer<typeof scheduleSchema>
