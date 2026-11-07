import { z } from 'zod'
import {
  attemptIdSchema, clientIdSchema, commandIdSchema, deviceIdSchema, generationSchema, nonEmptyTextSchema,
  ownerIdSchema, profileIdSchema, projectIdSchema, sessionIdSchema, sourceEventIdSchema, sourceInstanceIdSchema,
  taskIdSchema, timeZoneSchema, utcInstantSchema, versionSchema,
} from './model.js'

const key = nonEmptyTextSchema.max(512)
const positiveVersion = versionSchema.min(1)
export const routineScopeSchema = z.strictObject({ ownerId: ownerIdSchema, profileId: profileIdSchema })
export type RoutineScope = z.infer<typeof routineScopeSchema>
export const routineIdSchema = z.string().regex(/^[^\s\p{Cc}]+$/u).max(512).brand<'RoutineId'>()
export type RoutineId = z.infer<typeof routineIdSchema>
export const routineRefSchema = routineScopeSchema.extend({ routineId: routineIdSchema })
export type RoutineRef = z.infer<typeof routineRefSchema>
export const ROUTINE_SOURCE = sourceInstanceIdSchema.parse('dshpa-internal-routine')

export const routineAuthoritySchema = z.strictObject({
  clientId: clientIdSchema,
  deviceId: deviceIdSchema,
  verifiedAt: utcInstantSchema,
  policyVersion: key,
})
export type RoutineAuthority = z.infer<typeof routineAuthoritySchema>

export const goalAdmissionSchema = z.strictObject({
  grantsCurrent: z.boolean(), budgetAvailable: z.boolean(), conditionSatisfied: z.boolean(),
})
export type GoalAdmission = z.infer<typeof goalAdmissionSchema>

export const routineTimingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('at'), at: utcInstantSchema }),
  z.strictObject({ kind: z.literal('cron'), expression: nonEmptyTextSchema.max(256) }),
])
export const routineTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reminder'), text: nonEmptyTextSchema.max(4_096) }),
  z.strictObject({
    kind: z.literal('goal'), taskId: taskIdSchema, projectId: projectIdSchema, attemptId: attemptIdSchema,
    generation: generationSchema, expectedVersion: versionSchema, waitReference: key,
  }),
])
export type RoutineTarget = z.infer<typeof routineTargetSchema>
export type RoutineGoal = Extract<RoutineTarget, { kind: 'goal' }>
export const routineIntentSchema = z.strictObject({
  title: nonEmptyTextSchema.max(120),
  timing: routineTimingSchema,
  timeZone: timeZoneSchema,
  localTimeIntent: key,
  dst: z.strictObject({ gap: z.literal('skip'), overlap: z.literal('earlier') }),
  misfire: z.enum(['skip', 'latest']),
  target: routineTargetSchema,
})
export type RoutineIntent = z.infer<typeof routineIntentSchema>
export const createRoutineSchema = routineIntentSchema.extend({ id: routineIdSchema })

export const routineSchema = createRoutineSchema.extend({
  ...routineScopeSchema.shape,
  revision: positiveVersion,
  status: z.enum(['draft', 'armed', 'paused', 'ended']),
  authority: routineAuthoritySchema.optional(),
  nextIntendedAt: utcInstantSchema.optional(),
  updatedAt: utcInstantSchema,
}).refine(routine => (routine.status === 'armed') === (routine.nextIntendedAt !== undefined)
  && (routine.status === 'armed' || routine.status === 'ended') === (routine.authority !== undefined)
  && (routine.authority === undefined || routine.authority.verifiedAt <= routine.updatedAt))
export type Routine = z.infer<typeof routineSchema>

const change = { expectedRevision: positiveVersion, at: utcInstantSchema }
export const updateRoutineSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('arm'), ...change, authority: routineAuthoritySchema, nextIntendedAt: utcInstantSchema }),
  z.strictObject({ type: z.literal('pause'), ...change }),
  z.strictObject({ type: z.literal('edit'), ...change, intent: routineIntentSchema }),
])

export const mappingIdSchema = z.string().regex(/^routine-map-[a-f0-9]{64}$/u)
export const occurrenceIdSchema = z.string().regex(/^routine-occ-[a-f0-9]{64}$/u)
const terminalReason = z.enum([
  'cancelled', 'abandoned_intent', 'missing_native', 'changed_native', 'ambiguous_native', 'native_receipt_mismatch',
])
export const routineMappingSchema = routineRefSchema.extend({
  id: mappingIdSchema,
  title: nonEmptyTextSchema.max(120),
  routineRevision: positiveVersion,
  intendedAt: utcInstantSchema,
  nativeWakeAt: utcInstantSchema,
  mailboxId: sessionIdSchema,
  marker: z.string().regex(/^dshpa-routine:[a-f0-9]{64}$/u),
  state: z.enum(['intent', 'bound', 'uncertain', 'terminal']),
  terminalReason: terminalReason.optional(),
  nativeId: key.optional(),
  version: positiveVersion,
}).refine(mapping => mapping.nativeWakeAt >= mapping.intendedAt
  && (mapping.state !== 'bound' || mapping.nativeId !== undefined)
  && (mapping.state !== 'intent' || mapping.nativeId === undefined)
  && (mapping.state === 'terminal' || mapping.terminalReason === undefined))
export type RoutineMapping = z.infer<typeof routineMappingSchema>

export const reserveRoutineMappingSchema = z.strictObject({
  ...change, intendedAt: utcInstantSchema, nativeWakeAt: utcInstantSchema, mailboxId: sessionIdSchema,
})
const mappingMutation = { mappingId: mappingIdSchema, expectedVersion: positiveVersion }
export const updateRoutineMappingSchema = z.strictObject({
  ...mappingMutation,
  state: z.enum(['bound', 'uncertain', 'terminal']),
  nativeId: key.optional(),
  terminalReason: terminalReason.optional(),
}).refine(value => value.state === 'terminal' || value.terminalReason === undefined)
export const retimeRoutineMappingSchema = z.strictObject({ ...mappingMutation, nativeWakeAt: utcInstantSchema })
export const skipRoutineMisfireSchema = z.strictObject({
  ...change, expectedIntendedAt: utcInstantSchema, nextIntendedAt: utcInstantSchema.optional(),
  mappingId: mappingIdSchema.optional(), expectedMappingVersion: positiveVersion.optional(),
}).refine(value => (value.mappingId === undefined) === (value.expectedMappingVersion === undefined))

export const routineNativeReceiptSchema = z.strictObject({
  nativeId: key,
  messageId: key,
  scheduledAt: utcInstantSchema,
  deliveredAt: utcInstantSchema,
  targetSessionId: sessionIdSchema,
  prompt: key,
}).refine(receipt => receipt.deliveredAt >= receipt.scheduledAt)
export type RoutineNativeReceipt = z.infer<typeof routineNativeReceiptSchema>

export const routineSkipReasonSchema = z.enum([
  'misfire', 'stale_revision', 'mapping_terminal', 'authority_changed', 'target_unavailable',
  'stale_attempt', 'version_conflict', 'wait_unavailable', 'grant_unavailable', 'budget_unavailable',
  'condition_unmet', 'runtime_not_quiescent', 'recovery_required', 'effects_unsettled',
])
export type RoutineSkipReason = z.infer<typeof routineSkipReasonSchema>

export const routineOccurrenceSchema = routineRefSchema.extend({
  id: occurrenceIdSchema,
  title: nonEmptyTextSchema.max(120),
  routineRevision: positiveVersion,
  intendedAt: utcInstantSchema,
  observedAt: utcInstantSchema,
  kind: z.enum(['scheduled', 'manual']),
  status: z.enum(['reminded', 'queued', 'skipped']),
  reason: routineSkipReasonSchema.optional(),
  reminderText: nonEmptyTextSchema.max(4_096).optional(),
  taskId: taskIdSchema.optional(),
  taskVersion: positiveVersion.optional(),
  sourceEventId: sourceEventIdSchema.optional(),
  nativeReceipt: routineNativeReceiptSchema.optional(),
}).refine(occurrence => occurrence.observedAt >= occurrence.intendedAt
  && (occurrence.status === 'reminded') === (occurrence.reminderText !== undefined)
  && (occurrence.status === 'skipped') === (occurrence.reason !== undefined)
  && (occurrence.status === 'queued'
    ? occurrence.taskId !== undefined && occurrence.taskVersion !== undefined && occurrence.sourceEventId !== undefined
    : occurrence.taskId === undefined && occurrence.taskVersion === undefined && occurrence.sourceEventId === undefined)
  && (occurrence.nativeReceipt === undefined
    || (occurrence.kind === 'scheduled' && occurrence.nativeReceipt.deliveredAt <= occurrence.observedAt)))
export type RoutineOccurrence = z.infer<typeof routineOccurrenceSchema>

export const completeRoutineOccurrenceSchema = z.strictObject({
  mappingId: mappingIdSchema,
  receipt: routineNativeReceiptSchema,
  intendedAt: utcInstantSchema,
  nextIntendedAt: utcInstantSchema.optional(),
  at: utcInstantSchema,
  authority: routineAuthoritySchema.optional(),
  goalAdmission: goalAdmissionSchema.optional(),
  skipReason: z.literal('misfire').optional(),
})

export const runRoutineNowSchema = z.strictObject({
  ...change, commandId: commandIdSchema, authority: routineAuthoritySchema, goalAdmission: goalAdmissionSchema.optional(),
})
