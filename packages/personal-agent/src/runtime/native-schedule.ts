import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule'
import { appendPluginRecord, pluginRecordOf, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { utcInstantSchema, type UtcInstant } from '../domain/model.js'
import { routineMappingSchema } from '../domain/routines.js'
import { createPrivateWorkers } from '../policy/private-worker.js'

const SINK_PREFIX = 'dshpa-routine-sink-'
const SINK_ROUTE = { provider: 'dshpa-routine-sink', model: 'no-model' }
const SINK_RECORD = 'plugin:dshpa/routine-sink'
const NATIVE_TITLE = 'Personal Agent routine wake'
const MAX_NATIVE_RECORDS = 10_000
const HISTORY_PAGE_SIZE = 100
const markerSchema = routineMappingSchema.shape.marker

export interface NativeScheduleEntry {
  readonly id: string
  readonly marker: string
  readonly wakeAt: UtcInstant
  readonly status: 'active' | 'paused' | 'ended'
  readonly targetSessionId: string
  readonly invalid?: true
}

export interface NativeScheduleReceipt {
  readonly nativeId: string
  readonly marker: string
  readonly prompt: string
  readonly wakeAt: UtcInstant
  readonly deliveredAt: UtcInstant
  readonly targetSessionId: string
  readonly messageId: string
}

export interface NativeSchedulePort {
  readonly targetSessionId: string
  catalog(): Promise<readonly NativeScheduleEntry[]>
  create(request: { marker: string; wakeAt: UtcInstant }): Promise<NativeScheduleEntry>
  history(id: string): Promise<readonly NativeScheduleReceipt[]>
  retire?(receipt: NativeScheduleReceipt): Promise<boolean>
  cancel?(entry: NativeScheduleEntry): Promise<boolean>
  subscribe(onChanged: () => void): () => void
  dispose(): Promise<void>
}

/** The exact wake elapsed before the carrier called native create. */
export class NativeWakeElapsed extends Error {}

export interface NativeScheduleSink {
  configure(options: { storageDirectory: string; cwd: string }): void
  connect(scheduleCtx: Context): NativeSchedulePort
  dispose(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshpaScheduleResolverReady: true
    dshpaScheduleSink: NativeScheduleSink
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:dshpa/routine-sink': { readonly version: 1; readonly id: SessionId }
  }
}

function project(entry: ScheduleCatalogEntry, target: SessionId): NativeScheduleEntry | undefined {
  if (!markerSchema.safeParse(entry.prompt).success) return undefined
  const targetSessionId = entry.target.kind === 'new' ? '' : entry.target.sessionId
  const valid = entry.kind === 'at' && entry.title === NATIVE_TITLE && entry.target.kind === 'session' && targetSessionId === target
  return { id: entry.id, marker: entry.prompt, wakeAt: utcInstantSchema.parse(entry.scheduledAt), status: entry.status, targetSessionId,
    ...(valid ? {} : { invalid: true }) }
}

function checkHeader(header: SessionHeader, id: SessionId, cwd: string): void {
  if (header.id !== id || header.cwd !== cwd || header.isSeeded || header.origin !== undefined
    || header.parentSession !== undefined || (header.delegationDepth ?? 0) !== 0) {
    throw new Error('The routine sink Session identity could not be verified')
  }
}

export function isRoutineSinkSession(id: string): boolean {
  return id.startsWith(SINK_PREFIX)
}

/** Install the reserved identity fence before native schedule initialization. */
export function installNativeScheduleSink(ctx: Context): NativeScheduleSink {
  let configured: { id: SessionId; cwd: string } | undefined
  let handle: AgentHandle | undefined
  let opening: Promise<AgentHandle> | undefined
  let connected = false
  let closed = false
  let cleanup: Promise<void> | undefined
  const owned = new WeakSet<Agent>()
  const listeners = new Set<() => void>()

  async function acquire(): Promise<AgentHandle> {
    if (closed || !configured) throw new Error('The routine sink is unavailable')
    if (handle) {
      if (ctx.agents.get(configured.id) !== handle.agent) throw new Error('The routine sink Agent is no longer owned')
      return handle
    }
    const { id, cwd } = configured
    opening ??= ctx.agents.withoutInitiator(async () => {
      const persistence = ctx.get('sessionPersistence')
      const sessions = ctx.get('sessions')
      if (!persistence || !sessions || ctx.agents.get(id) !== undefined || sessions.get(id) !== undefined) {
        throw new Error('The private routine sink could not be opened')
      }
      const saved = await persistence.stat(id)
      if (saved?.formatStatus === 'migration-required') throw new Error('The routine sink Session requires migration')
      if (saved) {
        checkHeader(saved.header, id, cwd)
        const reader = await persistence.open(id, 'read')
        try {
          checkHeader(reader.header, id, cwd)
          const { events } = await reader.read(0, 128)
          const proofs = events.map(pluginRecordOf).filter(record => record?.type === SINK_RECORD)
          const proof = proofs[0]?.data
          if (proofs.length !== 1 || typeof proof !== 'object' || proof === null
            || !('version' in proof) || proof.version !== 1 || !('id' in proof) || proof.id !== id) {
            throw new Error('The persisted routine sink has no exact ownership record')
          }
        } finally {
          await reader.close()
        }
        const checked = await persistence.stat(id)
        if (!checked || checked.revision !== saved.revision) throw new Error('The persisted routine sink changed during inspection')
      }
      if (closed) throw new Error('The routine sink is closing')
      const workers = createPrivateWorkers(ctx, (agentCtx, agent) => {
        checkHeader(agent.session.header, id, cwd)
        if (!saved) appendPluginRecord(agent.session, SINK_RECORD, { version: 1, id })
        // The sink owns only native inbox bookkeeping. Business intake uses
        // saved schedule receipts independently of this Agent.
        agentCtx.on('agent/pre-step', async () => ({ kind: 'reject' }), { prepend: true })
        return { commit: () => owned.add(agent) }
      })
      const candidate = saved ? await workers.resume({ resumeSessionId: id, agentOptions: SINK_ROUTE })
        : await workers.create({ sessionId: id, agentOptions: SINK_ROUTE, meta: { cwd } })
      try {
        checkHeader(candidate.agent.session.header, id, cwd)
        if (closed || !await sessions.flush(candidate.agent.session) || closed) {
          throw new Error('The routine sink Session was not durably opened')
        }
        handle = candidate
        return candidate
      } catch (error) {
        await candidate.dispose()
        throw error
      }
    }).finally(() => { opening = undefined })
    return opening
  }

  // The stock Web/session controller can otherwise resume a stored Session
  // directly. Native AgentLoop holds its inputs until this event succeeds.
  ctx.on('agent/created', ({ agent }) => {
    if (isRoutineSinkSession(agent.id) && !owned.has(agent)) throw new Error('The routine sink requires its private resolver')
    return undefined
  }, { prepend: true })
  ctx.on('llm/stream', (request, next) => {
    if (request.sessionId === undefined || !isRoutineSinkSession(request.sessionId)) return next()
    return (async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code: 'ROUTINE_SINK', message: 'The routine sink does not invoke models.',
      } } }
    })()
  }, { prepend: true })
  ctx.on('schedule/resolve-agent', async (id, next) => {
    if (!isRoutineSinkSession(id)) return next()
    if (configured?.id !== id) throw new Error('The requested routine sink is unavailable')
    return (await acquire()).agent
  }, { prepend: true })

  function dispose(): Promise<void> {
    closed = true
    cleanup ??= (async () => {
      for (const unsubscribe of listeners) unsubscribe()
      await opening?.catch(() => undefined)
      await handle?.dispose()
      handle = undefined
    })()
    return cleanup
  }

  return Object.freeze<NativeScheduleSink>({
    configure({ storageDirectory, cwd }) {
      if (closed || configured) throw new Error('The routine sink is already configured or closed')
      const identity = createHash('sha256').update(resolve(storageDirectory)).digest('hex')
      configured = { id: SessionId(`${SINK_PREFIX}${identity}`), cwd: resolve(cwd) }
    },
    connect(scheduleCtx) {
      const schedule = scheduleCtx.get('schedule')
      if (closed || connected || !configured || !schedule) throw new Error('The native routine carrier is unavailable')
      connected = true
      const target = configured.id
      function assertOpen(): void {
        if (closed) throw new Error('The native routine carrier is closed')
      }
      const remove = async (id: ScheduleCatalogEntry['id'], expectedUpdatedAt: string): Promise<boolean> => {
        assertOpen()
        const result = await schedule.edit({ id, action: 'delete', expectedUpdatedAt }, target)
        return 'deleted' in result && result.deleted
      }
      const historyFor = async (entry: NativeScheduleEntry): Promise<NativeScheduleReceipt[]> => {
        const nativeId = entry.id as ScheduleCatalogEntry['id']
        const receipts: NativeScheduleReceipt[] = []
        let before: Parameters<typeof schedule.history>[0]['before']
        let seen = 0
        do {
          const page = await schedule.history({ id: nativeId, limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) })
          assertOpen()
          if ('code' in page || page.id !== nativeId || page.records.length > HISTORY_PAGE_SIZE
            || page.earlierRecordsUnavailable || page.earlierRecordsPruned
            || page.nextBefore !== undefined && (page.nextBefore === before || page.nextBefore !== page.records.at(-1)?.messageId)) {
            throw new Error('The native routine receipt history could not be reconciled')
          }
          seen += page.records.length
          if (seen > MAX_NATIVE_RECORDS) throw new Error('The native schedule history exceeds the reconciliation bound')
          for (const record of page.records) {
            if (record.scheduledAt !== entry.wakeAt || record.targetSessionId !== target || record.prompt !== entry.marker) continue
            const deliveredAt = utcInstantSchema.parse(record.deliveredAt)
            if (deliveredAt < entry.wakeAt) throw new Error('The native routine receipt predates its wake')
            receipts.push({ nativeId, marker: entry.marker, prompt: record.prompt, wakeAt: entry.wakeAt, deliveredAt,
              targetSessionId: target, messageId: record.messageId })
          }
          before = page.nextBefore
        } while (before !== undefined)
        return receipts
      }
      return Object.freeze<NativeSchedulePort>({
        targetSessionId: target,
        async catalog() {
          assertOpen()
          const entries = await schedule.catalog()
          assertOpen()
          if (entries.length > MAX_NATIVE_RECORDS) throw new Error('The native schedule catalog exceeds the reconciliation bound')
          return entries.flatMap(entry => {
            const value = project(entry, target)
            return value ? [value] : []
          })
        },
        async create({ marker, wakeAt }) {
          assertOpen()
          if (!markerSchema.safeParse(marker).success || !utcInstantSchema.safeParse(wakeAt).success) throw new Error('Invalid routine wake')
          await acquire()
          assertOpen()
          if (Date.parse(wakeAt) <= Date.now()) throw new NativeWakeElapsed('The routine wake elapsed before native creation')
          const raw = await schedule.create({
            title: NATIVE_TITLE, prompt: marker,
            target: { kind: 'session', sessionId: target }, timing: { kind: 'at', at: wakeAt },
          }, target)
          const entry = project(raw, target)
          if (!entry || entry.invalid || entry.marker !== marker || entry.wakeAt !== wakeAt || entry.status !== 'active') {
            throw new Error('The native routine wake did not match its intent')
          }
          return entry
        },
        async history(id) {
          assertOpen()
          const nativeId = id as ScheduleCatalogEntry['id']
          const raw = await schedule.view({ id: nativeId })
          assertOpen()
          const entry = 'code' in raw ? undefined : project(raw, target)
          return entry?.status === 'ended' && !entry.invalid ? historyFor(entry) : []
        },
        async retire(receipt) {
          assertOpen()
          const id = receipt.nativeId as ScheduleCatalogEntry['id']
          const raw = await schedule.view({ id })
          if ('code' in raw || raw.updatedAt === undefined) return false
          const entry = project(raw, target)
          if (entry?.status !== 'ended' || entry.invalid || entry.wakeAt !== receipt.wakeAt || entry.marker !== receipt.marker
            || entry.marker !== receipt.prompt || entry.targetSessionId !== receipt.targetSessionId) return false
          const matches = await historyFor(entry)
          if (matches.length !== 1 || matches[0]?.messageId !== receipt.messageId
            || matches[0].deliveredAt !== receipt.deliveredAt) return false
          return remove(id, raw.updatedAt)
        },
        async cancel(candidate) {
          assertOpen()
          if (candidate.invalid || candidate.status === 'ended' || candidate.targetSessionId !== target) return false
          const id = candidate.id as ScheduleCatalogEntry['id']
          const raw = await schedule.view({ id })
          if ('code' in raw || raw.updatedAt === undefined) return false
          const entry = project(raw, target)
          if (!entry || entry.invalid || entry.status !== candidate.status || entry.wakeAt !== candidate.wakeAt
            || entry.marker !== candidate.marker) return false
          return remove(id, raw.updatedAt)
        },
        subscribe(onChanged) {
          assertOpen()
          const stop = scheduleCtx.on('schedule/changed', () => {
            try { onChanged() } catch { /* A bridge listener cannot interrupt native dispatch. */ }
          })
          const unsubscribe = () => {
            if (listeners.delete(unsubscribe)) stop()
          }
          listeners.add(unsubscribe)
          return unsubscribe
        },
        dispose,
      })
    },
    dispose,
  })
}
