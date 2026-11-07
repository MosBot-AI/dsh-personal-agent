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

function isInboxResponse(value: unknown): value is InboxResponse {
  if (!isRecord(value)) return false
  if (value.ok === false) return typeof value.code === 'string'
  if (value.ok !== true) return false
  if (value.kind === 'updated') {
    return (value.taskId === undefined || typeof value.taskId === 'string')
      && (value.projectId === undefined || typeof value.projectId === 'string')
  }
  if (value.kind === 'subscription' || value.kind === 'attention_policy') {
    return typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version > 0
  }
  if (value.kind === 'artifact' && isRecord(value.artifact)) {
    return typeof value.artifact.id === 'string' && typeof value.artifact.mediaType === 'string'
      && Number.isSafeInteger(value.artifact.version) && typeof value.artifact.text === 'string'
  }
  if (value.kind === 'snapshot' && isRecord(value.snapshot)) {
    const snapshot = value.snapshot
    return typeof snapshot.workerConfigured === 'boolean' && Array.isArray(snapshot.sessions)
      && Array.isArray(snapshot.projects) && Array.isArray(snapshot.tasks) && Array.isArray(snapshot.approvals)
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
