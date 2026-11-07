import { z } from 'zod'
import {
  artifactIdSchema,
  attemptIdSchema,
  attemptSchema,
  attemptScopeSchema,
  generationSchema,
  mandateRefSchema,
  nonEmptyTextSchema,
  sessionIdSchema,
  taskIdSchema,
  taskSchema,
  utcInstantSchema,
  versionSchema,
  waitReasonSchema,
  workerCursorSchema,
  workerExecutionSchema,
  WORKER_INPUT_LIMIT,
} from './model.js'
import type { Attempt, Task, WaitReason } from './model.js'

const waitingStatuses = {
  input: 'waiting_input',
  approval: 'waiting_approval',
  event: 'waiting_event',
  environment: 'waiting_environment',
  resource: 'waiting_resource',
  dependency: 'blocked',
} as const satisfies Record<WaitReason['reason'], Task['status']>

const attemptStatuses = {
  queued: 'queued',
  running: 'running',
  waiting_input: 'waiting',
  waiting_approval: 'waiting',
  waiting_event: 'waiting',
  waiting_environment: 'waiting',
  waiting_resource: 'waiting',
  blocked: 'waiting',
  paused: 'paused',
  verifying: 'verifying',
  cancelling: 'cancelling',
  reconciliation_required: 'cancelling',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const satisfies Record<Task['status'], Attempt['status']>

function mustBeRetired(status: Task['status']): boolean {
  return status === 'cancelling' || status === 'reconciliation_required' || status === 'cancelled'
}

function matchesAttempt({ task, attempt }: { task: Task; attempt: Attempt }): boolean {
  const distance = task.generation - attempt.generation
  const generationMatches = mustBeRetired(task.status)
    ? distance === 1
    : distance === 0 || (distance === 1 && (task.status === 'completed' || task.status === 'failed'))
  const hasRequiredEvidence = task.status !== 'completed' || (
    attempt.outcome?.status === 'completed'
    && (!task.acceptance.requiresArtifact || attempt.artifactIds.length > 0)
    && (!task.acceptance.requiresReceipt || attempt.outcome.receiptId !== undefined)
  )
  const waitMatchesExecution = task.wait === undefined || (
    task.wait.reason === 'dependency'
      ? task.wait.referenceId !== task.id
      : attempt.startedAt !== undefined
  )
  return task.id === attempt.taskId
    && task.attemptId === attempt.id
    && task.ownerId === attempt.mandate.ownerId
    && task.profileId === attempt.mandate.profileId
    && attemptStatuses[task.status] === attempt.status
    && generationMatches
    && hasRequiredEvidence
    && (attempt.worker?.releasedAt === undefined || attempt.worker.releasedAt <= task.updatedAt)
    && waitMatchesExecution
}

export const workStateSchema = z.strictObject({ task: taskSchema, attempt: attemptSchema })
  .refine(matchesAttempt, { message: 'The current attempt does not match the task' })

const versioned = { expectedVersion: versionSchema, at: utcInstantSchema }
const fenced = { ...versioned, attemptId: attemptIdSchema, generation: generationSchema }
const replacement = { ...versioned, attemptId: attemptIdSchema, mandate: mandateRefSchema }
const admission = {
  policyVersion: nonEmptyTextSchema,
  conditionSatisfied: z.boolean(),
  grantsCurrent: z.boolean(),
  budgetAvailable: z.boolean(),
  runtimeQuiescent: z.boolean(),
}
export const artifactIdsSchema = z.array(artifactIdSchema).refine(ids => new Set(ids).size === ids.length, {
  message: 'Artifact identifiers must be unique',
})
const verificationEvidenceSchema = z.strictObject({
  criteriaSatisfied: z.boolean(),
  artifactIds: artifactIdsSchema,
  receiptId: nonEmptyTextSchema.optional(),
})
const reconciliationOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), evidence: verificationEvidenceSchema }),
  z.strictObject({ status: z.literal('failed'), reason: nonEmptyTextSchema }),
  z.strictObject({ status: z.literal('cancelled') }),
])

/** Shape validation. The caller must establish each event's authority. */
export const workEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('cancel'), ...versioned }),
  z.strictObject({ type: z.literal('pause'), ...versioned }),
  z.strictObject({ type: z.literal('resume'), ...versioned, ...admission }),
  z.strictObject({ type: z.literal('retry'), ...replacement }),
  z.strictObject({ type: z.literal('reopen'), ...replacement }),
  z.strictObject({
    type: z.literal('start'),
    ...fenced,
    executor: nonEmptyTextSchema,
    agentId: nonEmptyTextSchema.optional(),
    sessionId: sessionIdSchema.optional(),
    scope: attemptScopeSchema.optional(),
    worker: workerExecutionSchema.optional(),
  }),
  z.strictObject({ type: z.literal('record_input'), ...fenced, cursor: workerCursorSchema }),
  z.strictObject({
    type: z.literal('wait'),
    ...fenced,
    wait: waitReasonSchema,
    // The scheduler reads the predecessor chain from its current task snapshot.
    dependencyChain: z.array(taskIdSchema).min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('wake'),
    ...fenced,
    ...admission,
    reason: waitReasonSchema.shape.reason,
    referenceId: waitReasonSchema.shape.referenceId,
  }),
  z.strictObject({ type: z.literal('ready'), ...fenced, artifactIds: artifactIdsSchema }),
  z.strictObject({ type: z.literal('release_worker'), ...fenced }),
  z.strictObject({ type: z.literal('verify'), ...fenced, evidence: verificationEvidenceSchema }),
  z.strictObject({
    type: z.literal('fail'),
    ...fenced,
    reason: nonEmptyTextSchema,
    runtimeQuiescent: z.boolean(),
    uncertainEffects: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('confirm_cancel'),
    ...fenced,
    runtimeQuiescent: z.boolean(),
    uncertainEffects: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('reconcile'),
    ...fenced,
    runtimeQuiescent: z.boolean(),
    outcome: reconciliationOutcomeSchema,
  }),
])

export type WorkState = z.infer<typeof workStateSchema>
export type WorkEvent = z.infer<typeof workEventSchema>

export type TransitionErrorCode =
  | 'invalid_input'
  | 'version_conflict'
  | 'stale_attempt'
  | 'invalid_transition'
  | 'policy_changed'
  | 'permission_denied'
  | 'budget_exceeded'
  | 'condition_unmet'
  | 'runtime_not_quiescent'
  | 'outcome_uncertain'
  | 'acceptance_unsatisfied'

export type WorkTransitionResult =
  | { ok: true; state: WorkState; previousAttempt?: Attempt }
  | { ok: false; code: TransitionErrorCode }

function reject(code: TransitionErrorCode): WorkTransitionResult {
  return { ok: false, code }
}

function advance(
  state: WorkState,
  status: Task['status'],
  attempt: Attempt,
  at: WorkEvent['at'],
  { generation = state.task.generation, wait }: { generation?: number; wait?: WaitReason } = {},
): WorkTransitionResult {
  const { wait: _oldWait, ...task } = state.task
  const version = task.version + 1
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(generation)) return reject('invalid_input')
  return {
    ok: true,
    state: {
      task: {
        ...task,
        status,
        version,
        generation,
        updatedAt: at,
        attemptId: attempt.id,
        ...(wait === undefined ? {} : { wait: { ...wait } }),
      },
      attempt,
    },
  }
}

function admissionError(
  attempt: Attempt,
  event: Extract<WorkEvent, { type: 'resume' | 'wake' }>,
): TransitionErrorCode | undefined {
  if (event.policyVersion !== attempt.mandate.policyVersion) return 'policy_changed'
  if (!event.grantsCurrent) return 'permission_denied'
  if (!event.budgetAvailable) return 'budget_exceeded'
  if (!event.conditionSatisfied) return 'condition_unmet'
  if (!event.runtimeQuiescent) return 'runtime_not_quiescent'
  return undefined
}

type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>
type SettledOutcome = NonNullable<Attempt['outcome']>

function settle(
  state: WorkState,
  at: WorkEvent['at'],
  outcome: SettledOutcome,
  { generation, artifactIds = state.attempt.artifactIds }: { generation?: number; artifactIds?: Attempt['artifactIds'] } = {},
): WorkTransitionResult {
  return advance(state, outcome.status, {
    ...state.attempt,
    status: outcome.status,
    endedAt: at,
    outcome,
    artifactIds: [...artifactIds],
  }, at, { generation })
}

function complete(
  state: WorkState,
  evidence: VerificationEvidence,
  at: WorkEvent['at'],
  isReconciled: boolean,
): WorkTransitionResult {
  const acceptance = state.task.acceptance
  const { artifactIds, receiptId } = evidence
  if (!evidence.criteriaSatisfied
    || (acceptance.requiresArtifact && artifactIds.length === 0)
    || (acceptance.requiresReceipt && receiptId === undefined)
    || (!isReconciled && artifactIds.some(id => !state.attempt.artifactIds.includes(id)))) {
    return reject('acceptance_unsatisfied')
  }
  // A trusted reconciler can verify late evidence from the exact retired attempt.
  return settle(state, at, {
    status: 'completed',
    summary: isReconciled ? 'Completion confirmed by reconciliation' : 'Acceptance verified',
    ...(receiptId === undefined ? {} : { receiptId }),
  }, { artifactIds })
}

function replaceAttempt(state: WorkState, event: Extract<WorkEvent, { type: 'retry' | 'reopen' }>) {
  const { task, attempt } = state
  if (event.attemptId === attempt.id
    || event.mandate.ownerId !== task.ownerId
    || event.mandate.profileId !== task.profileId) return reject('invalid_input')
  const generation = task.generation + 1
  const result = advance(state, 'queued', {
    id: event.attemptId,
    taskId: task.id,
    generation,
    status: 'queued',
    mandate: Object.freeze({ ...event.mandate }),
    artifactIds: [],
  }, event.at, { generation })
  return result.ok ? { ...result, previousAttempt: attempt } : result
}

function cancel(state: WorkState, at: WorkEvent['at']): WorkTransitionResult {
  const { task, attempt } = state
  if (mustBeRetired(task.status)) return { ok: true, state }
  if (task.status === 'completed' || task.status === 'failed') return reject('invalid_transition')
  const generation = task.generation + 1
  if (attempt.startedAt === undefined) {
    return settle(state, at, { status: 'cancelled', summary: 'Cancelled before execution' }, { generation })
  }
  // Advancing the Task generation fences the old worker before the caller stops it.
  return advance(state, 'cancelling', { ...attempt, status: 'cancelling' }, at, { generation })
}

function isFenced(
  event: WorkEvent,
): event is Extract<WorkEvent, { generation: number }> {
  return 'generation' in event
}

function hasCurrentFence(state: WorkState, event: Extract<WorkEvent, { generation: number }>): boolean {
  return event.attemptId === state.attempt.id
    && event.generation === state.attempt.generation
    && (event.type === 'confirm_cancel' || event.type === 'reconcile'
      || event.generation === state.task.generation)
}

/** Compute one deterministic state change. Persistence and external actions belong to the caller. */
export function transitionWork(state: WorkState, event: WorkEvent): WorkTransitionResult {
  const { task, attempt } = state

  if (!matchesAttempt(state)) return reject('invalid_input')
  if (event.expectedVersion !== task.version) return reject('version_conflict')
  if (isFenced(event) && !hasCurrentFence(state, event)) return reject('stale_attempt')
  const latest = attempt.endedAt ?? attempt.heartbeatAt ?? attempt.startedAt
  if (event.at < task.updatedAt || (latest !== undefined && event.at < latest)) return reject('invalid_input')

  switch (event.type) {
    case 'cancel':
      return cancel(state, event.at)
    case 'pause':
      if (mustBeRetired(task.status) || task.status === 'paused' || task.status === 'completed' || task.status === 'failed') {
        return reject('invalid_transition')
      }
      return advance(state, 'paused', { ...attempt, status: 'paused' }, event.at, { wait: task.wait })
    case 'resume':
    case 'wake': {
      if (event.type === 'resume') {
        if (task.status !== 'paused') return reject('invalid_transition')
      } else {
        if (attempt.status !== 'waiting' || task.wait === undefined) return reject('invalid_transition')
        if (event.reason !== task.wait.reason || event.referenceId !== task.wait.referenceId) {
          return reject('condition_unmet')
        }
      }
      const error = admissionError(attempt, event)
      if (error !== undefined) return reject(error)
      return advance(state, 'queued', { ...attempt, status: 'queued' }, event.at)
    }
    case 'retry':
      return task.status === 'failed' ? replaceAttempt(state, event) : reject('invalid_transition')
    case 'reopen':
      return task.status === 'completed' || task.status === 'cancelled'
        ? replaceAttempt(state, event)
        : reject('invalid_transition')
    case 'start': {
      if (task.status !== 'queued') return reject('invalid_transition')
      const { worker } = event
      if (worker) {
        const history = attempt.worker?.inputHistory ?? []
        if (event.sessionId === undefined || worker.releasedAt !== undefined || history.includes(worker.inputCursor)
          || worker.inputHistory.length !== history.length + 1
          || history.some((cursor, index) => worker.inputHistory[index] !== cursor)
          || worker.inputHistory.at(-1) !== worker.inputCursor) return reject('invalid_input')
      }
      if (attempt.worker && (!worker || event.sessionId !== attempt.sessionId
        || worker.presetId !== attempt.worker.presetId || worker.cwd !== attempt.worker.cwd
        || worker.provider !== attempt.worker.provider || worker.model !== attempt.worker.model)) return reject('invalid_input')
      const { agentId: _agentId, sessionId: _sessionId, scope: _scope, worker: _worker, ...queued } = attempt
      return advance(state, 'running', {
        ...queued,
        status: 'running',
        executor: event.executor,
        startedAt: attempt.startedAt ?? event.at,
        heartbeatAt: event.at,
        ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ...(worker === undefined ? {} : { worker: { ...worker, inputHistory: [...worker.inputHistory] } }),
        ...(event.scope === undefined ? {} : { scope: {
          capabilities: [...event.scope.capabilities],
          dataScope: [...event.scope.dataScope],
        } }),
      }, event.at)
    }
    case 'record_input':
      if (task.status !== 'running' || !attempt.worker || attempt.worker.inputHistory.includes(event.cursor)
        || attempt.worker.inputHistory.length >= WORKER_INPUT_LIMIT) {
        return reject('invalid_transition')
      }
      return advance(state, 'running', {
        ...attempt,
        worker: { ...attempt.worker, inputCursor: event.cursor, inputHistory: [...attempt.worker.inputHistory, event.cursor] },
      }, event.at)
    case 'wait': {
      const dependencyWait = event.wait.reason === 'dependency'
      if (dependencyWait) {
        const chain = event.dependencyChain
        if (chain?.[0] !== event.wait.referenceId || chain.includes(task.id)
          || new Set(chain).size !== chain.length) return reject('condition_unmet')
      } else if (event.dependencyChain !== undefined) {
        return reject('invalid_input')
      }
      if (task.status !== 'running' && task.status !== 'verifying'
        && !(task.status === 'queued' && dependencyWait)) return reject('invalid_transition')
      return advance(state, waitingStatuses[event.wait.reason], { ...attempt, status: 'waiting' }, event.at, { wait: event.wait })
    }
    case 'ready':
      if (task.status !== 'running') return reject('invalid_transition')
      return advance(state, 'verifying', { ...attempt, status: 'verifying', artifactIds: [...event.artifactIds] }, event.at)
    case 'release_worker':
      if ((task.status !== 'verifying' && task.status !== 'paused' && attempt.status !== 'waiting')
        || !attempt.worker || attempt.worker.releasedAt !== undefined) {
        return reject('invalid_transition')
      }
      return advance(state, task.status, { ...attempt, worker: { ...attempt.worker, releasedAt: event.at } }, event.at, {
        wait: task.wait,
      })
    case 'verify':
      return task.status === 'verifying'
        ? complete(state, event.evidence, event.at, false)
        : reject('invalid_transition')
    case 'fail':
      if (task.status !== 'running' && task.status !== 'verifying') return reject('invalid_transition')
      if (!event.runtimeQuiescent) return reject('runtime_not_quiescent')
      if (event.uncertainEffects) return reject('outcome_uncertain')
      return settle(state, event.at, { status: 'failed', summary: event.reason })
    case 'confirm_cancel':
      if (task.status !== 'cancelling') return reject('invalid_transition')
      if (!event.runtimeQuiescent) return reject('runtime_not_quiescent')
      if (event.uncertainEffects) return advance(state, 'reconciliation_required', attempt, event.at)
      return settle(state, event.at, { status: 'cancelled', summary: 'Cancellation confirmed' })
    case 'reconcile':
      if (task.status !== 'reconciliation_required') return reject('invalid_transition')
      if (!event.runtimeQuiescent) return reject('runtime_not_quiescent')
      switch (event.outcome.status) {
        case 'completed':
          return complete(state, event.outcome.evidence, event.at, true)
        case 'failed':
          return settle(state, event.at, { status: 'failed', summary: event.outcome.reason })
        case 'cancelled':
          return settle(state, event.at, { status: 'cancelled', summary: 'Cancellation confirmed by reconciliation' })
      }
  }
}
