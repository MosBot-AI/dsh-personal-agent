import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  artifactIdSchema, nonEmptyTextSchema, sessionIdSchema, taskIdSchema, utcInstantSchema,
  versionSchema, WORKER_INPUT_LIMIT, type UtcInstant,
} from '../domain/model.js'
import type { WorkEvent, WorkState } from '../domain/transitions.js'
import type { StoredCommandContext, StoredWorkResult, WorkRef, WorkStore } from '../storage/store.js'
import type { NativeWorker, NativeWorkerRuntime } from './native-worker.js'
import { allowsWorkerData, resolveWorkerDirectory, workerPresetSchema, type WorkerPreset } from './presets.js'
import { decodeWorkerReport, workerInputSchema, type WorkerReport } from './reports.js'

const launchSchema = z.strictObject({
  expectedVersion: versionSchema,
  presetId: nonEmptyTextSchema.max(256),
  cwd: nonEmptyTextSchema.max(4_096),
  dataScope: z.array(nonEmptyTextSchema.max(256)).max(64),
  input: workerInputSchema,
})
const concurrencySchema = z.int().min(1).max(32)
const MAX_DEPENDENCY_CHAIN = 64
const OPEN_DRAIN_TIMEOUT_MS = 10_000
const openingPending = Symbol('opening_pending')

type WorkerInput = z.infer<typeof workerInputSchema>
type ExecutorFailure = { ok: false; code: 'capacity' | 'already_active' | 'duplicate_input' | 'host_unavailable' | 'closed' }
export type ExecutorResult = StoredWorkResult | ExecutorFailure

export interface WorkerExecutorOptions {
  readonly store: WorkStore
  readonly runtime: NativeWorkerRuntime
  readonly presets: readonly WorkerPreset[]
  readonly concurrency?: number
  readonly captureResultSummary?: boolean
  readonly now?: () => UtcInstant
}

interface Entry {
  readonly ref: WorkRef
  readonly attemptId: WorkState['attempt']['id']
  readonly generation: number
  readonly abort: AbortController
  opening?: Promise<NativeWorker>
  native?: NativeWorker
  cleanup?: Promise<boolean>
  version: number
  cursor: string
  retiring: boolean
  failure?: string
  report?: WorkerReport
  issue?: string
}

type ReleaseEvent = Extract<WorkEvent, { type: 'release_worker' }>
const releaseProofs = new WeakMap<object, { store: WorkStore; ref: WorkRef; event: ReleaseEvent }>()

/** Consume the executor's one-use evidence of a stopped native Worker. */
export function consumeWorkerReleaseProof(proof: unknown, store: WorkStore) {
  if (typeof proof !== 'object' || proof === null) return undefined
  const release = releaseProofs.get(proof)
  if (!release || release.store !== store) return undefined
  releaseProofs.delete(proof)
  return release
}

function fence(state: WorkState, at: UtcInstant) {
  return {
    expectedVersion: state.task.version,
    attemptId: state.attempt.id,
    generation: state.attempt.generation,
    at,
  }
}

function nativeSessionId(state: WorkState) {
  const { task, attempt } = state
  const key = JSON.stringify([task.ownerId, task.profileId, task.id, attempt.id, attempt.generation])
  return sessionIdSchema.parse(`dshpa-${createHash('sha256').update(key).digest('hex')}`)
}

async function drainOpening(opening: Promise<NativeWorker> | undefined) {
  if (!opening) return undefined
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<typeof openingPending>(resolve => {
      timer = setTimeout(() => resolve(openingPending), OPEN_DRAIN_TIMEOUT_MS)
    })
    return await Promise.race([opening.catch(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Trusted coordinator for private, model-only DSH Workers. */
class WorkerExecutor {
  private readonly entries = new Map<WorkRef['taskId'], Entry>()
  private readonly presets = new Map<string, WorkerPreset>()
  private readonly limit: number
  private readonly now: () => UtcInstant
  private closed = false

  constructor(private readonly options: WorkerExecutorOptions) {
    this.limit = concurrencySchema.parse(options.concurrency ?? 2)
    this.now = options.now ?? (() => utcInstantSchema.parse(new Date().toISOString()))
    for (const raw of options.presets) {
      const preset = workerPresetSchema.parse(raw)
      if (this.presets.has(preset.id)) throw new Error('Duplicate worker preset')
      this.presets.set(preset.id, preset)
    }
  }

  query(ref: WorkRef) {
    const state = this.options.store.getWork(ref)
    const entry = this.entryFor(ref)
    return { state, active: entry !== undefined, report: entry?.report, issue: entry?.issue }
  }

  async launch(ref: WorkRef, input: unknown): Promise<ExecutorResult> {
    if (this.closed) return { ok: false, code: 'closed' }
    const decoded = launchSchema.safeParse(input)
    if (!decoded.success) return { ok: false, code: 'invalid_input' }
    const requested = decoded.data
    const { store, runtime } = this.options
    const state = store.getWork(ref)
    if (!state) return { ok: false, code: 'not_found' }
    if (state.task.version !== requested.expectedVersion) return { ok: false, code: 'version_conflict' }
    if (this.entries.has(ref.taskId)) return { ok: false, code: 'already_active' }
    if (state.task.status !== 'queued') return { ok: false, code: 'invalid_transition' }
    if (this.entries.size >= this.limit) return { ok: false, code: 'capacity' }

    const preset = this.presets.get(requested.presetId)
    if (!preset || !allowsWorkerData(preset, requested.dataScope)
      || new Set(requested.dataScope).size !== requested.dataScope.length) return { ok: false, code: 'permission_denied' }
    const cwd = resolveWorkerDirectory(preset.rootDirectory, requested.cwd)
    if (!cwd) return { ok: false, code: 'permission_denied' }
    const sessionId = nativeSessionId(state)
    const { worker: saved, sessionId: savedSession, scope: savedScope } = state.attempt
    if (savedSession !== undefined && !saved) return { ok: false, code: 'permission_denied' }
    if (saved) {
      if (saved.inputHistory.includes(requested.input.cursor)) return { ok: false, code: 'duplicate_input' }
      if (saved.inputHistory.length >= WORKER_INPUT_LIMIT) return { ok: false, code: 'capacity' }
      if (savedSession !== sessionId || saved.cwd !== cwd || saved.presetId !== preset.id
        || saved.provider !== preset.provider || saved.model !== preset.model
        || !requested.dataScope.every(label => savedScope?.dataScope.includes(label))) {
        return { ok: false, code: 'permission_denied' }
      }
    }

    const entry: Entry = {
      ref: { ...ref },
      attemptId: state.attempt.id,
      generation: state.attempt.generation,
      abort: new AbortController(),
      cursor: requested.input.cursor,
      version: state.task.version,
      retiring: false,
    }
    this.entries.set(ref.taskId, entry)
    let started: StoredWorkResult
    try {
      started = store.applyEvent(ref, {
        type: 'start',
        ...fence(state, this.now()),
        executor: 'native-dsh',
        sessionId,
        scope: { capabilities: [], dataScope: requested.dataScope },
        worker: {
          presetId: preset.id, cwd, provider: preset.provider, model: preset.model, inputCursor: requested.input.cursor,
          inputHistory: [...(saved?.inputHistory ?? []), requested.input.cursor],
        },
      })
    } catch (error) {
      this.entries.delete(ref.taskId)
      throw error
    }
    if (!started.ok) {
      this.entries.delete(ref.taskId)
      return started
    }
    entry.version = started.state.task.version
    entry.opening = Promise.resolve().then(() => runtime.open({
      sessionId, cwd, provider: preset.provider, model: preset.model,
      resume: saved !== undefined, signal: entry.abort.signal, isCurrent: () => this.current(entry) !== undefined,
    }))
    try {
      const worker = await entry.opening
      entry.native = worker
      if (!this.current(entry)) {
        void this.retire(entry)
        return { ok: false, code: 'stale_attempt' }
      }
      worker.followup(requested.input)
      void this.observe(entry, worker, requested.input)
      return started
    } catch {
      if (!entry.retiring) {
        entry.issue = 'host_unavailable'
        entry.failure = 'The native worker could not start its input.'
        void this.retire(entry)
      }
      return { ok: false, code: 'host_unavailable' }
    }
  }

  redirect(ref: WorkRef, expectedVersion: number, input: unknown): ExecutorResult {
    const decoded = workerInputSchema.safeParse(input)
    if (!decoded.success || !versionSchema.safeParse(expectedVersion).success) return { ok: false, code: 'invalid_input' }
    const entry = this.entryFor(ref)
    const worker = entry?.native
    if (!entry || !worker) return { ok: false, code: 'not_found' }
    const state = this.current(entry)
    if (!state) return { ok: false, code: 'stale_attempt' }
    if (state.task.version !== expectedVersion) return { ok: false, code: 'version_conflict' }
    const { cursor } = decoded.data
    const history = state.attempt.worker?.inputHistory
    if (!history) return { ok: false, code: 'stale_attempt' }
    if (history.includes(cursor)) return { ok: false, code: 'duplicate_input' }
    if (history.length >= WORKER_INPUT_LIMIT) return { ok: false, code: 'capacity' }

    const result = this.options.store.applyEvent(ref, { type: 'record_input', ...fence(state, this.now()), cursor })
    if (!result.ok) return result
    entry.version = result.state.task.version
    entry.cursor = cursor
    entry.report = undefined
    entry.issue = undefined
    try {
      worker.steer(decoded.data)
      void this.observe(entry, worker, decoded.data)
    } catch {
      entry.issue = 'host_unavailable'
      return { ok: false, code: 'host_unavailable' }
    }
    return result
  }

  /** Acknowledge the durable stop immediately. Native teardown remains tracked. */
  cancel(command: unknown, context: StoredCommandContext): StoredWorkResult {
    if (typeof command !== 'object' || command === null || !('type' in command) || command.type !== 'work.cancel') {
      return { ok: false, code: 'invalid_command' }
    }
    const result = this.options.store.applyCommand(command, context)
    if (result.ok) {
      const { task, attempt } = result.state
      const ref = { ownerId: task.ownerId, profileId: task.profileId, taskId: task.id }
      const entry = this.entryFor(ref)
      if (task.status === 'cancelling') {
        if (entry?.attemptId === attempt.id) void this.retire(entry)
        else if (!entry && attempt.worker?.releasedAt !== undefined) {
          // A clean pause or wait already proved release. Absence alone is
          // insufficient after a crash or an interrupted opening.
          const { store } = this.options
          const current = store.getWork(ref)
          if (current?.task.status === 'cancelling' && current.attempt.id === attempt.id
            && current.attempt.worker?.releasedAt !== undefined) {
            store.applyEvent(ref, { type: 'confirm_cancel', ...fence(current, this.now()),
              runtimeQuiescent: true, uncertainEffects: store.hasUnsettledEffects(ref, attempt.id) })
          }
        }
      }
    }
    return result
  }

  /** Stop new work for this attempt, then retain its slot until native teardown settles. */
  pause(command: unknown, context: StoredCommandContext): StoredWorkResult {
    if (typeof command !== 'object' || command === null || !('type' in command) || command.type !== 'work.pause'
      || !('taskId' in command)) return { ok: false, code: 'invalid_command' }
    const actor = context.actor
    if (actor?.role !== 'owner') return { ok: false, code: 'permission_denied' }
    const taskId = taskIdSchema.safeParse(command.taskId)
    if (!taskId.success) return { ok: false, code: 'invalid_command' }
    const ref = { ownerId: actor.ownerId, profileId: actor.profileId, taskId: taskId.data }
    const current = this.options.store.getWork(ref)
    const entry = this.entryFor(ref)
    if (current?.task.status === 'running' && !entry?.native) return { ok: false, code: 'runtime_not_quiescent' }
    if (current?.task.status !== 'queued' && current?.task.status !== 'running' && current?.task.status !== 'paused') {
      return { ok: false, code: current ? 'invalid_transition' : 'not_found' }
    }
    const result = this.options.store.applyCommand(command, context)
    if (result.ok && !result.replayed && entry?.attemptId === result.state.attempt.id) void this.retire(entry)
    return result
  }

  async waitForRelease(ref: WorkRef): Promise<boolean> {
    const entry = this.entryFor(ref)
    return entry === undefined || (entry.retiring && await this.retire(entry))
  }

  /** Close native work. Durable recovery handles any work still marked running. */
  async close(): Promise<boolean> {
    this.closed = true
    const results = await Promise.all([...this.entries.values()].map(entry => this.retire(entry)))
    const released = results.every(Boolean)
    if (released && executors.get(this.options.store) === this) executors.delete(this.options.store)
    return released
  }

  private entryFor(ref: WorkRef): Entry | undefined {
    const entry = this.entries.get(ref.taskId)
    return entry?.ref.ownerId === ref.ownerId && entry.ref.profileId === ref.profileId ? entry : undefined
  }

  private current(entry: Entry): WorkState | undefined {
    if (this.closed || entry.retiring) return undefined
    const state = this.options.store.getWork(entry.ref)
    return state?.task.status === 'running' && state.task.version === entry.version
      && state.task.generation === entry.generation && state.attempt.id === entry.attemptId ? state : undefined
  }

  private async observe(entry: Entry, worker: NativeWorker, input: WorkerInput): Promise<void> {
    try {
      await worker.flush()
      await worker.whenIdle()
      if (entry.cursor !== input.cursor) return
      if (!this.current(entry)) {
        void this.retire(entry)
        return
      }
      await worker.flush()
      const state = this.current(entry)
      if (entry.cursor !== input.cursor) return
      if (!state) {
        void this.retire(entry)
        return
      }
      const text = worker.readReport()
      const report = text === undefined ? undefined : decodeWorkerReport(text)
      if (!report || report.cursor !== input.cursor) {
        entry.issue = 'report_unavailable'
        return
      }
      if (report.kind === 'progress') {
        entry.report = report
        return
      }
      if (report.kind === 'failed') {
        entry.failure = report.summary
      } else {
        const base = fence(state, this.now())
        let result: StoredWorkResult
        if (report.kind === 'ready') {
          let artifactIds = report.artifactIds
          if (artifactIds.length === 0 && this.options.captureResultSummary) {
            const key = JSON.stringify([state.task.id, state.attempt.id, report.cursor])
            const id = artifactIdSchema.parse(`summary-${createHash('sha256').update(key).digest('hex')}`)
            this.options.store.artifacts.seal(entry.ref, {
              id, attemptId: state.attempt.id, generation: state.attempt.generation,
              expectedVersion: state.task.version,
              mediaType: 'text/markdown',
              sourceEventIds: state.task.provenance.sourceEventIds,
              visibility: 'private',
              bytes: new TextEncoder().encode(report.summary),
            })
            artifactIds = [id]
          }
          result = this.options.store.applyEvent(entry.ref, { type: 'ready', ...base, artifactIds })
        } else {
          const chain = report.kind === 'blocked' ? this.dependencyChain(entry.ref, report.wait.referenceId) : undefined
          if (report.kind === 'blocked' && !chain) {
            entry.issue = 'invalid_dependency'
            return
          }
          result = this.options.store.applyEvent(entry.ref, {
            type: 'wait', ...base, wait: report.wait, ...(chain === undefined ? {} : { dependencyChain: chain }),
          })
        }
        if (!result.ok) {
          entry.issue = result.code
          return
        }
      }
      entry.report = report
      void this.retire(entry)
    } catch {
      if (!entry.retiring && entry.cursor === input.cursor) entry.issue = 'host_unavailable'
    }
  }

  private dependencyChain(ref: WorkRef, predecessor: string): WorkRef['taskId'][] | undefined {
    const chain: WorkRef['taskId'][] = []
    let candidate: string | undefined = predecessor
    while (candidate !== undefined) {
      const id = taskIdSchema.safeParse(candidate)
      if (!id.success || id.data === ref.taskId || chain.includes(id.data) || chain.length >= MAX_DEPENDENCY_CHAIN) return undefined
      const state = this.options.store.getWork({ ...ref, taskId: id.data })
      if (!state || (chain.length === 0 && state.task.status === 'completed')) return undefined
      chain.push(id.data)
      candidate = state.task.wait?.reason === 'dependency' ? state.task.wait.referenceId : undefined
    }
    return chain
  }

  private retire(entry: Entry): Promise<boolean> {
    if (entry.cleanup) return entry.cleanup
    entry.retiring = true
    entry.cleanup = Promise.resolve().then(() => this.finish(entry)).catch(() => {
      entry.issue = 'quiescence_unverified'
      return false
    }).finally(() => {
      entry.cleanup = undefined
    })
    entry.abort.abort()
    return entry.cleanup
  }

  private async finish(entry: Entry): Promise<boolean> {
    const worker = await drainOpening(entry.opening)
    if (worker === openingPending || (worker && !await worker.stop())) {
      entry.issue = 'quiescence_unverified'
      return false
    }
    const { store } = this.options
    const state = store.getWork(entry.ref)
    if (state?.attempt.id === entry.attemptId) {
      const base = fence(state, this.now())
      const uncertainEffects = () => store.hasUnsettledEffects(entry.ref, entry.attemptId)
      const event: WorkEvent | undefined = state.task.status === 'cancelling'
        ? { type: 'confirm_cancel', ...base, runtimeQuiescent: true, uncertainEffects: uncertainEffects() }
        : entry.failure !== undefined && state.task.status === 'running' && state.task.generation === entry.generation
          ? { type: 'fail', ...base, runtimeQuiescent: true, uncertainEffects: uncertainEffects(), reason: entry.failure }
          : worker && (state.task.status === 'verifying' || state.task.status === 'paused' || state.attempt.status === 'waiting')
            && state.attempt.worker && state.attempt.worker.releasedAt === undefined
            ? { type: 'release_worker', ...base }
            : undefined
      if (event) {
        let result: StoredWorkResult
        if (event.type === 'release_worker') {
          const proof = Object.freeze({})
          releaseProofs.set(proof, { store, ref: entry.ref, event })
          result = store.confirmWorkerRelease(proof)
        } else {
          result = store.applyEvent(entry.ref, event)
        }
        if (!result.ok) {
          entry.issue = result.code
          return false
        }
      }
    }
    if (this.entries.get(entry.ref.taskId) === entry) this.entries.delete(entry.ref.taskId)
    return true
  }
}

const executors = new WeakMap<WorkStore, WorkerExecutor>()

export function createWorkerExecutor(options: WorkerExecutorOptions): WorkerExecutor {
  if (executors.has(options.store)) throw new Error('A worker executor is already open for this store')
  const executor = new WorkerExecutor(options)
  executors.set(options.store, executor)
  return executor
}

export type { WorkerExecutor }
