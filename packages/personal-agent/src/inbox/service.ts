import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { projectApproval, type MobileApprovals } from '../api/approvals.js'
import type { MobileDeviceLedger } from '../api/devices.js'
import { knowledgeRequestSchemas, type LocalKnowledge } from '../connectors/local-knowledge.js'
import { connectorRequestSchemas, type ReadConnector } from '../connectors/registry.js'
import { proactiveRequests, type ProactiveService } from '../runtime/proactive.js'
import { githubDraftRequests, type GitHubDraftService } from '../connectors/github-draft.js'
import { DRAFT_ACTION, DRAFT_EXECUTOR } from '../connectors/github-draft-model.js'
import { contextEvidencePointerSchema } from '../context/checkpoint.js'
import type { LocalContext } from '../context/local-context.js'
import { memoryRequestSchemas, type LocalMemory } from '../context/memory.js'
import { createSkillCandidates } from '../context/skill-candidates.js'
import { skillRequestSchemas } from '../context/skill-contract.js'
import { localInboxSource } from '../context/source-authority.js'
import { contextRecallRequestSchema, contextSearchRequestSchema } from '../context/recall.js'
import {
  artifactIdSchema,
  attemptIdSchema,
  commandIdSchema,
  computeWaitPrefix,
  desktopApplication,
  desktopApplicationSchema,
  desktopWaitPrefix,
  conversationIdSchema,
  conversationSchema,
  deviceIdSchema,
  indefiniteWait,
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
  waitAllowsWake,
  workerCursorSchema,
  type SessionId,
  type Project,
  type ProjectId,
  type TaskId,
  type UtcInstant,
} from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import { comparePlanPriority, projectPlanDraftSchema, taskPrerequisitesSchema, type ProjectPlanInput } from '../domain/projects.js'
import type { IdentityBoundary, OwnerIdentity } from '../policy/identity.js'
import type { DesktopControl, DesktopGrant } from '../runtime/desktop-control.js'
import type { ExecutorResult, WorkerExecutor } from '../runtime/executor.js'
import { workerInputSchema } from '../runtime/reports.js'
import type { ResidentOperations } from '../runtime/resident-operations.js'
import type { EventRouter } from '../runtime/router.js'
import { StorageError } from '../storage/schema.js'
import type { WorkRef, WorkStore } from '../storage/store.js'
import type { InboxResponse, InboxReviewProject, InboxSession, InboxTask, InboxUsage } from './protocol.js'
import { routineRequestSchemas, type RoutineInbox } from './routines.js'

const LOCAL_SOURCE = sourceInstanceIdSchema.parse(localInboxSource)
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
  z.strictObject({ type: z.literal('mobile_devices') }),
  z.strictObject({ type: z.literal('mobile_pair'), label: nonEmptyTextSchema.max(80) }),
  z.strictObject({ type: z.literal('mobile_revoke'), deviceId: deviceIdSchema }),
  z.strictObject({ type: z.literal('mobile_review'), requestId: requestIdSchema, expectedVersion: versionSchema,
    digest: sha256DigestSchema, deviceId: deviceIdSchema.nullable() }),
  z.strictObject({ type: z.literal('create_project'), commandId: command, title: nonEmptyTextSchema.max(256), purpose: nonEmptyTextSchema.max(4_096) }),
  z.strictObject({
    type: z.literal('create_task'), commandId: command, projectId: projectIdSchema,
    sessionId: sessionIdSchema, outcome: nonEmptyTextSchema.max(4_096),
  }),
  z.strictObject({ type: z.literal('start'), ...control, cursor: workerCursorSchema }),
  z.strictObject({ type: z.literal('desktop_start'), ...control, cursor: workerCursorSchema, application: desktopApplicationSchema }),
  z.strictObject({ type: z.literal('desktop_takeover'), taskId: taskIdSchema, leaseId: z.uuid() }),
  z.strictObject({ type: z.literal('desktop_release'), taskId: taskIdSchema, leaseId: z.uuid() }),
  z.strictObject({ type: z.literal('save_plan'), commandId: command, projectId: projectIdSchema.optional(),
    expectedRevision: versionSchema.optional(), draft: projectPlanDraftSchema, rationale: nonEmptyTextSchema.max(4096) }),
  z.strictObject({ type: z.literal('project_plan'), projectId: projectIdSchema }),
  z.strictObject({ type: z.literal('project_review') }),
  z.strictObject({ type: z.literal('set_prerequisites'), ...control, prerequisiteIds: taskPrerequisitesSchema }),
  z.strictObject({ type: z.literal('accept_plan_step'), taskId: taskIdSchema, cursor: workerCursorSchema, index: z.int().min(0).max(7) }),
  z.strictObject({ type: z.enum(['pause', 'resume', 'cancel']), ...control, commandId: command }),
  z.strictObject({ type: z.literal('redirect'), ...control, ...workerInputSchema.shape }),
  z.strictObject({ type: z.literal('answer'), ...control, ...answerFields }),
  z.strictObject({ type: z.literal('accept_result'), ...control }),
  z.strictObject({
    type: z.literal('approval'), requestId: requestIdSchema, expectedVersion: versionSchema,
    digest: sha256DigestSchema, decision: z.enum(['approve', 'deny']),
  }),
  z.strictObject({ type: z.literal('artifact'), taskId: taskIdSchema, artifactId: artifactIdSchema }),
  z.strictObject({ type: z.literal('context_recall'), taskId: taskIdSchema, ...contextRecallRequestSchema.shape }),
  z.strictObject({ type: z.literal('context_search'), taskId: taskIdSchema, ...contextSearchRequestSchema.shape }),
  z.strictObject({ type: z.literal('context_checkpoint'), taskId: taskIdSchema }),
  z.strictObject({ type: z.literal('context_exclude'), ...control, ref: contextEvidencePointerSchema,
    reason: z.enum(['forgotten', 'superseded']) }),
  z.strictObject({ type: z.literal('set_subscription'), subscription: z.unknown() }),
  z.strictObject({ type: z.literal('set_attention_policy'), expectedVersion: versionSchema, policy: z.unknown() }),
  ...memoryRequestSchemas,
  ...skillRequestSchemas,
  ...knowledgeRequestSchemas,
  ...connectorRequestSchemas,
  ...proactiveRequests,
  ...githubDraftRequests,
  ...routineRequestSchemas,
  z.strictObject({ type: z.enum(['resident_status', 'resident_backup']) }),
  z.strictObject({ type: z.literal('resident_audit'), afterSequence: versionSchema.optional() }),
])

const nativeSessionSchema = z.strictObject({ id: sessionIdSchema, label: nonEmptyTextSchema.max(1_024) })

export interface InboxServiceOptions {
  readonly store: WorkStore
  readonly executor?: WorkerExecutor
  readonly desktop?: DesktopControl
  readonly identity: IdentityBoundary
  readonly resolveSession: (sessionId: SessionId) => boolean | Promise<boolean>
  readonly listSessions?: () => readonly InboxSession[] | Promise<readonly InboxSession[]>
  readonly worker?: { readonly presetId: string; readonly cwd: string; readonly dataScope: readonly string[] }
  readonly actionGate?: ReturnType<WorkStore['createActionGate']>
  readonly router?: EventRouter
  readonly inspectUsage?: (owner: OwnerIdentity) => {
    readonly usage: InboxUsage
    readonly progress: readonly { taskId: string; attemptId: string; generation: number; summary: string; at: string }[]
  }
  readonly configureAttention?: (owner: OwnerIdentity, policy: unknown, expectedVersion: number) =>
    { ok: true; policy: { version: number } } | { ok: false; code: string }
  readonly invalidateResources?: (ref: WorkRef) => void
  readonly routines?: RoutineInbox
  readonly resident?: ResidentOperations
  readonly mobile?: { readonly devices: MobileDeviceLedger; readonly approvals: MobileApprovals; readonly origin: string; readonly available: () => boolean }
  readonly context?: LocalContext
  readonly memory?: LocalMemory
  readonly knowledge?: LocalKnowledge
  readonly proactive?: ProactiveService
  readonly githubRead?: { readonly connector: ReadConnector; readonly scope: Pick<OwnerIdentity, 'ownerId' | 'profileId'>;
    readonly projectId?: ProjectId }
  readonly githubDraft?: { readonly projectId: ProjectId; readonly service: GitHubDraftService }
  readonly now?: () => UtcInstant
}

type CreateTask = Extract<z.infer<typeof requestSchema>, { type: 'create_task' }>
type AcceptStep = Extract<z.infer<typeof requestSchema>, { type: 'accept_plan_step' }>

function stableId(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function refFor(owner: OwnerIdentity, taskId: TaskId): WorkRef {
  return { ownerId: owner.ownerId, profileId: owner.profileId, taskId }
}

function failure(code: string): InboxResponse {
  return { ok: false, code }
}

function planDraft(project: Project): ProjectPlanInput {
  return { title: project.title, purpose: project.purpose, successCriteria: project.successCriteria,
    milestones: project.milestones, reviewCadence: project.reviewCadence, priority: project.priority ?? 'normal' }
}

function updated(result: ExecutorResult): InboxResponse {
  return result.ok ? { ok: true, kind: 'updated', taskId: result.state.task.id } : failure(result.code)
}

function nativeReleased(state: WorkState): boolean {
  return state.attempt.startedAt === undefined || state.attempt.worker?.releasedAt !== undefined || isDraftWork(state)
}

function isDraftWork(state: WorkState): boolean {
  return state.attempt.executor === DRAFT_EXECUTOR && state.attempt.worker === undefined
    && state.attempt.scope?.capabilities.length === 1 && state.attempt.scope.capabilities[0] === DRAFT_ACTION
}

function computeWait(state: WorkState) {
  const { task } = state
  return (task.status === 'waiting_resource' || task.status === 'paused')
    && task.wait?.reason === 'resource' && task.wait.referenceId.startsWith(computeWaitPrefix)
    ? task.wait : undefined
}

function desktopStartable(state: WorkState, at: UtcInstant): boolean {
  const { task, attempt } = state
  if (!nativeReleased(state)) return false
  if (!desktopApplication(attempt.scope)) return task.status === 'queued' && attempt.startedAt === undefined
  if (task.status === 'queued') return true
  const eligibleWait = task.wait?.referenceId.startsWith(desktopWaitPrefix) || computeWait(state)
  return (task.status === 'paused' && !task.wait
    || ((task.status === 'waiting_environment' || task.status === 'waiting_resource' || task.status === 'paused') && Boolean(eligibleWait)))
    && waitAllowsWake(task.wait, at)
}

function terminal(state: WorkState): boolean {
  return state.task.status === 'completed' || state.task.status === 'cancelled' || state.task.status === 'failed'
}

/** Owner-scoped adapter for the native inbox and deterministic foreground controls. */
export function createInboxService(options: InboxServiceOptions) {
  const { store, executor, identity, actionGate } = options
  const skills = createSkillCandidates({ store, identity, now: options.now })
  const worker = options.worker && { ...options.worker, dataScope: [...options.worker.dataScope] }
  const now = options.now ?? (() => utcInstantSchema.parse(new Date().toISOString()))

  function ownerCanAccept(ref: WorkRef, state: WorkState, owner: OwnerIdentity): boolean {
    const draft = options.githubDraft?.projectId === state.task.projectId && isDraftWork(state)
    const localScope = (state.attempt.scope?.capabilities.length ?? 0) === 0
      || desktopApplication(state.attempt.scope) !== undefined
    return state.task.status === 'verifying' && (draft || state.attempt.worker?.releasedAt !== undefined)
      && state.attempt.mandate.policyVersion === owner.policyVersion && state.attempt.artifactIds.length > 0
      && (draft || (!state.task.acceptance.requiresReceipt && localScope))
      && !store.hasUnsettledEffects(ref, state.attempt.id)
  }

  function projectTask(owner: OwnerIdentity, state: WorkState, progress?: InboxTask['progress']): InboxTask {
    const { task } = state
    const application = desktopApplication(state.attempt.scope)
    const wait = computeWait(state)
    const ref = refFor(owner, task.id)
    const conversation = task.conversationId === undefined ? undefined : store.getConversation(owner, task.conversationId)
    const verification = task.status === 'completed' ? store.getVerification(ref, task.version) : undefined
    const prerequisites = store.getTaskPrerequisites(ref)
    const proposal = store.getWorkerPlan(ref)
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
      ...(task.wait === undefined ? {} : { wait: { reason: task.wait.reason, referenceId: task.wait.referenceId,
        prompt: task.wait.resumeCondition, ...(task.wait.notBefore === undefined || task.wait.notBefore === indefiniteWait
          ? {} : { notBefore: task.wait.notBefore }) } }),
      artifacts,
      ...(application ? { desktopApplication: application } : {}),
      ...(options.desktop && desktopStartable(state, now()) ? { canStartDesktop: true } : {}),
      canAccept: artifacts.length === candidates.length && ownerCanAccept(ref, state, owner),
      ...(wait ? { canResumeCompute: nativeReleased(state) && wait.notBefore !== indefiniteWait } : {}),
      deliveries: store.listInboxDeliveries(ref).map(delivery => ({ id: delivery.id, status: delivery.status })),
      ...(progress === undefined ? {} : { progress }),
      ...(verification === undefined ? {} : { verifiedAt: verification.verifiedAt }),
      ...(prerequisites.length ? { prerequisites } : {}),
      ...(proposal && (!options.context || options.context.historyUsable(ref, state)) ? { proposal } : {}),
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
    const approvals = actionGate?.pending(ownerToken, work.map(({ task }) => task.id)).map(projectApproval) ?? []
    const mobileReviewers = options.mobile?.available() ? options.mobile.devices.list()
      .filter(device => device.state === 'active').map(({ deviceId, label }) => ({ deviceId, label })) : undefined
    const recoveryMode = store.recoveryMode()
    const usage = options.inspectUsage?.(owner)
    const schedules = options.routines?.snapshot(owner)
    const progress = new Map(usage?.progress.map(item => [item.taskId, item]))
    return { ok: true, kind: 'snapshot', snapshot: {
      workerConfigured: executor !== undefined && worker !== undefined,
      ...(options.mobile ? { mobileConfigured: true } : {}),
      ...(mobileReviewers ? { mobileReviewers } : {}),
      ...(options.desktop ? { desktopTargets: options.desktop.targets, desktopActivities: options.desktop.activity(owner) } : {}),
      ...(options.memory ? { memoryConfigured: true } : {}),
      ...(options.knowledge ? { knowledgeConfigured: true } : {}),
      ...(options.githubRead ? { githubRead: { projectId: options.githubRead.projectId } } : {}),
      ...(options.proactive ? { proactiveConfigured: true, proactiveNotices: options.proactive.notices() } : {}),
      ...(options.githubDraft ? { githubDraft: { projectId: options.githubDraft.projectId } } : {}),
      ...(recoveryMode === 'normal' ? {} : { recoveryMode }),
      sessions,
      projects: store.listInboxProjects(owner).map(({ id, title, purpose, kind }) => ({ id, title, purpose, kind })),
      tasks: work.map(state => {
        const latest = progress.get(state.task.id)
        return projectTask(owner, state, latest?.attemptId === state.attempt.id && latest.generation === state.task.generation
          ? { summary: latest.summary, at: latest.at } : undefined)
      }),
      approvals,
      ...(usage === undefined ? {} : { usage: usage.usage }),
      ...(schedules === undefined ? {} : { schedules }),
    } }
  }

  async function createTask(ownerToken: unknown, request: CreateTask, step?: AcceptStep): Promise<InboxResponse> {
    if (!await options.resolveSession(request.sessionId)) return failure('not_found')
    const owner = identity.resolveOwner(ownerToken)
    if (!owner) return failure('permission_denied')
    if (!store.getProject(owner, request.projectId)) return failure('not_found')
    if (step) {
      const ref = refFor(owner, step.taskId)
      const parent = store.getWork(ref)
      const draft = store.getWorkerPlan(ref)
      if (parent?.task.projectId !== request.projectId || parent.attempt.mandate.policyVersion !== owner.policyVersion
        || draft?.cursor !== step.cursor || draft.steps[step.index] !== request.outcome) return failure('version_conflict')
      if (options.context && !options.context.historyUsable(ref, parent)) return failure('source_unavailable')
    }
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
      body: { kind: 'inbox-task', outcome: request.outcome,
        ...(step ? { parentTaskId: step.taskId, proposalCursor: step.cursor, proposalIndex: step.index } : {}) },
      provenance: { description: step ? 'Owner approved a Worker task draft' : 'Native inbox task request' },
    }) }))
  }

  function review(owner: OwnerIdentity): InboxResponse {
    const at = now()
    const start = new Date(Date.parse(at) - 7 * 86_400_000).toISOString()
    const end = new Date(Date.parse(at) + 7 * 86_400_000).toISOString()
    const projects: InboxReviewProject[] = store.listInboxProjects(owner).filter(project => project.status === 'active').map(project => {
      const tasks = store.listProjectTasks(owner, project.id)
      const milestones = project.milestones.filter(item => !item.deadline || item.deadline.at <= end)
      const ready = tasks.filter(({ task, prerequisites }) => task.status === 'queued' && prerequisites.every(row => row.completed))
      const due = [...milestones.flatMap(item => item.deadline ? [item.deadline.at] : []),
        ...ready.flatMap(({ task }) => task.deadline ? [task.deadline.at] : [])].sort()[0]
      return { projectId: project.id, title: project.title, priority: project.priority ?? 'normal', due,
        milestones: milestones.map(item => item.title), ready: ready.map(({ task }) => task.id),
        waiting: tasks.filter(({ task, prerequisites }) => !['completed', 'failed', 'cancelled'].includes(task.status)
          && (task.wait || prerequisites.some(row => !row.completed))).map(({ task }) => task.id),
        accepted: tasks.filter(({ task }) => task.status === 'completed' && task.updatedAt >= start
          && store.getVerification({ ...owner, taskId: task.id }, task.version)).map(({ task }) => task.id) }
    }).sort((a, b) => comparePlanPriority(a, b) || a.projectId.localeCompare(b.projectId))
    const capacity = executor?.snapshot()
    const slots = capacity ? Math.max(0, capacity.limit - capacity.active) : 0
    const eligible = projects.filter(project => project.ready.length > 0)
    const first = eligible[slots - 1]
    const next = eligible[slots]
    return { ok: true, kind: 'project_review', projects, at, needsPriority: Boolean(first && next && comparePlanPriority(first, next) === 0) }
  }

  async function handle(ownerToken: unknown, input: unknown, signal?: AbortSignal): Promise<InboxResponse> {
    const owner = identity.resolveOwner(ownerToken)
    if (!owner) return failure('permission_denied')
    const decoded = requestSchema.safeParse(input)
    if (!decoded.success) return failure('invalid_input')
    const request = decoded.data
    if (store.recoveryMode() === 'restore' && request.type !== 'snapshot' && request.type !== 'artifact'
      && request.type !== 'context_recall' && request.type !== 'context_search' && request.type !== 'context_checkpoint'
      && request.type !== 'project_plan' && request.type !== 'project_review'
      && request.type !== 'github_draft_inspect' && request.type !== 'github_draft_reconcile'
      && request.type !== 'cancel' && request.type !== 'resident_status' && request.type !== 'resident_audit') return failure('recovery_required')

    try {
      switch (request.type) {
        case 'snapshot': return await snapshot(ownerToken)
        case 'mobile_devices':
          return options.mobile ? {
            ok: true, kind: 'mobile_devices', devices: options.mobile.devices.list(), available: options.mobile.available(),
          } : failure('resource_unavailable')
        case 'mobile_pair': {
          const mobile = options.mobile
          if (!mobile?.available()) return failure('resource_unavailable')
          const result = mobile.devices.begin(request.label)
          return result.ok ? { ok: true, kind: 'mobile_pair', pairingCode: result.pairingCode,
            expiresAt: result.expiresAt, origin: mobile.origin } : failure(result.code)
        }
        case 'mobile_review': {
          const mobile = options.mobile
          const { type: _type, deviceId, ...fence } = request
          if (deviceId !== null && !mobile?.available()) return failure('resource_unavailable')
          const result = deviceId === null
            ? actionGate?.assignMobileReview(fence, ownerToken, null)
            : mobile?.approvals.assign(fence, ownerToken, deviceId)
          return result?.ok ? { ok: true, kind: 'updated' } : failure(result?.code ?? 'resource_unavailable')
        }
        case 'mobile_revoke':
          return options.mobile?.devices.revoke(request.deviceId) ? { ok: true, kind: 'updated' } : failure('not_found')
        case 'skill_list':
        case 'skill_inspect':
        case 'skill_propose':
        case 'skill_evaluate':
        case 'skill_activate':
        case 'skill_rollback':
        case 'skill_run':
        case 'skill_feedback': return skills.handle(owner, request)
        case 'create_task': return await createTask(ownerToken, request)
        case 'proactive_state':
        case 'proactive_save_rule':
        case 'proactive_replay':
        case 'proactive_mode':
        case 'proactive_feedback':
        case 'proactive_artifact': return options.proactive?.handle(request) ?? failure('resource_unavailable')
        case 'knowledge_status':
        case 'knowledge_search':
        case 'knowledge_read': {
          if (!options.knowledge) return failure('resource_unavailable')
          if (!store.canDispatch()) return failure('recovery_required')
          return await options.knowledge.handle(request, () => identity.resolveOwner(ownerToken) === owner && store.canDispatch(), signal)
        }
        case 'connector_status':
        case 'connector_read': {
          const connector = options.githubRead
          if (!connector) return failure('resource_unavailable')
          if (!store.canDispatch()) return failure('recovery_required')
          const permitted = () => identity.resolveOwner(ownerToken) === owner && store.canDispatch()
            && owner.ownerId === connector.scope.ownerId && owner.profileId === connector.scope.profileId
            && (connector.projectId === undefined || store.getProject(owner, connector.projectId)?.status === 'active')
          return await connector.connector.handle(request, permitted, signal)
        }
        case 'github_draft_prepare':
        case 'github_draft_inspect':
        case 'github_draft_dispatch':
        case 'github_draft_reconcile':
        case 'github_draft_revoke': return await options.githubDraft?.service.handle(ownerToken, request, signal)
          ?? failure('resource_unavailable')
        case 'save_plan': {
          if ((request.projectId === undefined) !== (request.expectedRevision === undefined)) return failure('invalid_input')
          const { type: _type, ...change } = request
          const id = request.projectId ?? projectIdSchema.parse(
            `inbox-${stableId('goal', owner.ownerId, owner.profileId, owner.clientId, request.commandId)}`)
          const result = store.saveProjectPlan(owner, { ...change, projectId: id, at: now() })
          return result.ok ? { ok: true, kind: 'updated', projectId: result.project.id } : failure(result.code)
        }
        case 'project_plan': {
          const data = store.getProjectPlan(owner, request.projectId)
          if (!data) return failure('not_found')
          const { project, revisions } = data
          return { ok: true, kind: 'project_plan', plan: {
            projectId: project.id, revision: project.planRevision, kind: project.kind,
            draft: planDraft(project),
            history: revisions.map(entry => ({ revision: entry.project.planRevision, draft: planDraft(entry.project),
              ...('rationale' in entry ? { rationale: entry.rationale, recordedAt: entry.recordedAt } : {}) })),
          } }
        }
        case 'project_review': return review(owner)
        case 'set_prerequisites': return updated(store.setTaskPrerequisites(
          refFor(owner, request.taskId), request.expectedVersion, now(), request.prerequisiteIds))
        case 'accept_plan_step': {
          const ref = refFor(owner, request.taskId)
          const parent = store.getWork(ref)
          const draft = store.getWorkerPlan(ref)
          const outcome = draft?.cursor === request.cursor ? draft.steps[request.index] : undefined
          const session = parent?.task.conversationId && store.getConversation(owner, parent.task.conversationId)?.sessionIds[0]
          if (!parent || !outcome || !session) return failure('not_found')
          return await createTask(ownerToken, {
            type: 'create_task', projectId: parent.task.projectId, sessionId: session, outcome,
            commandId: command.parse(`step-${stableId(request.taskId, request.cursor, String(request.index))}`),
          }, request)
        }
        case 'memory_search':
        case 'memory_inspect':
        case 'memory_remember':
        case 'memory_correct':
        case 'memory_forget': return await options.memory?.handle(ownerToken, request, signal) ?? failure('resource_unavailable')
        case 'context_recall':
        case 'context_search':
        case 'context_checkpoint':
        case 'context_exclude': {
          const context = options.context
          if (!context) return failure('resource_unavailable')
          const ref = refFor(owner, request.taskId)
          if (request.type === 'context_checkpoint') {
            const result = context.inspect(ref, ownerToken)
            return result.ok ? { ok: true, kind: 'context', value: result.value } : failure(result.code)
          }
          if (request.type === 'context_exclude') {
            if (!store.canDispatch()) return failure('recovery_required')
            const state = store.getWork(ref)
            if (!state) return failure('not_found')
            if (state.task.version !== request.expectedVersion) return failure('version_conflict')
            if (state.attempt.mandate.policyVersion !== owner.policyVersion) return failure('policy_changed')
            const result = store.excludeContextPointer(ref, request.ref, { kind: request.reason, at: now() })
            return result.ok ? { ok: true, kind: 'updated', taskId: ref.taskId } : failure(result.code)
          }
          if (request.type === 'context_recall') {
            const result = context.recall.lookup(ref, ownerToken, { ref: request.ref, cursor: request.cursor, maxBytes: request.maxBytes })
            return result.ok ? { ok: true, kind: 'context', value: result.page } : failure(result.code)
          }
          const result = context.recall.search(ref, ownerToken, { query: request.query, limit: request.limit })
          return result.ok ? { ok: true, kind: 'context', value: result.hits } : failure(result.code)
        }
        case 'resident_status':
        case 'resident_backup':
        case 'resident_audit': {
          const resident = options.resident
          if (!resident) return failure('resource_unavailable')
          const scope = { ownerId: owner.ownerId, profileId: owner.profileId }
          const value = request.type === 'resident_status' ? resident.status(scope)
            : request.type === 'resident_audit' ? resident.audit(scope, request.afterSequence)
              : await resident.backup()
          return { ok: true, kind: 'resident', value }
        }
        case 'save_routine':
        case 'arm_routine':
        case 'pause_routine':
        case 'run_routine_now': return options.routines?.handle(owner, request) ?? failure('resource_unavailable')
        case 'set_subscription': {
          const result = options.router?.setSubscription(ownerToken, request.subscription)
          if (!result) return failure('resource_unavailable')
          return result.ok ? { ok: true, kind: 'subscription', version: result.subscription.version } : failure(result.code)
        }
        case 'set_attention_policy': {
          const result = options.configureAttention?.(owner, request.policy, request.expectedVersion)
          if (!result) return failure('resource_unavailable')
          return result.ok ? { ok: true, kind: 'attention_policy', version: result.policy.version } : failure(result.code)
        }
        case 'create_project': {
          const projectId = projectIdSchema.parse(`inbox-${stableId('project', owner.ownerId, owner.profileId, owner.clientId, request.commandId)}`)
          const existing = store.getInitialProject(owner, projectId)
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

      if (request.type === 'desktop_takeover' || request.type === 'desktop_release') {
        if (!options.desktop) return failure('resource_unavailable')
        return options.desktop.control(owner, ref, request.leaseId, request.type === 'desktop_takeover' ? 'takeover' : 'release')
          ? { ok: true, kind: 'updated', taskId: ref.taskId } : failure('stale_lease')
      }

      const at = now()
      const context = { actor: owner, at, projectId: state.task.projectId, conversationId: conversation.id }
      if (request.type === 'pause' || request.type === 'cancel') {
        const command = { type: `work.${request.type}`, taskId: ref.taskId, commandId: request.commandId,
          expectedVersion: request.expectedVersion, conversationId: conversation.id, payload: {} }
        const result = request.type === 'cancel' ? executor?.cancel(command, context) ?? store.applyCommand(command, context)
          : executor ? executor.pause(command, context)
            : state.task.status === 'queued' ? store.applyCommand(command, context) : undefined
        if (result?.ok) options.invalidateResources?.(ref)
        if (result?.ok && request.type === 'cancel' && isDraftWork(result.state)) options.githubDraft?.service.cancel(ownerToken, ref)
        return result ? updated(result) : failure('runtime_not_quiescent')
      }

      if (request.expectedVersion !== state.task.version) return failure('version_conflict')
      if (request.type === 'accept_result') {
        if (!ownerCanAccept(ref, state, owner)) return failure('invalid_transition')
        const effectOperationId = isDraftWork(state) ? actionGate?.inspect(ownerToken, ref.taskId, DRAFT_ACTION)?.action.operationId : undefined
        if (isDraftWork(state) && !effectOperationId) return failure('acceptance_unsatisfied')
        const verifier = store.createVerifier({
          now,
          authorizeCommit: () => identity.resolveOwner(ownerToken) !== undefined,
          check: ({ state, artifacts }) => artifacts.length === 0 ? [] : state.task.acceptance.criteria.map(criterion => ({
            criterion, satisfied: true, evidence: 'The authenticated owner accepted the sealed result through the native inbox.',
          })),
        })
        return updated(await verifier.verify(ref, { expectedVersion: request.expectedVersion, effectOperationId }))
      }
      if (!executor || !worker) return failure('resource_unavailable')
      if (state.attempt.mandate.policyVersion !== owner.policyVersion) return failure('policy_changed')
      const application = desktopApplication(state.attempt.scope)
      if ((state.attempt.scope?.capabilities.length ?? 0) > 0 && !application) return failure('permission_denied')

      if (request.type === 'redirect') return updated(executor.redirect(ref, request.expectedVersion, { cursor: request.cursor, text: request.text }))
      if (!nativeReleased(state)) return failure('runtime_not_quiescent')

      switch (request.type) {
        case 'start':
        case 'desktop_start': {
          const desktop = request.type === 'desktop_start' ? options.desktop : undefined
          if (request.type === 'desktop_start') {
            if (!desktop) return failure('resource_unavailable')
            const target = desktop.targets.find(row => row.application === request.application)
            if (!target) return failure('permission_denied')
            if (target.unavailableReason) return failure(target.unavailableReason)
            if (!desktopStartable(state, at) || (application && application !== request.application)) return failure('invalid_transition')
          } else if (application || state.task.status !== 'queued') return failure('invalid_transition')
          if (!executor.canStart(ref, worker.presetId)) return failure('budget_exceeded')
          const assembly = options.context
          const currentInput = () => {
            const readAt = now()
            if (assembly && !assembly.taskTextUsable(ref, state, readAt)) return undefined
            const source = store.getWakeSource(ref, state.task.version)
            const outcome = state.task.requestedOutcome
            if (source?.sourceInstanceId === LOCAL_SOURCE && (!assembly || assembly.sourceUsable(ref, source.id, readAt))) {
              const answer = answerBodySchema.safeParse(source.body)
              if (answer.success) return { text: `${outcome}\n\nOwner answer:\n${answer.data.text}`, sources: [source.id] }
            }
            return { text: outcome }
          }
          const prepared = assembly ? await assembly.prepare(ref, ownerToken, state, request.cursor, currentInput)
            : { ok: true as const, text: currentInput()?.text ?? state.task.requestedOutcome, sources: undefined }
          if (!prepared.ok) return failure(prepared.code)
          if (signal?.aborted || identity.resolveOwner(ownerToken) !== owner) return failure('permission_denied')
          const cwd = state.attempt.worker?.cwd ?? join(worker.cwd, stableId('workspace', owner.ownerId, owner.profileId, ref.taskId))
          if (state.attempt.worker === undefined) mkdirSync(cwd, { recursive: true, mode: 0o700 })
          let grant: DesktopGrant | undefined
          let expectedVersion = request.expectedVersion
          if (desktop && request.type === 'desktop_start') {
            if (!store.canDispatch()) return failure('recovery_required')
            if (executor.query(ref).active) return failure('runtime_not_quiescent')
            const exact = store.getWork(ref)
            if (exact?.task.version !== expectedVersion || exact.attempt.id !== state.attempt.id) return failure('version_conflict')
            const admitted = desktop.acquire(owner, ownerToken, ref, exact, request.application)
            if (!admitted.ok) return failure(admitted.code)
            grant = admitted.grant
          }
          try {
            if (grant && state.task.status !== 'queued') {
              const admit = { policyVersion: owner.policyVersion, grantsCurrent: true, budgetAvailable: true,
                conditionSatisfied: true, runtimeQuiescent: true }
              const wait = state.task.wait
              const resumed = state.task.status === 'paused' ? store.applyEvent(ref, {
                type: 'resume', at: now(), expectedVersion, ...admit,
              }) : wait && store.applyEvent(ref, {
                type: 'wake', at: now(), expectedVersion, attemptId: state.attempt.id, generation: state.attempt.generation,
                reason: wait.reason, referenceId: wait.referenceId, ...admit,
              })
              if (!resumed?.ok) return failure(resumed?.code ?? 'invalid_transition')
              expectedVersion = resumed.state.task.version
            }
            return updated(await executor.launch(ref, {
              expectedVersion, ...worker, cwd, input: { cursor: request.cursor, text: prepared.text },
            }, prepared.sources, grant))
          } finally {
            if (grant && !executor.query(ref).active) grant.finish()
          }
        }
        case 'resume': {
          if (application) return failure('permission_denied')
          const wait = computeWait(state)
          if (wait && !waitAllowsWake(wait, at)) return failure('condition_unmet')
          if (wait && state.task.status === 'waiting_resource') return updated(store.applyEvent(ref, {
            type: 'wake', at, expectedVersion: request.expectedVersion, attemptId: state.attempt.id,
            generation: state.attempt.generation, reason: 'resource', referenceId: wait.referenceId,
            policyVersion: owner.policyVersion, grantsCurrent: true, budgetAvailable: executor.canStart(ref, worker.presetId),
            conditionSatisfied: true, runtimeQuiescent: true,
          }))
          if (state.task.status !== 'paused' || (state.task.wait && !wait)) return failure('invalid_transition')
          return updated(store.applyCommand({
            type: 'work.resume', taskId: ref.taskId, commandId: request.commandId, expectedVersion: request.expectedVersion,
            conversationId: conversation.id, payload: {},
          }, { ...context, resume: {
            taskId: ref.taskId, attemptId: state.attempt.id, generation: state.attempt.generation,
            expectedVersion: request.expectedVersion, policyVersion: owner.policyVersion,
            grantsCurrent: true, budgetAvailable: executor.canStart(ref, worker.presetId),
            conditionSatisfied: true, runtimeQuiescent: true,
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
            policyVersion: owner.policyVersion, grantsCurrent: true, budgetAvailable: executor.canStart(ref, worker.presetId),
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
