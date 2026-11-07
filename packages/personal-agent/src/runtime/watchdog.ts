import { z } from 'zod'
import { utcInstantSchema, type AttemptId, type TaskId, type UtcInstant } from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import type { WorkRef } from '../storage/store.js'
import type { WorkerObservation } from './native-worker.js'

const DAY_MS = 86_400_000
const MAX_RECENT_TOOLS = 64

export const watchdogConfigSchema = z.strictObject({
  tickMs: z.int().min(100).max(60_000).default(5_000),
  heartbeatGapMs: z.int().min(200).max(3_600_000).default(30_000),
  staleProgressMs: z.int().min(100).max(DAY_MS).default(120_000),
  repeatedToolCalls: z.int().min(2).max(32).default(4),
  repeatWindowMs: z.int().min(100).max(3_600_000).default(60_000),
  warmTimeoutMs: z.int().min(100).max(120_000).default(10_000),
  retentionDays: z.int().min(1).max(90).default(14),
  maxDiagnostics: z.int().min(1).max(4_096).default(512),
}).refine(config => config.heartbeatGapMs >= config.tickMs * 2)

type WatchdogConfig = z.input<typeof watchdogConfigSchema>
type Scope = Pick<WorkRef, 'ownerId' | 'profileId'>
type WorkStatus = WorkState['task']['status']

type HostCode = 'heartbeat_gap' | 'warm_reconcile_failed'
type IssueCode = 'budget_exhausted' | 'compute_capacity' | 'compute_limit' | 'meter_unavailable' | 'price_unknown'
  | 'provider_rate_limited' | 'provider_unavailable' | 'provider_authentication' | 'provider_rejected'
type WorkerCode = 'stale_progress' | 'repeated_tool_call' | IssueCode
export type WatchdogCode = HostCode | WorkerCode

export type WatchdogDiagnostic = { readonly code: HostCode; readonly at: UtcInstant }
  | { readonly code: WorkerCode; readonly at: UtcInstant; readonly taskId: TaskId; readonly attemptId: AttemptId; readonly generation: number }

export interface WatchdogSnapshot {
  readonly reconciling: boolean
  readonly degraded: readonly { readonly code: WatchdogCode; readonly count: number }[]
}

export interface WatchdogWorker {
  readonly attemptId: AttemptId
  readonly generation: number
  readonly status: WorkStatus
  readonly active?: boolean
}

export interface WatchdogOptions {
  readonly readWorker: (ref: WorkRef) => WatchdogWorker | undefined
  readonly reconcileWarm?: (signal: AbortSignal) => void | Promise<void>
  readonly config?: WatchdogConfig
  readonly wallNow?: () => number
  readonly monotonicNow?: () => number
}

const issueCodes = new Map<string, IssueCode>([
  ['budget_exceeded', 'budget_exhausted'],
  ['capacity', 'compute_capacity'],
  ['compute_limit', 'compute_limit'],
  ['turn_limit', 'compute_limit'],
  ['meter_unavailable', 'meter_unavailable'],
  ['price_unknown', 'price_unknown'],
  ['provider_rate_limited', 'provider_rate_limited'],
  ['provider_unavailable', 'provider_unavailable'],
  ['provider_authentication', 'provider_authentication'],
  ['provider_rejected', 'provider_rejected'],
])

interface WorkerWatch {
  readonly ref: WorkRef
  readonly attemptId: AttemptId
  readonly generation: number
  status: WorkStatus
  lastProgress: number
  stale: boolean
  repeated: boolean
  issue?: IssueCode
  tools: { digest: string; at: number }[]
}

interface RetainedDiagnostic {
  readonly scope?: Scope
  readonly record: WatchdogDiagnostic
  readonly expiresAt: number
}

const MAX_WATCHED_WORKERS = 128

function sameScope(left: Scope, right: Scope): boolean {
  return left.ownerId === right.ownerId && left.profileId === right.profileId
}

function workerKey(ref: WorkRef): string {
  return JSON.stringify([ref.ownerId, ref.profileId, ref.taskId])
}

function watchable(worker: WatchdogWorker | undefined): worker is WatchdogWorker {
  return worker?.status === 'waiting_resource' || (worker?.status === 'running' && worker.active !== false)
}

/** Diagnostics only. The warm seam has no Worker restart, replay or cold recovery action. */
export function createWatchdog(options: WatchdogOptions) {
  const config = watchdogConfigSchema.parse(options.config ?? {})
  const wallNow = options.wallNow ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  let lastHeartbeat = { wall: wallNow(), monotonic: monotonicNow() }
  let retentionClock = { ...lastHeartbeat }
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let heartbeatGap = false
  let warmFailed = false
  let warm: { controller: AbortController; done: Promise<void> } | undefined
  const workers = new Map<string, WorkerWatch>()
  let retained: RetainedDiagnostic[] = []

  function current(ref: WorkRef): WatchdogWorker | undefined {
    try { return options.readWorker(ref) } catch { return undefined }
  }

  function prune() {
    const monotonic = monotonicNow()
    const wall = Math.max(wallNow(), retentionClock.wall + Math.max(0, monotonic - retentionClock.monotonic))
    retentionClock = { wall, monotonic }
    retained = retained.filter(entry => entry.expiresAt > wall)
    return wall
  }

  function record(code: HostCode): void
  function record(code: WorkerCode, worker: WorkerWatch): void
  function record(code: WatchdogCode, worker?: WorkerWatch): void {
    const wall = wallNow()
    if (!Number.isFinite(wall) || Math.abs(wall) > 8.64e15) return
    const at = utcInstantSchema.safeParse(new Date(wall).toISOString())
    if (!at.success) return
    const expiresAt = prune() + config.retentionDays * DAY_MS
    if (worker) {
      const { ownerId, profileId, taskId } = worker.ref
      retained.push({ scope: { ownerId, profileId }, expiresAt,
        record: { code: code as WorkerCode, at: at.data, taskId, attemptId: worker.attemptId, generation: worker.generation } })
    } else {
      retained.push({ expiresAt, record: { code: code as HostCode, at: at.data } })
    }
    if (retained.length > config.maxDiagnostics) retained.shift()
  }

  function updateStatus(watch: WorkerWatch, status: WorkStatus, now: number): void {
    if (watch.status === status) return
    watch.status = status
    watch.stale = false
    watch.repeated = false
    watch.tools.length = 0
    if (status === 'running') {
      watch.lastProgress = now
      watch.issue = undefined
    }
  }

  function sampleWorkers(now = monotonicNow()): void {
    for (const [key, watch] of workers) {
      const worker = current(watch.ref)
      if (!watchable(worker) || watch.attemptId !== worker.attemptId || watch.generation !== worker.generation) {
        workers.delete(key)
        continue
      }
      updateStatus(watch, worker.status, now)
    }
  }

  function checkRepeated(watch: WorkerWatch, now: number): void {
    watch.tools = watch.tools.filter(tool => now - tool.at < config.repeatWindowMs)
    const counts = new Map<string, number>()
    for (const { digest } of watch.tools) counts.set(digest, (counts.get(digest) ?? 0) + 1)
    const repeated = [...counts.values()].some(count => count >= config.repeatedToolCalls)
    if (repeated && !watch.repeated) record('repeated_tool_call', watch)
    watch.repeated = repeated
  }

  function observe(ref: WorkRef, state: WorkState, signal: WorkerObservation): void {
    if (stopped || !sameScope(state.task, ref) || state.task.id !== ref.taskId || state.attempt.taskId !== ref.taskId) return
    const worker = current(ref)
    if (!watchable(worker) || worker.attemptId !== state.attempt.id || worker.generation !== state.attempt.generation
      || worker.generation !== state.task.generation || state.task.attemptId !== state.attempt.id
      || (signal.kind !== 'issue' && worker.status !== 'running')) return
    const issue = signal.kind === 'issue' ? issueCodes.get(signal.code) : undefined
    if ((signal.kind === 'issue' && !issue) || (signal.kind === 'tool' && !/^[0-9a-f]{64}$/.test(signal.digest))) return
    const now = monotonicNow()
    const key = workerKey(ref)
    let watch = workers.get(key)
    if (!watch || watch.attemptId !== worker.attemptId || watch.generation !== worker.generation) {
      if (workers.size >= MAX_WATCHED_WORKERS) sampleWorkers()
      if (workers.size >= MAX_WATCHED_WORKERS && !workers.has(key)) return
      watch = { ref: { ownerId: ref.ownerId, profileId: ref.profileId, taskId: ref.taskId }, attemptId: worker.attemptId,
        generation: worker.generation, status: worker.status, lastProgress: now, stale: false, repeated: false, tools: [] }
      workers.set(key, watch)
    }
    updateStatus(watch, worker.status, now)
    if (signal.kind === 'start' || signal.kind === 'progress') {
      watch.lastProgress = now
      watch.stale = false
      watch.repeated = false
      watch.issue = undefined
      watch.tools.length = 0
    } else if (signal.kind === 'tool') {
      watch.tools.push({ digest: signal.digest, at: now })
      if (watch.tools.length > MAX_RECENT_TOOLS) watch.tools.shift()
      checkRepeated(watch, now)
    } else if (issue && issue !== watch.issue) {
      watch.issue = issue
      record(issue, watch)
    }
  }

  function beginWarm(): Promise<void> {
    if (warm || stopped || !options.reconcileWarm) return warm?.done ?? Promise.resolve()
    const controller = new AbortController()
    const { promise: done, resolve } = Promise.withResolvers<void>()
    const attempt = { controller, done }
    warm = attempt
    const fail = () => {
      warmFailed = true
      record('warm_reconcile_failed')
    }
    const deadline = setTimeout(() => {
      if (!controller.signal.aborted) { fail(); controller.abort() }
    }, config.warmTimeoutMs)
    controller.signal.addEventListener('abort', () => { clearTimeout(deadline); resolve() }, { once: true })
    deadline.unref()
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return options.reconcileWarm!(controller.signal)
    }).then(() => {
      if (!controller.signal.aborted) warmFailed = false
    }, () => {
      if (!controller.signal.aborted) fail()
    }).finally(() => {
      clearTimeout(deadline)
      warm = undefined
      resolve()
    })
    return done
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve()
    const wall = wallNow()
    const monotonic = monotonicNow()
    heartbeatGap = Math.max(wall - lastHeartbeat.wall, monotonic - lastHeartbeat.monotonic) >= config.heartbeatGapMs
    lastHeartbeat = { wall, monotonic }
    prune()
    sampleWorkers(monotonic)
    for (const watch of workers.values()) {
      if (watch.status !== 'running') continue
      const stale = monotonic - watch.lastProgress >= config.staleProgressMs
      if (stale && !watch.stale) record('stale_progress', watch)
      watch.stale = stale
      checkRepeated(watch, monotonic)
    }
    if (!heartbeatGap) return warm?.done ?? Promise.resolve()
    record('heartbeat_gap')
    return beginWarm()
  }

  const isReconciling = () => warm !== undefined && !warm.controller.signal.aborted

  return Object.freeze({
    observe,
    tick,
    isReconciling,
    start() {
      if (timer || stopped) return
      lastHeartbeat = { wall: wallNow(), monotonic: monotonicNow() }
      timer = setInterval(() => { void tick() }, config.tickMs)
      timer.unref()
    },
    stop(): Promise<void> {
      stopped = true
      clearInterval(timer)
      workers.clear()
      warm?.controller.abort()
      return warm?.done ?? Promise.resolve()
    },
    snapshot(): WatchdogSnapshot {
      sampleWorkers()
      const counts = new Map<WatchdogCode, number>()
      const add = (code: WatchdogCode) => counts.set(code, (counts.get(code) ?? 0) + 1)
      if (heartbeatGap && !stopped) add('heartbeat_gap')
      if (warmFailed) add('warm_reconcile_failed')
      for (const worker of workers.values()) {
        if (worker.stale) add('stale_progress')
        if (worker.repeated) add('repeated_tool_call')
        if (worker.issue) add(worker.issue)
      }
      return { reconciling: isReconciling(),
        degraded: [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([code, count]) => ({ code, count })) }
    },
    diagnostics(scope: Scope, limit = 100): readonly WatchdogDiagnostic[] {
      if (!Number.isSafeInteger(limit) || limit < 1) return []
      prune()
      return retained.filter(entry => !entry.scope || sameScope(entry.scope, scope)).slice(-Math.min(limit, config.maxDiagnostics))
        .reverse().map(entry => ({ ...entry.record }))
    },
  })
}
