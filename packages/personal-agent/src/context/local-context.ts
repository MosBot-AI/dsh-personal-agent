import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import { z } from 'zod'
import { isPrivateWorkSessionId, nonEmptyTextSchema, sessionIdSchema, utcInstantSchema, type SourceEventId, type UtcInstant } from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import type { IdentityBoundary, OwnerIdentity } from '../policy/identity.js'
import type { NativeCheckpointCapture, NativeCheckpointPolicy } from '../runtime/checkpoint-compaction.js'
import { workerReportInstructions } from '../runtime/reports.js'
import type { WorkRef, WorkStore } from '../storage/store.js'
import { assembleContext, contextSections, type ContextAssemblyResult } from './assembler.js'
import type { ContextCheckpoint } from './checkpoint.js'
import { createRecall, type RecallEvidence } from './recall.js'
import { contextSourceLabels, localInboxSource } from './source-authority.js'

const weight = z.int().min(0).max(100)
const maxModelInputBytes = 64 * 1024
const routeResolutionMs = 3_000
const ownerDecisionSchema = z.object({ kind: z.literal('inbox-answer'), referenceId: nonEmptyTextSchema.max(4096),
  text: nonEmptyTextSchema.max(8192) })

export const localContextConfigSchema = z.strictObject({
  maxInputBytes: z.int().min(1024).max(maxModelInputBytes).default(32 * 1024),
  weights: z.strictObject({ authoritative: weight, recent: weight, retrieval: weight, checkpoint: weight })
    .refine(weights => contextSections.reduce((sum, section) => sum + weights[section], 0) === 100).optional(),
})

type WorkerRoute = { provider: string; model: string; dataScope: readonly string[]; outputReserve: number; maxInputBytes: number }
type CurrentInput = { text: string; sources?: readonly SourceEventId[] }
type Prepared = ContextAssemblyResult | { ok: false; code: 'permission_denied' | 'version_conflict' | 'context_budget_unavailable' }

function now(): UtcInstant { return utcInstantSchema.parse(new Date().toISOString()) }

export function isManagedWorkerSession(id: string): boolean { return isPrivateWorkSessionId(id) }

function authorityFields({ task }: WorkState) {
  return { taskId: task.id, version: task.version, objective: task.requestedOutcome, constraints: task.constraints,
    acceptance: task.acceptance, ...(task.wait ? { wait: task.wait } : {}) }
}

function sameWork(current: WorkState | undefined, captured: WorkState): boolean {
  return current?.task.id === captured.task.id && current.task.version === captured.task.version
    && current.attempt.id === captured.attempt.id && current.attempt.generation === captured.attempt.generation
}

export function createLocalContext(options: {
  readonly ctx: Context
  readonly store: WorkStore
  readonly identity: IdentityBoundary
  readonly ownerToken: unknown
  readonly owner: OwnerIdentity
  readonly config: z.infer<typeof localContextConfigSchema>
  readonly worker?: WorkerRoute
}) {
  const { ctx, store, identity, ownerToken, owner, config, worker } = options
  const scope = { ownerId: owner.ownerId, profileId: owner.profileId }
  let resolvedWindow: number | undefined

  function permitsTask(authority: unknown, state: WorkState): boolean {
    const live = identity.resolveOwner(authority)
    return live?.ownerId === state.task.ownerId && live.profileId === state.task.profileId
      && live.policyVersion === state.attempt.mandate.policyVersion
  }

  function authorize(authority: unknown, evidence: RecallEvidence): boolean {
    return permitsTask(authority, evidence.state) && (evidence.kind !== 'event' || contextSourceLabels(store, identity, evidence.event) !== undefined)
  }

  const recall = createRecall({ store, authorize })

  function sourceUsable(ref: WorkRef, id: SourceEventId, at = now()): boolean {
    const event = store.getContextSource(ref, id, at)
    const labels = event && contextSourceLabels(store, identity, event)
    const scope = store.getWork(ref)?.attempt.scope?.dataScope ?? worker?.dataScope
    return labels?.every(label => worker?.dataScope.includes(label) && scope?.includes(label)) === true
  }

  function historyUsable(ref: WorkRef, state: WorkState): boolean {
    if (!permitsTask(ownerToken, state)) return false
    const ids = store.workerContextSources(ref, state.attempt.id)
    const at = now()
    return ids !== undefined && ids.every(id => sourceUsable(ref, id, at))
  }

  function taskTextUsable(ref: WorkRef, state: WorkState, at = now()): boolean {
    const ids = state.task.provenance.sourceEventIds
    return ids.length <= 64 && ids.every(id => sourceUsable(ref, id, at))
  }

  function checkpointDecisions(ref: WorkRef, prior: ContextCheckpoint | undefined, at: UtcInstant) {
    const recent = store.listContextPointers(ref, { kind: 'event', limit: 12, at }).items
    const candidates = [...recent, ...(prior?.decisions.flatMap(decision => decision.sources) ?? [])]
    const decisions = new Map<string, ContextCheckpoint['decisions'][number]>()
    for (const pointer of candidates) {
      if (pointer.kind !== 'event') continue
      const event = store.getContextSource(ref, pointer.eventId, at)
      if (event?.sourceInstanceId !== localInboxSource || contextSourceLabels(store, identity, event) === undefined) continue
      const answer = ownerDecisionSchema.safeParse(event.body)
      if (!answer.success || decisions.has(answer.data.referenceId)) continue
      decisions.set(answer.data.referenceId, { text: answer.data.text, sources: [pointer] })
      if (decisions.size === 24) break
    }
    return [...decisions.values()]
  }

  const checkpointPolicy: NativeCheckpointPolicy = {
    capture(session: Session, operation: 'compact' | 'prune'): NativeCheckpointCapture {
      const id = sessionIdSchema.parse(session.id)
      const bound = () => store.listContextBindings(scope, id)
      const states = bound()
      if (states.length === 0) {
        if (isManagedWorkerSession(id)) return { kind: 'unavailable' }
        return { kind: 'unmanaged', isCurrent: () => bound().length === 0 }
      }
      if (!store.canDispatch() || states.some(state => !permitsTask(ownerToken, state))) return { kind: 'unavailable' }
      const at = now()
      const nativeSeq = session.seq
      const checkpoints: ContextCheckpoint[] = []
      for (const state of states) {
        const ref = { ...scope, taskId: state.task.id }
        const decisions = checkpointDecisions(ref, store.getLatestContextCheckpoint(ref, id, at), at)
        const selection = createHash('sha256').update(JSON.stringify(decisions)).digest('hex')
        const captured = store.captureContextCheckpoint(ref, {
          sessionId: id, compactionId: `${operation}-${nativeSeq}-${state.task.version}-${selection}`,
          attemptId: state.attempt.id, generation: state.attempt.generation,
          expectedVersion: state.task.version, at, nativeSeq, decisions,
        })
        if (!captured.ok) return { kind: 'unavailable' }
        checkpoints.push(captured.checkpoint)
      }
      const exactWorker = states.length === 1 && states[0]?.attempt.sessionId === id
      const summary = exactWorker ? `dshpa saved checkpoint ${checkpoints[0]!.id}. Use the current task instructions.`
        : 'dshpa saved scoped task checkpoints. Current task details carry the active instructions.'
      return { kind: 'managed', summary, isCurrent: () => {
        if (!store.canDispatch() || states.some(state => !permitsTask(ownerToken, state))) return false
        const live = bound()
        return live.length === states.length && states.every((state, index) => sameWork(live[index], state))
      } }
    },
  }

  function latest(ref: WorkRef, state: WorkState): ContextCheckpoint | undefined {
    const conversation = state.task.conversationId && store.getConversation(scope, state.task.conversationId)
    const sessions = [state.attempt.sessionId, ...(conversation ? conversation.sessionIds : [])]
    let result: ContextCheckpoint | undefined
    for (const sessionId of new Set(sessions)) {
      if (!sessionId) continue
      const record = store.getLatestContextCheckpoint(ref, sessionId)
      if (record && (!result || record.createdAt > result.createdAt)) result = record
    }
    return result
  }

  async function resolveRoute(): Promise<boolean> {
    const llm = ctx.get('llm')
    if (!worker || !llm) return false
    try {
      const model = await llm.resolveModelInfo(worker.provider, worker.model, AbortSignal.timeout(routeResolutionMs))
      resolvedWindow = model.context?.contextWindow
    } catch { return false }
    return resolvedWindow !== undefined
  }

  function prepareCurrent(ref: WorkRef, authority: unknown, state: WorkState, cursor: string, input: CurrentInput): Prepared {
    if (!permitsTask(authority, state)) return { ok: false, code: 'permission_denied' }
    if (!sameWork(store.getWork(ref), state)) return { ok: false, code: 'version_conflict' }
    const meter = ctx.get('tokenMeter')
    if (!worker || !meter || resolvedWindow === undefined) return { ok: false, code: 'context_budget_unavailable' }
    const at = now()
    const checkpoint = latest(ref, state)
    const current = checkpoint?.taskVersion === state.task.version ? checkpoint : undefined
    const pointers = store.listContextPointers(ref, { kind: 'event', limit: 4, at }).items.flatMap(pointer => {
      if (pointer.kind !== 'event' || !sourceUsable(ref, pointer.eventId, at)) return []
      return [{ text: JSON.stringify(pointer), sourceEventIds: [pointer.eventId] }]
    })
    const taskPointer = JSON.stringify({ kind: 'task', taskId: ref.taskId })
    const usable = taskTextUsable(ref, state, at)
    const decisions = checkpoint ? checkpointDecisions(ref, checkpoint, at) : []
    const decisionEntries = decisions.flatMap(decision => {
      const pointer = decision.sources[0]
      if (pointer?.kind !== 'event' || !sourceUsable(ref, pointer.eventId, at)) return []
      return [{ text: decision.text, pointer: JSON.stringify(pointer), sourceEventIds: [pointer.eventId] }]
    })
    const result = assembleContext({
      fixedInstructions: workerReportInstructions(cursor), currentInstructions: input.text, contextWindow: resolvedWindow,
      outputReserve: worker.outputReserve, maxInputBytes: Math.min(worker.maxInputBytes, config.maxInputBytes), weights: config.weights,
      estimateTokens: content => meter.estimateMessage({ id: MessageId('dshpa-context-measurement'), role: 'user',
        content: [{ type: 'text', text: content }], source: { kind: 'dshpa-work-input', cursor } }),
      sections: {
        authoritative: [{ text: usable ? JSON.stringify(authorityFields(state)) : taskPointer, pointer: taskPointer,
          sourceEventIds: usable ? state.task.provenance.sourceEventIds : undefined }],
        recent: current ? [{ text: JSON.stringify({ lastCheckpointAt: current.createdAt, taskVersion: current.taskVersion }) }] : [],
        retrieval: pointers,
        checkpoint: checkpoint ? [
          ...(current ? [{ text: JSON.stringify({ checkpointId: current.id, revision: current.revision }) }] : []),
          ...decisionEntries,
        ] : [],
      },
    })
    return result.ok ? { ...result, sources: [...new Set([...(input.sources ?? []), ...result.sources])] } : result
  }

  return Object.freeze({
    checkpointPolicy,
    managesSession(id: string): boolean {
      return isManagedWorkerSession(id) || store.listContextBindings(scope, sessionIdSchema.parse(id)).length > 0
    },
    recall,
    sourceUsable,
    taskTextUsable,
    resolveRoute,
    historyUsable,
    contextWindow: () => resolvedWindow,
    inspect(ref: WorkRef, authority: unknown) {
      const state = store.getWork(ref)
      if (!state) return { ok: false, code: 'not_found' } as const
      if (!permitsTask(authority, state)) return { ok: false, code: 'permission_denied' } as const
      const checkpoint = latest(ref, state)
      return { ok: true, value: checkpoint ? { id: checkpoint.id, revision: checkpoint.revision,
        taskVersion: checkpoint.taskVersion, createdAt: checkpoint.createdAt, current: checkpoint.taskVersion === state.task.version } : null } as const
    },
    async prepare(ref: WorkRef, authority: unknown, state: WorkState, cursor: string, currentInput: () => CurrentInput | undefined):
    Promise<Prepared | { ok: false; code: 'source_unavailable' }> {
      if (!permitsTask(authority, state)) return { ok: false, code: 'permission_denied' }
      if (!await resolveRoute()) return { ok: false, code: 'context_budget_unavailable' }
      const input = currentInput()
      return input === undefined ? { ok: false, code: 'source_unavailable' } : prepareCurrent(ref, authority, state, cursor, input)
    },
    prepareCached: (ref: WorkRef, state: WorkState, cursor: string, text: string) => prepareCurrent(ref, ownerToken, state, cursor, { text }),
  })
}

export type LocalContext = ReturnType<typeof createLocalContext>
