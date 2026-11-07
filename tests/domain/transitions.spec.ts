import { describe, expect, it } from 'vitest'
import {
  artifactIdSchema,
  attemptIdSchema,
  attemptSchema,
  clientIdSchema,
  conversationSchema,
  deliverySchema,
  deviceIdSchema,
  effectSchema,
  ownerIdSchema,
  profileIdSchema,
  projectSchema,
  sourceEventIdSchema,
  taskSchema,
  utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { handleWorkCommand, handleWorkerReport } from '../../packages/personal-agent/src/domain/commands.js'
import {
  transitionWork,
  workStateSchema,
  type WorkEvent,
  type WorkState,
} from '../../packages/personal-agent/src/domain/transitions.js'

const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const artifactId = artifactIdSchema.parse('artifact-1')
const receiptId = 'receipt-1'
const verifiedEvidence = { criteriaSatisfied: true, artifactIds: [artifactId], receiptId }

function queued(suffix = '1'): WorkState {
  const task = taskSchema.parse({
    id: `task-${suffix}`,
    ownerId: 'owner-1',
    profileId: 'profile-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    requestedOutcome: 'Provide the requested artifact and receipt.',
    constraints: ['Use only authorized sources.'],
    acceptance: { criteria: ['Artifact can be opened.'], requiresArtifact: true, requiresReceipt: true },
    provenance: { sourceEventIds: [] },
    version: 0,
    generation: 1,
    status: 'queued',
    attemptId: `attempt-${suffix}`,
    createdAt: at,
    updatedAt: at,
  })
  const attempt = attemptSchema.parse({
    id: task.attemptId,
    taskId: task.id,
    generation: task.generation,
    status: 'queued',
    mandate: { id: 'mandate-1', ownerId: task.ownerId, profileId: task.profileId, policyVersion: 'policy-1' },
    artifactIds: [],
  })
  return { task, attempt }
}

function revision(state: WorkState) {
  return { expectedVersion: state.task.version, at }
}

function attemptRevision(state: WorkState) {
  return {
    ...revision(state),
    attemptId: state.attempt.id,
    generation: state.attempt.generation,
  }
}

function apply(state: WorkState, event: WorkEvent) {
  const result = transitionWork(state, event)
  if (!result.ok) throw new Error(`${event.type} rejected with ${result.code}`)
  workStateSchema.parse(result.state)
  return result
}

function start(state: WorkState) {
  return apply(state, { type: 'start', ...attemptRevision(state), executor: 'native-dsh' }).state
}

function workerActor(state: WorkState) {
  const { ownerId, profileId, id: taskId } = state.task
  const { id: attemptId, generation } = state.attempt
  return { role: 'worker', ownerId, profileId, taskId, attemptId, generation, expectedVersion: state.task.version } as const
}

function ready(state: WorkState) {
  const actor = workerActor(state)
  const result = handleWorkerReport({
    type: 'ready',
    taskId: actor.taskId,
    attemptId: actor.attemptId,
    generation: actor.generation,
    expectedVersion: actor.expectedVersion,
    artifactIds: [artifactId],
  }, { actor, state, at })
  if (!result.ok) throw new Error(`ready report rejected with ${result.code}`)
  return result.state
}

describe('work transitions', () => {
  it('fences task revisions and attempts and keeps two tasks in one conversation independent', () => {
    const first = queued()
    const second = queued('2')
    const running = start(first)
    expect(running.task).toMatchObject({ status: 'running', version: first.task.version + 1 })
    expect(running.attempt).toMatchObject({ taskId: first.task.id, status: 'running' })
    expect(second.task).toMatchObject({ conversationId: first.task.conversationId, status: 'queued' })
    expect(second.attempt.id).not.toBe(running.attempt.id)

    expect(transitionWork(running, { type: 'pause', ...revision(first) }))
      .toMatchObject({ ok: false, code: 'version_conflict' })
    expect(transitionWork(running, {
      type: 'ready', ...attemptRevision(running), attemptId: second.attempt.id, artifactIds: [artifactId],
    })).toMatchObject({ ok: false, code: 'stale_attempt' })
    expect(transitionWork(running, {
      type: 'ready', ...attemptRevision(running), generation: running.attempt.generation + 1, artifactIds: [artifactId],
    })).toMatchObject({ ok: false, code: 'stale_attempt' })
    expect(transitionWork(running, {
      type: 'pause', ...revision(running), at: utcInstantSchema.parse('2026-11-07T07:59:59.999Z'),
    }))
      .toMatchObject({ ok: false, code: 'invalid_input' })
    expect(first.task.status).toBe('queued')
    expect(running.task.status).toBe('running')
  })

  it('requires trusted verification and all acceptance evidence after a worker ready report', () => {
    const running = start(queued())
    const actor = workerActor(running)
    const report = {
      type: 'ready',
      taskId: actor.taskId,
      attemptId: actor.attemptId,
      generation: actor.generation,
      expectedVersion: running.task.version,
      artifactIds: [artifactId],
    }
    expect(handleWorkerReport({ ...report, type: 'verify', evidence: verifiedEvidence }, { actor, state: running, at }))
      .toMatchObject({ ok: false })
    expect(handleWorkerReport(report, { actor: { ...actor, taskId: queued('2').task.id }, state: running, at }))
      .toMatchObject({ ok: false })
    const { artifactIds: _artifactIds, ...reportFence } = report
    expect(handleWorkerReport({ ...reportFence, type: 'fail', reason: 'Model guessed failure.' }, { actor, state: running, at }))
      .toMatchObject({ ok: false, code: 'invalid_command' })

    const verifying = ready(running)
    expect(verifying.task.status).toBe('verifying')
    expect(verifying.attempt.status).toBe('verifying')
    const verify = (evidence: { criteriaSatisfied: boolean, artifactIds: typeof artifactId[], receiptId?: string }) =>
      transitionWork(verifying, { type: 'verify', ...attemptRevision(verifying), evidence })

    for (const evidence of [
      { ...verifiedEvidence, criteriaSatisfied: false },
      { ...verifiedEvidence, artifactIds: [] },
      { ...verifiedEvidence, artifactIds: [artifactIdSchema.parse('unreported-artifact')] },
      { criteriaSatisfied: true, artifactIds: [artifactId] },
    ]) {
      expect(verify(evidence)).toMatchObject({ ok: false, code: 'acceptance_unsatisfied' })
    }
    expect(verify(verifiedEvidence)).toMatchObject({
      ok: true,
      state: {
        task: { status: 'completed', version: verifying.task.version + 1 },
        attempt: { status: 'completed', artifactIds: [artifactId] },
      },
    })
    expect(verifying.task.status).toBe('verifying')
  })

  it('revalidates policy, current conditions and runtime quiescence before resuming paused work', () => {
    const running = start(queued())
    const paused = apply(running, { type: 'pause', ...revision(running) }).state
    expect(paused.task.status).toBe('paused')
    const resume = {
      type: 'resume',
      ...revision(paused),
      policyVersion: paused.attempt.mandate.policyVersion,
      conditionSatisfied: true,
      runtimeQuiescent: true,
      grantsCurrent: true,
      budgetAvailable: true,
    } as const
    expect(transitionWork(paused, { ...resume, policyVersion: 'policy-2' }))
      .toMatchObject({ ok: false, code: 'policy_changed' })
    expect(transitionWork(paused, { ...resume, conditionSatisfied: false }))
      .toMatchObject({ ok: false, code: 'condition_unmet' })
    expect(transitionWork(paused, { ...resume, grantsCurrent: false }))
      .toMatchObject({ ok: false, code: 'permission_denied' })
    expect(transitionWork(paused, { ...resume, budgetAvailable: false }))
      .toMatchObject({ ok: false, code: 'budget_exceeded' })
    expect(transitionWork(paused, { ...resume, runtimeQuiescent: false }))
      .toMatchObject({ ok: false, code: 'runtime_not_quiescent' })
    const resumed = apply(paused, resume).state
    expect(resumed.task).toMatchObject({ status: 'queued', version: paused.task.version + 1 })
    expect(resumed.attempt).toMatchObject({
      id: paused.attempt.id,
      status: 'queued',
      generation: paused.attempt.generation,
      mandate: paused.attempt.mandate,
    })
    const restarted = start(resumed)
    expect(handleWorkerReport({
      type: 'ready',
      taskId: restarted.task.id,
      attemptId: restarted.attempt.id,
      generation: restarted.attempt.generation,
      expectedVersion: restarted.task.version,
      artifactIds: [artifactId],
    }, { actor: workerActor(running), state: restarted, at }))
      .toEqual({ ok: false, code: 'permission_denied' })
    expect(ready(restarted).task.status).toBe('verifying')
  })

  it('wakes only the exact scoped wait at its current revision and policy', () => {
    const running = start(queued())
    const wait = {
      reason: 'input',
      referenceId: 'question-1',
      deadline: utcInstantSchema.parse('2026-11-07T09:00:00.000Z'),
      resumeCondition: 'A verified reply to the pending question.',
    } as const
    const waiting = apply(running, { type: 'wait', ...attemptRevision(running), wait }).state
    expect(waiting.task).toMatchObject({ status: 'waiting_input', wait })
    expect(waiting.attempt.status).toBe('waiting')
    const wake = {
      type: 'wake',
      ...attemptRevision(waiting),
      reason: wait.reason,
      referenceId: wait.referenceId,
      policyVersion: waiting.attempt.mandate.policyVersion,
      conditionSatisfied: true,
      runtimeQuiescent: true,
      grantsCurrent: true,
      budgetAvailable: true,
    } as const
    expect(transitionWork(waiting, { ...wake, referenceId: 'question-2' })).toMatchObject({ ok: false })
    expect(transitionWork(waiting, { ...wake, reason: 'approval' })).toMatchObject({ ok: false })
    expect(transitionWork(waiting, { ...wake, expectedVersion: running.task.version }))
      .toMatchObject({ ok: false, code: 'version_conflict' })
    expect(transitionWork(waiting, { ...wake, policyVersion: 'policy-2' }))
      .toMatchObject({ ok: false, code: 'policy_changed' })
    expect(transitionWork(waiting, { ...wake, conditionSatisfied: false }))
      .toMatchObject({ ok: false, code: 'condition_unmet' })
    const awakened = apply(waiting, wake).state
    expect(awakened.task.status).toBe('queued')
    expect(awakened.task.wait).toBeUndefined()
    expect(awakened.attempt.id).toBe(waiting.attempt.id)
    expect(transitionWork(awakened, { ...wake, ...attemptRevision(awakened) }))
      .toMatchObject({ ok: false, code: 'invalid_transition' })
  })

  it('retires a cancelled generation and reconciles only its exact attempt', () => {
    const running = start(queued())
    const cancelling = apply(running, { type: 'cancel', ...revision(running) }).state
    expect(cancelling.task).toMatchObject({ status: 'cancelling', generation: running.task.generation + 1 })
    expect(cancelling.attempt).toMatchObject({ id: running.attempt.id, generation: running.attempt.generation })
    expect(transitionWork(cancelling, { type: 'ready', ...attemptRevision(cancelling), artifactIds: [artifactId] }))
      .toMatchObject({ ok: false, code: 'stale_attempt' })
    expect(apply(cancelling, { type: 'cancel', ...revision(cancelling) }).state).toEqual(cancelling)
    const confirm = {
      type: 'confirm_cancel',
      ...attemptRevision(cancelling),
      runtimeQuiescent: true,
      uncertainEffects: true,
    } as const
    expect(transitionWork(cancelling, { ...confirm, runtimeQuiescent: false }))
      .toMatchObject({ ok: false, code: 'runtime_not_quiescent' })
    expect(transitionWork(cancelling, { ...confirm, generation: cancelling.task.generation }))
      .toMatchObject({ ok: false, code: 'stale_attempt' })

    const uncertain = apply(cancelling, confirm).state
    expect(uncertain.task.status).toBe('reconciliation_required')
    const reconcile = {
      type: 'reconcile',
      ...attemptRevision(uncertain),
      runtimeQuiescent: true,
      outcome: { status: 'completed', evidence: verifiedEvidence },
    } as const
    expect(transitionWork(uncertain, { ...reconcile, attemptId: attemptIdSchema.parse('attempt-other') }))
      .toMatchObject({ ok: false, code: 'stale_attempt' })
    expect(transitionWork(uncertain, { ...reconcile, runtimeQuiescent: false }))
      .toMatchObject({ ok: false, code: 'runtime_not_quiescent' })
    expect(transitionWork(uncertain, {
      ...reconcile,
      outcome: { status: 'completed', evidence: { criteriaSatisfied: true, artifactIds: [] } },
    })).toMatchObject({ ok: false, code: 'acceptance_unsatisfied' })
    expect(apply(uncertain, reconcile).state.task.status).toBe('completed')
  })

  it('can block a queued dependency without starting a worker and rejects dependency cycles', () => {
    const initial = queued()
    const predecessor = queued('2').task.id
    const wait = {
      reason: 'dependency',
      referenceId: predecessor,
      resumeCondition: 'The predecessor is complete.',
    } as const
    const block: WorkEvent = { type: 'wait', ...attemptRevision(initial), wait, dependencyChain: [predecessor] }
    expect(transitionWork(initial, { ...block, dependencyChain: undefined }))
      .toEqual({ ok: false, code: 'condition_unmet' })
    expect(transitionWork(initial, { ...block, dependencyChain: [predecessor, initial.task.id] }))
      .toEqual({ ok: false, code: 'condition_unmet' })
    const blocked = apply(initial, block).state
    expect(blocked.task).toMatchObject({ status: 'blocked', wait })
    expect(blocked.attempt.startedAt).toBeUndefined()
    const cancelled = apply(blocked, { type: 'cancel', ...revision(blocked) }).state
    expect(cancelled.task.status).toBe('cancelled')
  })

  it('cancels an unstarted task immediately and prevents its original attempt from starting', () => {
    const initial = queued()
    const result = handleWorkCommand({
      type: 'work.cancel',
      commandId: 'command-cancel',
      taskId: initial.task.id,
      expectedVersion: initial.task.version,
      payload: {},
    }, { ...ownerContext(initial), state: initial })
    if (!result.ok) throw new Error(`cancel rejected with ${result.code}`)
    const cancelled = result.state
    expect(cancelled.task).toMatchObject({ status: 'cancelled', generation: initial.task.generation + 1 })
    expect(cancelled.attempt.status).toBe('cancelled')
    expect(transitionWork(cancelled, { type: 'start', ...attemptRevision(cancelled), executor: 'native-dsh' }))
      .toMatchObject({ ok: false, code: 'stale_attempt' })
  })
})

const destination = { sourceInstanceId: 'source-1', externalDestinationId: 'thread-1' }

function ownerContext(state: WorkState = queued()) {
  const { ownerId, profileId, conversationId, projectId } = state.task
  const actor = {
    role: 'owner',
    ownerId,
    profileId,
    clientId: clientIdSchema.parse('client-1'),
    deviceId: deviceIdSchema.parse('device-1'),
    policyVersion: state.attempt.mandate.policyVersion,
  } as const
  const conversation = conversationSchema.parse({
    id: conversationId,
    ownerId,
    profileId,
    sessionIds: [],
    originalDestination: destination,
  })
  const project = projectSchema.parse({
    id: projectId,
    ownerId,
    profileId,
    kind: 'goal',
    title: 'Useful independent work',
    purpose: 'Track an outcome across tasks.',
    resourceRefs: [],
    status: 'active',
    successCriteria: ['Both tasks provide verifiable artifacts.'],
    planRevision: 1,
    milestones: [],
  })
  return { actor, at, project, conversation }
}

describe('owner work commands', () => {
  it('creates a task and initial attempt for a verified owner and returns its state only within scope', () => {
    const seeded = queued()
    const context = ownerContext(seeded)
    const { requestedOutcome, constraints, acceptance, projectId, conversationId } = seeded.task
    const create = {
      type: 'work.create',
      commandId: 'command-create',
      conversationId,
      payload: { projectId, requestedOutcome, constraints, acceptance },
    }
    const allocation = {
      newTaskId: seeded.task.id,
      newAttempt: { id: seeded.attempt.id, mandate: seeded.attempt.mandate },
    }
    expect(handleWorkCommand(create, { ...context, ...allocation, actor: undefined }))
      .toMatchObject({ ok: false, code: 'permission_denied' })
    expect(handleWorkCommand({ ...create, payload: { ...create.payload, ownerId: seeded.task.ownerId } }, {
      ...context, ...allocation,
    })).toMatchObject({ ok: false, code: 'invalid_command' })
    const result = handleWorkCommand(create, { ...context, ...allocation })
    expect(result).toMatchObject({
      ok: true,
      state: {
        task: { id: allocation.newTaskId, projectId, conversationId, status: 'queued', acceptance },
        attempt: { id: allocation.newAttempt.id, taskId: allocation.newTaskId, status: 'queued' },
      },
    })
    if (!result.ok) throw new Error('Expected an admitted task')
    const { state } = result
    expect(state.task.attemptId).toBe(state.attempt.id)
    expect(state.task.generation).toBe(state.attempt.generation)
    const second = queued('2')
    const sourceEventIds = [sourceEventIdSchema.parse('source-event-1')]
    expect(handleWorkCommand({ ...create, commandId: 'command-create-2', conversationId: undefined }, {
      ...context,
      newTaskId: second.task.id,
      newAttempt: { id: second.attempt.id, mandate: second.attempt.mandate },
      sourceEventIds,
    })).toMatchObject({
      ok: true,
      state: {
        task: { id: second.task.id, conversationId, provenance: { sourceEventIds } },
        attempt: { id: second.attempt.id, taskId: second.task.id },
      },
    })

    const get = { type: 'work.get', commandId: 'command-get', taskId: state.task.id, conversationId, payload: {} }
    expect(handleWorkCommand(get, { ...context, state })).toEqual({ ok: true, state })
    expect(handleWorkCommand({ ...get, taskId: 'invalid task id' }, { ...context, state }))
      .toMatchObject({ ok: false, code: 'invalid_command' })
    expect(handleWorkCommand({ ...get, conversationId: 'conversation-other' }, { ...context, state }))
      .toEqual({ ok: false, code: 'not_found' })
    const otherConversation = conversationSchema.parse({ ...context.conversation, id: 'conversation-other' })
    expect(handleWorkCommand({ ...get, conversationId: undefined }, {
      ...context, conversation: otherConversation, state,
    })).toEqual({ ok: false, code: 'not_found' })
    const otherProject = projectSchema.parse({ ...context.project, id: 'project-other' })
    expect(handleWorkCommand(get, { ...context, project: otherProject, state }))
      .toEqual({ ok: false, code: 'not_found' })
    const otherActor = { ...context.actor, ownerId: ownerIdSchema.parse('owner-2') }
    expect(handleWorkCommand(get, { ...context, actor: otherActor, state })).toEqual({ ok: false, code: 'not_found' })
    expect(handleWorkCommand(get, {
      ...context, actor: { ...context.actor, profileId: profileIdSchema.parse('profile-2') }, state,
    })).toEqual({ ok: false, code: 'not_found' })
  })

  it('requires resume revalidation bound to the current task, attempt, and version', () => {
    const running = start(queued())
    const context = ownerContext(running)
    const pause = {
      type: 'work.pause',
      commandId: 'command-pause',
      taskId: running.task.id,
      conversationId: running.task.conversationId,
      expectedVersion: running.task.version,
      payload: {},
    }
    const result = handleWorkCommand(pause, { ...context, state: running })
    if (!result.ok) throw new Error(`pause rejected with ${result.code}`)
    const { state } = result
    const resume = { ...pause, type: 'work.resume', commandId: 'command-resume', expectedVersion: state.task.version }
    const revalidation = {
      taskId: state.task.id,
      attemptId: state.attempt.id,
      generation: state.attempt.generation,
      expectedVersion: state.task.version,
      policyVersion: context.actor.policyVersion,
      grantsCurrent: true,
      budgetAvailable: true,
      conditionSatisfied: true,
      runtimeQuiescent: true,
    }
    expect(handleWorkCommand(resume, { ...context, state })).toMatchObject({ ok: false, code: 'permission_denied' })
    expect(handleWorkCommand({ ...resume, payload: revalidation }, { ...context, state }))
      .toMatchObject({ ok: false, code: 'invalid_command' })
    expect(handleWorkCommand(resume, {
      ...context, state, resume: { ...revalidation, attemptId: attemptIdSchema.parse('attempt-other') },
    })).toMatchObject({ ok: false, code: 'permission_denied' })
    expect(handleWorkCommand(resume, {
      ...context, state, resume: { ...revalidation, expectedVersion: running.task.version },
    })).toMatchObject({ ok: false, code: 'permission_denied' })
    expect(handleWorkCommand(resume, {
      ...context, state, resume: { ...revalidation, generation: revalidation.generation + 1 },
    })).toMatchObject({ ok: false, code: 'permission_denied' })
    expect(handleWorkCommand(resume, {
      ...context, state, resume: revalidation, actor: { ...context.actor, policyVersion: 'policy-2' },
    })).toMatchObject({ ok: false, code: 'permission_denied' })
    expect(handleWorkCommand(resume, { ...context, state, resume: revalidation }))
      .toMatchObject({ ok: true, state: { task: { status: 'queued' }, attempt: { id: state.attempt.id } } })
  })

  it('requires explicit owner retry or reopen and retains each ended attempt', () => {
    const running = start(queued())
    const fail = {
      type: 'fail',
      ...attemptRevision(running),
      reason: 'Fixture work failed.',
      runtimeQuiescent: true,
      uncertainEffects: false,
    } as const
    expect(transitionWork(running, { ...fail, uncertainEffects: true }))
      .toMatchObject({ ok: false, code: 'outcome_uncertain' })
    expect(transitionWork(running, { ...fail, runtimeQuiescent: false }))
      .toMatchObject({ ok: false, code: 'runtime_not_quiescent' })
    const failed = apply(running, fail).state
    const context = ownerContext(failed)
    const retry = {
      type: 'work.retry',
      commandId: 'command-retry',
      taskId: failed.task.id,
      conversationId: failed.task.conversationId,
      expectedVersion: failed.task.version,
      payload: {},
    }
    const next = { id: attemptIdSchema.parse('attempt-retry'), mandate: failed.attempt.mandate }
    expect(handleWorkCommand(retry, { ...context, state: failed, newAttempt: next, actor: undefined }))
      .toMatchObject({ ok: false, code: 'permission_denied' })
    expect(handleWorkCommand(retry, {
      ...context, state: failed, newAttempt: { ...next, id: failed.attempt.id },
    })).toMatchObject({ ok: false })
    expect(handleWorkCommand(retry, { ...context, state: failed, newAttempt: next })).toMatchObject({
      ok: true,
      previousAttempt: failed.attempt,
      state: {
        task: { id: failed.task.id, status: 'queued', generation: failed.task.generation + 1 },
        attempt: { id: next.id, taskId: failed.task.id, status: 'queued' },
      },
    })

    const verifying = ready(running)
    const completed = apply(verifying, { type: 'verify', ...attemptRevision(verifying), evidence: verifiedEvidence }).state
    const reopen = { ...retry, type: 'work.reopen', commandId: 'command-reopen', expectedVersion: completed.task.version }
    expect(handleWorkCommand(reopen, { ...context, state: completed, newAttempt: next, actor: { role: 'system' } }))
      .toMatchObject({ ok: false, code: 'permission_denied' })
    expect(handleWorkCommand({ ...reopen, type: 'work.retry' }, { ...context, state: completed, newAttempt: next }))
      .toMatchObject({ ok: false, code: 'invalid_transition' })
    expect(handleWorkCommand(reopen, { ...context, state: completed, newAttempt: next })).toMatchObject({
      ok: true,
      previousAttempt: completed.attempt,
      state: {
        task: { id: completed.task.id, status: 'queued', generation: completed.task.generation + 1 },
        attempt: { id: next.id, taskId: completed.task.id, status: 'queued' },
      },
    })
  })
})

describe('durable record decoders', () => {
  it('loads a valid Task and Attempt and rejects a mismatched pair', () => {
    const running = start(queued())
    expect(workStateSchema.parse(JSON.parse(JSON.stringify(running)))).toEqual(running)
    expect(workStateSchema.safeParse({ task: running.task, attempt: start(queued('2')).attempt }).success).toBe(false)
    expect(workStateSchema.safeParse({
      ...running, task: { ...running.task, generation: running.task.generation + 1 },
    }).success).toBe(false)
  })

  it('rejects persisted runtime bindings without a start and completed work without required evidence', () => {
    const initial = queued()
    expect(workStateSchema.safeParse({
      ...initial, attempt: { ...initial.attempt, agentId: 'bound-native-agent' },
    }).success).toBe(false)

    const verifying = ready(start(initial))
    const completed = apply(verifying, {
      type: 'verify', ...attemptRevision(verifying), evidence: verifiedEvidence,
    }).state
    expect(workStateSchema.safeParse(completed).success).toBe(true)
    expect(workStateSchema.safeParse({
      ...completed, attempt: { ...completed.attempt, artifactIds: [] },
    }).success).toBe(false)
    expect(workStateSchema.safeParse({
      ...completed,
      attempt: { ...completed.attempt, outcome: { ...completed.attempt.outcome, receiptId: undefined } },
    }).success).toBe(false)
  })

  it('keeps an uncertain Effect distinct from a confirmed Effect with a receipt', () => {
    const state = start(queued())
    const effect = {
      operationId: 'operation-1',
      taskId: state.task.id,
      attemptId: state.attempt.id,
      generation: state.attempt.generation,
      intent: 'Send the approved payload.',
      payloadDigest: 'a'.repeat(64),
      grantId: 'grant-1',
      providerIdempotencyKey: 'effect-key',
    }
    const reconciliation = { reason: 'The provider timed out after dispatch.' }
    const receipt = { providerReceiptId: 'provider-receipt-1', recordedAt: at }
    expect(effectSchema.parse({ ...effect, status: 'uncertain', reconciliation }))
      .toMatchObject({ status: 'uncertain', reconciliation })
    expect(effectSchema.safeParse({ ...effect, status: 'uncertain' }).success).toBe(false)
    expect(effectSchema.safeParse({ ...effect, status: 'confirmed' }).success).toBe(false)
    const confirmed = effectSchema.parse({ ...effect, status: 'confirmed', receipt })
    expect(effectSchema.parse(JSON.parse(JSON.stringify(confirmed)))).toEqual(confirmed)
    expect(deliverySchema.safeParse(confirmed).success).toBe(false)
  })

  it('preserves separate pending, uncertain, provider accepted, and delivered states', () => {
    const delivery = {
      id: 'delivery-1',
      ownerId: 'owner-1',
      profileId: 'profile-1',
      destination,
      payload: { text: 'The requested artifact is available.', artifactIds: [artifactId] },
      dedupeKey: 'deliver-task-1',
      retries: 1,
    }
    const receipt = { providerReceiptId: 'provider-delivery-1', recordedAt: at }
    expect(deliverySchema.parse({ ...delivery, status: 'pending', nextAttemptAt: at }))
      .toMatchObject({ status: 'pending', nextAttemptAt: at })
    const reconciliation = { reason: 'Transport lost contact before the provider returned a receipt.' }
    expect(deliverySchema.parse({ ...delivery, status: 'uncertain', reconciliation }))
      .toMatchObject({ status: 'uncertain', reconciliation })
    expect(deliverySchema.safeParse({ ...delivery, status: 'uncertain', nextAttemptAt: at }).success).toBe(false)
    expect(deliverySchema.safeParse({ ...delivery, status: 'accepted' }).success).toBe(false)
    expect(deliverySchema.safeParse({ ...delivery, status: 'delivered' }).success).toBe(false)
    const accepted = deliverySchema.parse({ ...delivery, status: 'accepted', receipt })
    const delivered = deliverySchema.parse({ ...delivery, status: 'delivered', receipt })
    expect(accepted.status).toBe('accepted')
    expect(delivered.status).toBe('delivered')
    expect(effectSchema.safeParse(accepted).success).toBe(false)
  })
})
