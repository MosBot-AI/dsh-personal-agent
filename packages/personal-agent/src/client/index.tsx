import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { INBOX_RPC_ENDPOINT, type InboxPort, type InboxResponse } from '../inbox/protocol.js'
import { dictionaries, namespace, type Translate } from './copy.js'
import { createInboxMemory, Inbox, type InboxConnection } from './inbox.js'
import { inboxStyles } from './styles.js'

type ClientContext = Context & {
  connection: ConnectionHandle
  sessions: ISessions
  uiWorkspace: UiWorkspace
}

const panelId = 'dshpa-today' as MainPanelId
export const inject = ['slots', 'locale', 'connection', 'sessions', 'uiWorkspace']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isUsage(value: unknown): boolean {
  if (!isRecord(value) || typeof value.day !== 'string' || !Array.isArray(value.currencies)
    || !isRecord(value.workerSlots) || !isRecord(value.gpu) || !isRecord(value.tokens)) return false
  const { workerSlots, gpu, attention, tokens } = value
  return [value.calls, value.unknownCalls, value.uncertainCalls, workerSlots.active, workerSlots.limit, gpu.active, gpu.limit, gpu.queued,
    tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite].every(isCount)
    && typeof value.routing === 'string' && ['off', 'configured', 'pricing_unavailable', 'provider_unavailable'].includes(value.routing)
    && value.currencies.every(row => isRecord(row) && typeof row.currency === 'string' && /^[A-Z]{3}$/u.test(row.currency)
      && [row.spentMicros, row.reservedMicros, row.uncertainMicros, row.olderHeldMicros].every(isCount)
      && (row.dailyLimitMicros === undefined || isCount(row.dailyLimitMicros)) && typeof row.overflow === 'boolean')
    && (attention === undefined || (isRecord(attention) && ['off', 'observe', 'prepare', 'act'].includes(String(attention.mode))
      && typeof attention.day === 'string' && typeof attention.timeZone === 'string'
      && [attention.version, attention.unsolicited, attention.limit, attention.suppressed].every(isCount)
      && Array.isArray(attention.recent) && attention.recent.every(row => isRecord(row)
        && typeof row.id === 'string' && typeof row.reason === 'string' && typeof row.at === 'string')))
}

function isSchedules(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.routines) || !Array.isArray(value.reminders)) return false
  const hasText = (...fields: unknown[]) => fields.every(field => typeof field === 'string')
  return value.routines.every(row => {
    if (!isRecord(row) || !isRecord(row.timing) || !isRecord(row.target) || !hasText(row.id, row.title)
      || !isCount(row.revision) || !['draft', 'armed', 'paused', 'ended'].some(state => state === row.state)
      || (row.nextAt !== undefined && typeof row.nextAt !== 'string') || (row.issue !== undefined && typeof row.issue !== 'boolean')
      || (row.misfire !== 'skip' && row.misfire !== 'latest')) return false
    const last = row.last
    if (last !== undefined && (!isRecord(last) || !['reminded', 'queued', 'skipped'].some(status => status === last.status)
      || !hasText(last.at) || (last.reason !== undefined && !hasText(last.reason)))) return false
    return (row.timing.kind === 'at' ? hasText(row.timing.at)
      : row.timing.kind === 'cron' && hasText(row.timing.expression, row.timing.timeZone))
      && (row.target.kind === 'reminder' ? hasText(row.target.text) : row.target.kind === 'goal' && hasText(row.target.taskId))
  }) && value.reminders.every(row => isRecord(row) && hasText(row.id, row.title, row.text, row.intendedAt, row.deliveredAt))
}

function isMemoryId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^[^\x00-\x1f\x7f]+$/u.test(value)
}

function isMemoryInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value))
}

function isMemoryRecord(value: unknown, origin: 'explicit' | 'inferred'): boolean {
  if (!isRecord(value) || value.state !== 'active' || value.origin !== origin || !isMemoryId(value.id)
    || !isMemoryId(value.ownerId) || !isMemoryId(value.profileId) || !isRecord(value.scope) || !isRecord(value.value)
    || typeof value.revision !== 'number' || !isCount(value.revision) || value.revision === 0
    || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
    || !isMemoryInstant(value.validFrom) || (value.validUntil !== undefined
      && (!isMemoryInstant(value.validUntil) || value.validUntil < value.validFrom))
    || !Array.isArray(value.sourceEventIds) || value.sourceEventIds.length === 0 || value.sourceEventIds.length > 64
    || !value.sourceEventIds.every(isMemoryId) || new Set(value.sourceEventIds).size !== value.sourceEventIds.length) return false
  const scope = value.scope
  if (scope.kind !== 'profile' && !(scope.kind === 'project' && isMemoryId(scope.projectId))
    && !(scope.kind === 'task' && isMemoryId(scope.taskId))) return false
  return value.value.kind === 'fact' ? typeof value.value.text === 'string' && value.value.text.length <= 16_384
    && value.value.text.trim().length > 0 : value.value.kind === 'reference' && isMemoryId(value.value.ref)
}

function isTextList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string')
}

function isPriority(value: unknown): boolean { return value === 'high' || value === 'normal' || value === 'low' }

function isKnowledgeRootId(value: unknown): boolean {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(value)
}

function isKnowledgeRoots(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 8 && value.every(root => isRecord(root) && isKnowledgeRootId(root.id)
    && ['available', 'limited', 'unavailable'].some(status => status === root.status) && isCount(root.files))
}

function isKnowledgeSource(value: unknown): boolean {
  const digest = (id: unknown) => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id)
  return isRecord(value) && isRecord(value.ref) && isKnowledgeRootId(value.ref.rootId) && digest(value.ref.id)
    && digest(value.revision) && typeof value.path === 'string' && value.path.length <= 768
    && value.path.split('/').every(part => part.length && !part.startsWith('.') && !/[\\\p{Cc}]/u.test(part))
}

function isConnectorBinding(value: unknown): value is { account: { id: number; login: string };
  repository: { id: number; owner: string; name: string } } {
  const login = (raw: unknown) => typeof raw === 'string' && /^[a-zA-Z\d][a-zA-Z\d-]{0,38}$/u.test(raw)
  return isRecord(value) && isRecord(value.account) && isRecord(value.repository)
    && typeof value.account.id === 'number' && isCount(value.account.id) && value.account.id > 0 && login(value.account.login)
    && typeof value.repository.id === 'number' && isCount(value.repository.id) && value.repository.id > 0
    && login(value.repository.owner) && typeof value.repository.name === 'string' && /^[a-zA-Z\d_.-]{1,100}$/u.test(value.repository.name)
    && value.repository.name !== '.' && value.repository.name !== '..'
}

function isConnectorItem(value: unknown, path: string): boolean {
  if (!isRecord(value) || typeof value.id !== 'number' || !isCount(value.id) || value.id === 0
    || typeof value.number !== 'number' || !isCount(value.number) || value.number === 0 || typeof value.author !== 'string'
    || typeof value.text !== 'string' || value.text.length > 4096 || !isMemoryInstant(value.createdAt) || !isMemoryInstant(value.updatedAt)
    || (value.authorId !== undefined && (typeof value.authorId !== 'number' || !isCount(value.authorId) || value.authorId === 0))) return false
  if (value.kind === 'comment') return value.title === undefined && value.url === `${path}/issues/${value.number}#issuecomment-${value.id}`
  return (value.kind === 'issue' || value.kind === 'pull') && typeof value.title === 'string' && value.title.length <= 512
    && value.url === `${path}/${value.kind === 'pull' ? 'pull' : 'issues'}/${value.number}`
}

function isPlanDraft(value: unknown): boolean {
  return isRecord(value) && typeof value.title === 'string' && typeof value.purpose === 'string' && isPriority(value.priority)
    && isTextList(value.successCriteria) && Array.isArray(value.milestones) && value.milestones.length <= 64
    && value.milestones.every(item => isRecord(item) && typeof item.title === 'string'
      && (item.deadline === undefined || (isRecord(item.deadline) && isMemoryInstant(item.deadline.at) && typeof item.deadline.timeZone === 'string')))
    && (value.reviewCadence === undefined || (isRecord(value.reviewCadence) && isCount(value.reviewCadence.intervalDays)
      && typeof value.reviewCadence.timeZone === 'string'))
}

function isInboxResponse(value: unknown): value is InboxResponse {
  if (!isRecord(value)) return false
  if (value.ok === false) return typeof value.code === 'string' && (value.retryAt === undefined || isMemoryInstant(value.retryAt))
  if (value.ok !== true) return false
  if (value.kind === 'updated') {
    return (value.taskId === undefined || typeof value.taskId === 'string')
      && (value.projectId === undefined || typeof value.projectId === 'string')
  }
  if (value.kind === 'subscription' || value.kind === 'attention_policy') {
    return typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version > 0
  }
  if (value.kind === 'resident') return isRecord(value.value)
  if (value.kind === 'context') return value.value === null || Array.isArray(value.value) || isRecord(value.value)
  if (value.kind === 'connector_status' || value.kind === 'connector_page') {
    if (!isConnectorBinding(value.binding) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.fingerprint)) return false
    if (value.kind === 'connector_status') return true
    const { owner, name } = value.binding.repository
    const path = `https://github.com/${owner}/${name}`
    return Array.isArray(value.items) && value.items.length <= 20 && value.items.every(item => isConnectorItem(item, path))
      && (value.nextCursor === undefined || typeof value.nextCursor === 'string' && value.nextCursor.length === 36)
  }
  if (value.kind === 'knowledge_status') return isKnowledgeRoots(value.roots)
  if (value.kind === 'knowledge_search') {
    return isKnowledgeRoots(value.roots) && Array.isArray(value.hits) && value.hits.length <= 20
      && value.hits.every(hit => isRecord(hit) && isKnowledgeSource(hit) && typeof hit.snippet === 'string' && hit.snippet.length <= 361)
  }
  if (value.kind === 'knowledge_page') {
    return isKnowledgeSource(value.source) && typeof value.text === 'string' && value.text.length <= 4096
      && typeof value.totalBytes === 'number' && isCount(value.totalBytes) && value.totalBytes <= 1024 * 1024
      && (value.nextOffset === undefined || (typeof value.nextOffset === 'number' && isCount(value.nextOffset) && value.nextOffset < value.totalBytes))
  }
  if (value.kind === 'project_plan' && isRecord(value.plan)) {
    const plan = value.plan
    return typeof plan.projectId === 'string' && (plan.kind === 'project' || plan.kind === 'goal') && isCount(plan.revision)
      && isPlanDraft(plan.draft) && Array.isArray(plan.history) && plan.history.length <= 20
      && plan.history.every(row => isRecord(row) && isCount(row.revision) && isPlanDraft(row.draft)
        && (row.rationale === undefined || typeof row.rationale === 'string')
        && (row.recordedAt === undefined || isMemoryInstant(row.recordedAt)))
  }
  if (value.kind === 'project_review') {
    return isMemoryInstant(value.at) && typeof value.needsPriority === 'boolean' && Array.isArray(value.projects)
      && value.projects.length <= 64 && value.projects.every(item => isRecord(item) && typeof item.projectId === 'string'
        && typeof item.title === 'string' && isPriority(item.priority) && (item.due === undefined || isMemoryInstant(item.due))
        && [item.milestones, item.ready, item.waiting, item.accepted].every(isTextList))
  }
  if (value.kind === 'memory_records') {
    return Array.isArray(value.confirmed) && Array.isArray(value.inferred)
      && value.confirmed.length + value.inferred.length <= 25
      && value.confirmed.every(record => isMemoryRecord(record, 'explicit')) && value.inferred.every(record => isMemoryRecord(record, 'inferred'))
  }
  if (value.kind === 'memory_change') {
    return (value.state === 'completed' || value.state === 'pending') && isMemoryId(value.recordId)
      && typeof value.revision === 'number' && isCount(value.revision) && value.revision > 0
  }
  if (value.kind === 'artifact' && isRecord(value.artifact)) {
    return typeof value.artifact.id === 'string' && typeof value.artifact.mediaType === 'string'
      && Number.isSafeInteger(value.artifact.version) && typeof value.artifact.text === 'string'
  }
  if (value.kind === 'snapshot' && isRecord(value.snapshot)) {
    const snapshot = value.snapshot
    return typeof snapshot.workerConfigured === 'boolean' && Array.isArray(snapshot.sessions)
      && Array.isArray(snapshot.projects) && Array.isArray(snapshot.tasks) && Array.isArray(snapshot.approvals)
      && (snapshot.memoryConfigured === undefined || typeof snapshot.memoryConfigured === 'boolean')
      && (snapshot.knowledgeConfigured === undefined || typeof snapshot.knowledgeConfigured === 'boolean')
      && (snapshot.githubRead === undefined || (isRecord(snapshot.githubRead)
        && (snapshot.githubRead.projectId === undefined || typeof snapshot.githubRead.projectId === 'string')))
      && (snapshot.usage === undefined || isUsage(snapshot.usage))
      && (snapshot.schedules === undefined || isSchedules(snapshot.schedules))
  }
  return false
}

/** Use the current DSH Connection and the host's authenticated Inbox endpoint. */
export function createInboxPort(connection: Pick<ConnectionHandle, 'rpc'>): InboxPort {
  return async (request, signal) => {
    const result = await connection.rpc.call('/api', INBOX_RPC_ENDPOINT, request, signal)
    if (!result.ok || !isInboxResponse(result.value)) throw new Error('Inbox transport unavailable')
    return result.value
  }
}

function connectionView(connection: ConnectionHandle): InboxConnection {
  return {
    getSnapshot() {
      const state = connection.state.getSnapshot()
      const generation = connection.generation.getSnapshot()
      const phase = state === 'connected' && !generation ? 'connecting' : state ?? 'connecting'
      return `${phase}:${generation?.id ?? 0}`
    },
    subscribe(listener) {
      const stopState = connection.state.subscribe(listener)
      const stopGeneration = connection.generation.subscribe(listener)
      return () => {
        stopState()
        stopGeneration()
      }
    },
  }
}

async function openKnownSession(ctx: ClientContext, id: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  const sessionId = id as SessionId
  let list = ctx.sessions.list.getSnapshot()
  if (list.phase !== 'ready' || !list.byId[sessionId]) {
    await ctx.sessions.refresh()
    list = ctx.sessions.list.getSnapshot()
  }
  if (signal.aborted || list.phase !== 'ready' || !list.byId[sessionId]) return false
  ctx.uiWorkspace.openSession(sessionId)
  return true
}

function TodayIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="m7.5 11 2 2 4-4M12 15.5h4.5" />
  </svg>
}

export function apply(ctx: ClientContext): void {
  ctx.effect(function* () {
    yield ctx.locale.register(namespace, 'en', dictionaries.en)
    yield ctx.locale.register(namespace, 'zh', dictionaries.zh)
  }, 'dshpa: Today dictionaries')
  const t = ctx.locale.bind(namespace)
  const port = createInboxPort(ctx.connection)
  const connection = connectionView(ctx.connection)
  const memory = createInboxMemory()
  const openSession = (id: string, signal: AbortSignal) => openKnownSession(ctx, id, signal)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, locale: namespace, inject: () => ({}),
  }, ({ t }: { t: Translate }) => <>
    <style>{inboxStyles}</style>
    <Inbox t={t} port={port} connection={connection} openSession={openSession} memory={memory} />
  </>))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: 12, label: () => t('app.title'), locale: namespace,
  }, TodayIcon))
}
