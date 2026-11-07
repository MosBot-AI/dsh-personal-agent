import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  artifactIdSchema,
  attemptIdSchema,
  commandIdSchema,
  conversationIdSchema,
  conversationSchema,
  mandateRefSchema,
  nonEmptyTextSchema,
  projectIdSchema,
  projectSchema,
  requestIdSchema,
  sessionIdSchema,
  sha256DigestSchema,
  sourceEventSchema,
  sourceInstanceIdSchema,
  taskIdSchema,
  utcInstantSchema,
  versionSchema,
  workerCursorSchema,
  type SessionId,
  type TaskId,
  type UtcInstant,
} from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import type { IdentityBoundary, OwnerIdentity } from '../policy/identity.js'
import type { ExecutorResult, WorkerExecutor } from '../runtime/executor.js'
import { workerInputSchema } from '../runtime/reports.js'
import { StorageError } from '../storage/schema.js'
import type { WorkRef, WorkStore } from '../storage/store.js'
import type { InboxResponse, InboxSession, InboxTask } from './protocol.js'

const LOCAL_SOURCE = sourceInstanceIdSchema.parse('dshpa-local-inbox')
const MAX_SESSIONS = 64
const command = commandIdSchema.max(256)
const control = { taskId: taskIdSchema, expectedVersion: versionSchema }
const answerFields = {
  cursor: workerCursorSchema,
  referenceId: nonEmptyTextSchema.max(4_096),
  text: nonEmptyTextSchema.max(8_192),
}
const answerBodySchema = z.strictObject({ kind: z.literal('inbox-answer'), ...answerFields })

const requestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('snapshot') }),
  z.strictObject({ type: z.literal('create_project'), commandId: command, title: nonEmptyTextSchema.max(256), purpose: nonEmptyTextSchema.max(4_096) }),
  z.strictObject({
    type: z.literal('create_task'), commandId: command, projectId: projectIdSchema,
    sessionId: sessionIdSchema, outcome: nonEmptyTextSchema.max(4_096),
  }),
  z.strictObject({ type: z.literal('start'), ...control, cursor: workerCursorSchema }),
  z.strictObject({ type: z.enum(['pause', 'resume', 'cancel']), ...control, commandId: command }),
  z.strictObject({ type: z.literal('redirect'), ...control, ...workerInputSchema.shape }),
  z.strictObject({ type: z.literal('answer'), ...control, ...answerFields }),
  z.strictObject({ type: z.literal('accept_result'), ...control }),
  z.strictObject({
    type: z.literal('approval'), requestId: requestIdSchema, expectedVersion: versionSchema,
    digest: sha256DigestSchema, decision: z.enum(['approve', 'deny']),
  }),
  z.strictObject({ type: z.literal('artifact'), taskId: taskIdSchema, artifactId: artifactIdSchema }),
])

const nativeSessionSchema = z.strictObject({ id: sessionIdSchema, label: nonEmptyTextSchema.max(1_024) })

export interface InboxServiceOptions {
  readonly store: WorkStore
  readonly executor?: WorkerExecutor
  readonly identity: IdentityBoundary
  readonly resolveSession: (sessionId: SessionId) => boolean | Promise<boolean>
  readonly listSessions?: () => readonly InboxSession[] | Promise<readonly InboxSession[]>
  readonly worker?: { readonly presetId: string; readonly cwd: string; readonly dataScope: readonly string[] }
  readonly actionGate?: ReturnType<WorkStore['createActionGate']>
  readonly now?: () => UtcInstant
}

type CreateTask = Extract<z.infer<typeof requestSchema>, { type: 'create_task' }>

function stableId(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function refFor(owner: OwnerIdentity, taskId: TaskId): WorkRef {
  return { ownerId: owner.ownerId, profileId: owner.profileId, taskId }
}

function failure(code: string): InboxResponse {
  return { ok: false, code }
}

function updated(result: ExecutorResult): InboxResponse {
  return result.ok ? { ok: true, kind: 'updated', taskId: result.state.task.id } : failure(result.code)
}

function nativeReleased(state: WorkState): boolean {
  return state.attempt.startedAt === undefined || state.attempt.worker?.releasedAt !== undefined
}

function terminal(state: WorkState): boolean {
  return state.task.status === 'completed' || state.task.status === 'cancelled' || state.task.status === 'failed'
}

/** Owner-scoped adapter for the native inbox. It never drives a primary agent or recovers cold workers. */
export function createInboxService(options: InboxServiceOptions) {
  const { store, executor, identity, actionGate } = options
  const worker = options.worker && { ...options.worker, dataScope: [...options.worker.dataScope] }
  const now = options.now ?? (() => utcInstantSchema.parse(new Date().toISOString()))

  function ownerCanAccept(ref: WorkRef, state: WorkState, owner: OwnerIdentity): boolean {
    return state.task.status === 'verifying' && state.attempt.worker?.releasedAt !== undefined
      && state.attempt.mandate.policyVersion === owner.policyVersion && !state.task.acceptance.requiresReceipt
      && (state.attempt.scope?.capabilities.length ?? 0) === 0 && state.attempt.artifactIds.length > 0
      && !store.hasUnsettledEffects(ref, state.attempt.id)
  }

  function projectTask(owner: OwnerIdentity, state: WorkState): InboxTask {
    const { task } = state
    const ref = refFor(owner, task.id)
    const conversation = task.conversationId === undefined ? undefined : store.getConversation(owner, task.conversationId)
    const verification = task.status === 'completed' ? store.getVerification(ref, task.version) : undefined
    const candidates = task.status === 'verifying' ? state.attempt.artifactIds : []
    const metadata = store.listInboxArtifacts(ref, verification?.attemptId ?? state.attempt.id,
      verification?.generation ?? state.attempt.generation, verification?.artifacts.map(proof => proof.id) ?? candidates)
    const artifacts = metadata.flatMap(({ artifact, version }) => {
      const proof = verification?.artifacts.find(item => item.id === artifact.id)
      if (verification && (!proof || proof.version !== version || proof.digest !== artifact.contentHash)) return []
      return [{ id: artifact.id, mediaType: artifact.mediaType, version }]
    })
    return {
      id: task.id,
      projectId: task.projectId,
      ...(conversation?.sessionIds[0] === undefined ? {} : { sessionId: conversation.sessionIds[0] }),
      outcome: task.requestedOutcome,
      status: task.status,
      version: task.version,
      runtime: executor?.query(ref).active ? 'active' : nativeReleased(state) || terminal(state) ? 'inactive' : 'unknown',
      ...(task.wait === undefined ? {} : { wait: { reason: task.wait.reason, referenceId: task.wait.referenceId, prompt: task.wait.resumeCondition } }),
      artifacts,
      canAccept: artifacts.length === candidates.length && ownerCanAccept(ref, state, owner),
      deliveries: store.listInboxDeliveries(ref).map(delivery => ({ id: delivery.id, status: delivery.status })),
      ...(verification === undefined ? {} : { verifiedAt: verification.verifiedAt }),
    }
  }

  async function snapshot(ownerToken: unknown): Promise<InboxResponse> {
    const listed = await options.listSessions?.() ?? []
    const owner = identity.resolveOwner(ownerToken)
    if (!owner) return failure('permission_denied')
    const sessions = listed.slice(0, MAX_SESSIONS).flatMap(session => {
      const parsed = nativeSessionSchema.safeParse(session)
      return parsed.success ? [parsed.data] : []
    })
    const work = store.listInboxWork(owner)
    const approvals = actionGate?.pending(ownerToken, work.map(({ task }) => task.id)).map(({ approval, action, version }) => ({
      id: approval.id, taskId: approval.taskId, version, digest: approval.action.payloadDigest,
      expiresAt: approval.expiresAt, kind: action.kind, accountId: action.accountId, resourceRef: action.resourceRef,
      ...(action.recipient === undefined ? {} : { recipient: action.recipient }),
      dataScope: action.dataScope,
      preview: JSON.stringify(action.payload, null, 2),
    })) ?? []
    const recoveryMode = store.recoveryMode()
    return { ok: true, kind: 'snapshot', snapshot: {
      workerConfigured: executor !== undefined && worker !== undefined,
      ...(recoveryMode === 'normal' ? {} : { recoveryMode }),
      sessions,
      projects: store.listInboxProjects(owner).map(({ id, title, purpose }) => ({ id, title, purpose })),
      tasks: work.map(state => projectTask(owner, state)),
      approvals,
    } }
  }

  async function createTask(ownerToken: unknown, request: CreateTask): Promise<InboxResponse> {
    if (!await options.resolveSession(request.sessionId)) return failure('not_found')
    const owner = identity.resolveOwner(ownerToken)
    if (!owner) return failure('permission_denied')
    if (!store.getProject(owner, request.projectId)) return failure('not_found')
    const { ownerId, profileId, clientId, deviceId } = owner
    const conversationId = conversationIdSchema.parse(`inbox-${stableId(ownerId, profileId, request.sessionId)}`)
    const existing = store.getConversation(owner, conversationId)
    if (existing && (existing.sessionIds.length !== 1 || existing.sessionIds[0] !== request.sessionId
      || existing.originalDestination.sourceInstanceId !== LOCAL_SOURCE
      || existing.originalDestination.externalDestinationId !== request.sessionId)) return failure('conflict')
    if (!existing) store.insertConversation(conversationSchema.parse({
      id: conversationId, ownerId, profileId, sessionIds: [request.sessionId],
      originalDestination: { sourceInstanceId: LOCAL_SOURCE, externalDestinationId: request.sessionId },
    }))

    const at = now()
    const eventKey = stableId('task', ownerId, profileId, clientId, request.commandId)
    return updated(store.applyCommand({
      type: 'work.create', commandId: request.commandId, conversationId,
      payload: {
        projectId: request.projectId,
        requestedOutcome: request.outcome,
        constraints: [],
        acceptance: { criteria: [request.outcome], requiresArtifact: true, requiresReceipt: false },
      },
    }, {
      actor: owner, at, projectId: request.projectId, conversationId,
      newTaskId: taskIdSchema.parse(randomUUID()),
      newAttempt: {
        id: attemptIdSchema.parse(randomUUID()),
        mandate: mandateRefSchema.parse({ id: randomUUID(), ownerId, profileId, policyVersion: owner.policyVersion }),
      },
    }, { sourceEvent: sourceEventSchema.parse({
      id: `inbox-${eventKey}`, ownerId, profileId, sourceInstanceId: LOCAL_SOURCE,
      externalEventId: eventKey, externalRevision: '1', occurredAt: at, receivedAt: at, threadId: request.sessionId,
      actor: { kind: 'person', externalActorId: ownerId, deviceId },
      body: { kind: 'inbox-task', outcome: request.outcome }, provenance: { description: 'Native inbox task request' },
    }) }))
  }

  async function handle(ownerToken: unknown, input: unknown): Promise<InboxResponse> {
    const owner = identity.resolveOwner(ownerToken)
    if (!owner) return failure('permission_denied')
    const decoded = requestSchema.safeParse(input)
    if (!decoded.success) return failure('invalid_input')
    const request = decoded.data
    if (store.recoveryMode() === 'restore' && request.type !== 'snapshot' && request.type !== 'artifact'
      && request.type !== 'cancel') return failure('recovery_required')

    try {
      switch (request.type) {
        case 'snapshot': return await snapshot(ownerToken)
        case 'create_task': return await createTask(ownerToken, request)
        case 'create_project': {
          const projectId = projectIdSchema.parse(`inbox-${stableId('project', owner.ownerId, owner.profileId, owner.clientId, request.commandId)}`)
          const existing = store.getProject(owner, projectId)
          if (existing && (existing.title !== request.title || existing.purpose !== request.purpose)) return failure('command_conflict')
          if (!existing) store.insertProject(projectSchema.parse({
            id: projectId, ownerId: owner.ownerId, profileId: owner.profileId, kind: 'project',
            title: request.title, purpose: request.purpose, status: 'active', resourceRefs: [],
            successCriteria: [request.purpose], planRevision: 1, milestones: [],
          }))
          return { ok: true, kind: 'updated', projectId }
        }
        case 'approval': {
          if (!actionGate) return failure('resource_unavailable')
          const { type: _type, ...response } = request
          const result = actionGate.respond(response, ownerToken)
          return result.ok ? { ok: true, kind: 'updated' } : failure(result.code)
        }
      }

      const ref = refFor(owner, request.taskId)
      const state = store.getWork(ref)
      const conversationId = state?.task.conversationId
      const conversation = conversationId === undefined ? undefined : store.getConversation(owner, conversationId)
      if (!state || !conversation) return failure('not_found')

      if (request.type === 'artifact') {
        const verification = state.task.status === 'completed' ? store.getVerification(ref, state.task.version) : undefined
        const proof = verification?.artifacts.find(item => item.id === request.artifactId)
        const candidate = state.task.status === 'verifying' && state.attempt.artifactIds.includes(request.artifactId)
        if (!proof && !candidate) return failure('not_found')
        const sealed = store.artifacts.read(ref, request.artifactId)
        if (!sealed || sealed.artifact.attemptId !== (verification?.attemptId ?? state.attempt.id)
          || sealed.generation !== (verification?.generation ?? state.attempt.generation)
          || (proof && (sealed.version !== proof.version || sealed.artifact.contentHash !== proof.digest))) return failure('not_found')
        return { ok: true, kind: 'artifact', artifact: {
          id: sealed.artifact.id, mediaType: sealed.artifact.mediaType, version: sealed.version,
          text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sealed.bytes),
        } }
      }

      const at = now()
      const context = { actor: owner, at, projectId: state.task.projectId, conversationId: conversation.id }
      if (request.type === 'pause' || request.type === 'cancel') {
        const command = { type: `work.${request.type}`, taskId: ref.taskId, commandId: request.commandId,
          expectedVersion: request.expectedVersion, conversationId: conversation.id, payload: {} }
        if (request.type === 'cancel') return updated(executor?.cancel(command, context) ?? store.applyCommand(command, context))
        if (executor) return updated(executor.pause(command, context))
        return state.task.status === 'queued'
          ? updated(store.applyCommand(command, context)) : failure('runtime_not_quiescent')
      }

      if (request.expectedVersion !== state.task.version) return failure('version_conflict')
      if (request.type === 'accept_result') {
        if (!ownerCanAccept(ref, state, owner)) return failure('invalid_transition')
        const verifier = store.createVerifier({
          now,
          authorizeCommit: () => identity.resolveOwner(ownerToken) !== undefined,
          check: ({ state, artifacts }) => artifacts.length === 0 ? [] : state.task.acceptance.criteria.map(criterion => ({
            criterion, satisfied: true, evidence: 'The authenticated owner accepted the sealed result through the native inbox.',
          })),
        })
        return updated(await verifier.verify(ref, { expectedVersion: request.expectedVersion }))
      }
      if (!executor || !worker) return failure('resource_unavailable')
      if (state.attempt.mandate.policyVersion !== owner.policyVersion) return failure('policy_changed')
      if ((state.attempt.scope?.capabilities.length ?? 0) > 0) return failure('permission_denied')

      if (request.type === 'redirect') return updated(executor.redirect(ref, request.expectedVersion, { cursor: request.cursor, text: request.text }))
      if (!nativeReleased(state)) return failure('runtime_not_quiescent')

      switch (request.type) {
        case 'start': {
          if (state.task.status !== 'queued') return failure('invalid_transition')
          const source = store.getWakeSource(ref, state.task.version)
          const answer = source?.sourceInstanceId === LOCAL_SOURCE ? answerBodySchema.safeParse(source.body) : undefined
          const outcome = state.task.requestedOutcome
          const text = answer?.success ? `${outcome}\n\nOwner answer:\n${answer.data.text}` : outcome
          const cwd = state.attempt.worker?.cwd ?? join(worker.cwd, stableId('workspace', owner.ownerId, owner.profileId, ref.taskId))
          if (state.attempt.worker === undefined) mkdirSync(cwd, { recursive: true, mode: 0o700 })
          const result = await executor.launch(ref, {
            expectedVersion: request.expectedVersion, ...worker, cwd, input: { cursor: request.cursor, text },
          })
          return result.ok ? { ok: true, kind: 'updated', taskId: ref.taskId } : failure(result.code)
        }
        case 'resume': {
          if (state.task.status !== 'paused' || state.task.wait) return failure('invalid_transition')
          return updated(store.applyCommand({
            type: 'work.resume', taskId: ref.taskId, commandId: request.commandId, expectedVersion: request.expectedVersion,
            conversationId: conversation.id, payload: {},
          }, { ...context, resume: {
            taskId: ref.taskId, attemptId: state.attempt.id, generation: state.attempt.generation,
            expectedVersion: request.expectedVersion, policyVersion: owner.policyVersion,
            grantsCurrent: true, budgetAvailable: true, conditionSatisfied: true, runtimeQuiescent: true,
          } }))
        }
        case 'answer': {
          const wait = state.task.wait
          if (state.task.status !== 'waiting_input' || wait?.reason !== 'input' || wait.referenceId !== request.referenceId) {
            return failure('condition_unmet')
          }
          if (wait.deadline !== undefined && at >= wait.deadline) return failure('expired')
          const eventKey = stableId('answer', owner.ownerId, owner.profileId, ref.taskId, state.attempt.id, request.cursor)
          return updated(store.applyEvent(ref, {
            type: 'wake', at, expectedVersion: request.expectedVersion, attemptId: state.attempt.id,
            generation: state.attempt.generation, reason: 'input', referenceId: request.referenceId,
            policyVersion: owner.policyVersion, grantsCurrent: true, budgetAvailable: true,
            conditionSatisfied: true, runtimeQuiescent: true,
          }, { sourceEvent: sourceEventSchema.parse({
            id: `inbox-${eventKey}`, ownerId: owner.ownerId, profileId: owner.profileId, sourceInstanceId: LOCAL_SOURCE,
            externalEventId: eventKey, externalRevision: '1', occurredAt: at, receivedAt: at, threadId: conversation.sessionIds[0],
            actor: { kind: 'person', externalActorId: owner.ownerId, deviceId: owner.deviceId },
            body: { kind: 'inbox-answer', cursor: request.cursor, referenceId: request.referenceId, text: request.text },
            provenance: { description: 'Owner answer to a native inbox wait' },
          }) }))
        }
      }
    } catch (error) {
      if (error instanceof StorageError) return failure(error.code)
      throw error
    }
  }

  return Object.freeze({ handle })
}
