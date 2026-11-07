import { z } from 'zod'
import {
  attemptIdSchema,
  commandIdSchema,
  conversationIdSchema,
  generationSchema,
  projectIdSchema,
  taskDefinitionSchema,
  taskIdSchema,
  versionSchema,
  waitReasonSchema,
  type Attempt,
  type AttemptId,
  type ClientId,
  type Conversation,
  type DeviceId,
  type MandateRef,
  type OwnerId,
  type ProfileId,
  type Project,
  type SourceEventId,
  type Task,
  type TaskId,
  type UtcInstant,
} from './model.js'
import { artifactIdsSchema, transitionWork, type WorkState, type WorkTransitionResult } from './transitions.js'

const commandFields = {
  commandId: commandIdSchema,
  conversationId: conversationIdSchema.optional(),
}
const emptyPayload = z.strictObject({})
const createWorkSchema = z.strictObject({
  ...commandFields,
  type: z.literal('work.create'),
  payload: taskDefinitionSchema.extend({ projectId: projectIdSchema }),
})

export const workCommandSchema = z.discriminatedUnion('type', [
  createWorkSchema,
  z.strictObject({
    ...commandFields,
    type: z.literal('work.get'),
    taskId: taskIdSchema,
    payload: emptyPayload,
  }),
  z.strictObject({
    ...commandFields,
    type: z.enum(['work.pause', 'work.cancel', 'work.resume', 'work.retry', 'work.reopen']),
    taskId: taskIdSchema,
    expectedVersion: versionSchema,
    payload: emptyPayload,
  }),
])

export type WorkCommand = z.infer<typeof workCommandSchema>

interface WorkScope {
  readonly ownerId: OwnerId
  readonly profileId: ProfileId
}

interface OwnerActor extends WorkScope {
  readonly role: 'owner'
  readonly clientId: ClientId
  readonly deviceId: DeviceId
  readonly policyVersion: string
}

interface WorkerActor extends WorkScope {
  readonly role: 'worker'
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly generation: number
  readonly expectedVersion: number
}

interface AttemptAllocation {
  readonly id: AttemptId
  readonly mandate: MandateRef
}

interface ResumeCheck {
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly generation: number
  readonly expectedVersion: number
  readonly policyVersion: string
  readonly grantsCurrent: boolean
  readonly budgetAvailable: boolean
  readonly conditionSatisfied: boolean
  readonly runtimeQuiescent: boolean
}

/** The caller supplies authenticated identity, scoped snapshots, and trusted admission facts. */
export interface WorkCommandContext {
  readonly actor?: OwnerActor | { readonly role: 'worker' | 'system' }
  readonly at: UtcInstant
  readonly state?: WorkState
  /** When present, commands run within this trusted project. */
  readonly project?: Project
  /** When present, commands run within this trusted conversation. */
  readonly conversation?: Conversation
  readonly sourceEventIds?: readonly SourceEventId[]
  readonly newTaskId?: TaskId
  readonly newAttempt?: AttemptAllocation
  readonly resume?: ResumeCheck
}

export type WorkCommandResult = WorkTransitionResult | {
  ok: false
  code: 'invalid_command' | 'permission_denied' | 'not_found' | 'resource_unavailable'
}

function sameScope(left: WorkScope, right: WorkScope): boolean {
  return left.ownerId === right.ownerId && left.profileId === right.profileId
}

function ownedTask(
  state: WorkState | undefined,
  actor: WorkScope,
  taskId: TaskId,
): state is WorkState {
  return state !== undefined && state.task.id === taskId && sameScope(state.task, actor)
    && state.attempt.taskId === state.task.id && state.task.attemptId === state.attempt.id
    && sameScope(state.attempt.mandate, actor)
}

function canUseMandate(actor: OwnerActor, mandate: MandateRef): boolean {
  return sameScope(actor, mandate) && actor.policyVersion === mandate.policyVersion
}

function createWork(
  command: z.infer<typeof createWorkSchema>,
  context: WorkCommandContext,
  actor: OwnerActor,
): WorkCommandResult {
  const { project, conversation, newTaskId, newAttempt } = context
  if (project?.id !== command.payload.projectId) {
    return { ok: false, code: 'not_found' }
  }
  if (command.conversationId !== undefined && conversation?.id !== command.conversationId) {
    return { ok: false, code: 'not_found' }
  }
  if (!newTaskId || !newAttempt) return { ok: false, code: 'resource_unavailable' }
  if (!canUseMandate(actor, newAttempt.mandate)) return { ok: false, code: 'permission_denied' }

  const task: Task = {
    ...command.payload,
    id: newTaskId,
    ownerId: actor.ownerId,
    profileId: actor.profileId,
    conversationId: conversation?.id,
    provenance: { sourceEventIds: [...(context.sourceEventIds ?? [])] },
    version: 1,
    generation: 1,
    status: 'queued',
    attemptId: newAttempt.id,
    createdAt: context.at,
    updatedAt: context.at,
  }
  const attempt: Attempt = {
    id: newAttempt.id,
    taskId: task.id,
    generation: task.generation,
    status: 'queued',
    mandate: Object.freeze({ ...newAttempt.mandate }),
    artifactIds: [],
  }
  return { ok: true, state: { task, attempt } }
}

/** Validate the public envelope and apply an owner operation without I/O. */
export function handleWorkCommand(input: unknown, context: WorkCommandContext): WorkCommandResult {
  if (context.actor?.role !== 'owner') return { ok: false, code: 'permission_denied' }
  const decoded = workCommandSchema.safeParse(input)
  if (!decoded.success) return { ok: false, code: 'invalid_command' }
  return applyWorkCommand(decoded.data, context)
}

/** Apply a decoded command against the caller's current, scoped snapshot. */
export function applyWorkCommand(command: WorkCommand, context: WorkCommandContext): WorkCommandResult {
  const { actor, state, at, project, conversation } = context
  if (actor?.role !== 'owner') return { ok: false, code: 'permission_denied' }
  if ((project !== undefined && !sameScope(actor, project))
    || (conversation !== undefined && !sameScope(actor, conversation))) {
    return { ok: false, code: 'not_found' }
  }
  if (command.type === 'work.create') return createWork(command, context, actor)

  if (!ownedTask(state, actor, command.taskId)
    || (project !== undefined && project.id !== state.task.projectId)
    || (conversation !== undefined && conversation.id !== state.task.conversationId)
    || (command.conversationId !== undefined && command.conversationId !== state.task.conversationId)) {
    return { ok: false, code: 'not_found' }
  }
  if (command.type === 'work.get') return { ok: true, state }
  const { expectedVersion } = command
  if (expectedVersion !== state.task.version) return { ok: false, code: 'version_conflict' }

  switch (command.type) {
    case 'work.pause':
      return transitionWork(state, { type: 'pause', expectedVersion, at })
    case 'work.cancel':
      return transitionWork(state, { type: 'cancel', expectedVersion, at })
    case 'work.resume': {
      const check = context.resume
      if (!check || check.taskId !== state.task.id || check.attemptId !== state.attempt.id
        || check.generation !== state.attempt.generation || check.expectedVersion !== expectedVersion
        || check.policyVersion !== actor.policyVersion) {
        return { ok: false, code: 'permission_denied' }
      }
      return transitionWork(state, {
        type: 'resume',
        expectedVersion,
        at,
        policyVersion: check.policyVersion,
        grantsCurrent: check.grantsCurrent,
        budgetAvailable: check.budgetAvailable,
        conditionSatisfied: check.conditionSatisfied,
        runtimeQuiescent: check.runtimeQuiescent,
      })
    }
    case 'work.retry':
    case 'work.reopen': {
      const { newAttempt } = context
      if (!newAttempt) return { ok: false, code: 'resource_unavailable' }
      if (!canUseMandate(actor, newAttempt.mandate)) return { ok: false, code: 'permission_denied' }
      return transitionWork(state, {
        type: command.type === 'work.retry' ? 'retry' : 'reopen',
        expectedVersion,
        at,
        attemptId: newAttempt.id,
        mandate: newAttempt.mandate,
      })
    }
  }
}

const reportFields = {
  taskId: taskIdSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  expectedVersion: versionSchema,
}

export const workerReportSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...reportFields, type: z.literal('ready'), artifactIds: artifactIdsSchema }),
  z.strictObject({ ...reportFields, type: z.literal('wait'), wait: waitReasonSchema }),
])

export interface WorkerReportContext {
  readonly actor?: WorkerActor
  readonly at: UtcInstant
  readonly state: WorkState
}

/** A worker may report readiness or waiting. Settlement requires a trusted coordinator. */
export function handleWorkerReport(input: unknown, context: WorkerReportContext): WorkCommandResult {
  const { actor, at, state } = context
  if (actor?.role !== 'worker') return { ok: false, code: 'permission_denied' }
  const decoded = workerReportSchema.safeParse(input)
  if (!decoded.success) return { ok: false, code: 'invalid_command' }
  const { taskId, ...report } = decoded.data
  if (!ownedTask(state, actor, taskId) || actor.taskId !== taskId
    || actor.attemptId !== report.attemptId || actor.generation !== report.generation
    || actor.expectedVersion !== report.expectedVersion) {
    return { ok: false, code: 'permission_denied' }
  }
  // The scheduler verifies the dependency graph before admitting a dependency wait.
  if (report.type === 'wait' && report.wait.reason === 'dependency') {
    return { ok: false, code: 'permission_denied' }
  }
  return transitionWork(state, { ...report, at })
}
