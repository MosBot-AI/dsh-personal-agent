import { z } from 'zod'
import {
  accountIdSchema, nonEmptyTextSchema, projectIdSchema, sourceEventIdSchema, sourceInstanceIdSchema,
  taskIdSchema, utcInstantSchema, versionSchema, type SourceEvent, type UtcInstant,
} from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import type { IdentityBoundary } from '../policy/identity.js'
import type { WorkRef, WorkStore } from '../storage/store.js'
import type { ExecutorResult, WorkerExecutor } from './executor.js'
import { authenticateEvent, currentRoutingBody, type RoutingBody } from './intake.js'
import { createRoutingQueue } from './routing-queue.js'
import type { RoutingDisposition, RoutingDispositionUpdate, RoutingEventRef, RoutingReceipt, Subscription } from './subscriptions.js'

const scopeText = nonEmptyTextSchema.max(512)
const manageSubscriptionSchema = z.strictObject({
  sourceInstanceId: sourceInstanceIdSchema.max(512), accountId: accountIdSchema.max(512), threadId: scopeText,
  projectId: projectIdSchema.max(512), taskId: taskIdSchema.max(512), mode: z.enum(['context', 'work']),
  enabled: z.boolean(), expectedVersion: versionSchema.optional(), expiresAt: utcInstantSchema.optional(),
})
const decisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: sourceEventIdSchema, kind: z.literal('ignore') }),
  z.strictObject({ id: sourceEventIdSchema, kind: z.enum(['clarify', 'propose_task']), summary: nonEmptyTextSchema.max(1_024) }),
])

export interface AssessmentCandidate {
  readonly id: SourceEvent['id']
  readonly text: string
  readonly kind: 'candidate' | 'handback'
}

export type RoutingAssessor = (batch: readonly AssessmentCandidate[], signal: AbortSignal) => Promise<unknown>

interface RoutingOptions {
  readonly store: WorkStore
  readonly identity: IdentityBoundary
  readonly executor?: WorkerExecutor
  readonly assess?: RoutingAssessor
  readonly assessmentDataScope?: readonly string[]
  readonly authorizeDelivery?: (state: WorkState, event: SourceEvent) => boolean
  readonly authorizeWake?: (state: WorkState, event: SourceEvent) => boolean
  readonly now?: () => UtcInstant
  readonly maxEventAgeMs?: number
  readonly maxOutstanding?: number
  readonly maxPerLane?: number
  readonly maxBatchSize?: number
  readonly deadlineMs?: number
}

type PendingAssessment = { ref: RoutingEventRef; version: number; candidate: AssessmentCandidate }
type Decision = Extract<RoutingDisposition, { kind: 'assessed' }>['decision']
type RoutedEvent = { event: SourceEvent; receipt: RoutingReceipt }
const activeRouters = new WeakMap<WorkStore, () => boolean>()

function refFor(event: SourceEvent): RoutingEventRef {
  return { ownerId: event.ownerId, profileId: event.profileId, eventId: event.id }
}

function response(receipt: RoutingReceipt, duplicate: boolean) {
  const { disposition: current } = receipt
  const disposition = current.kind === 'routed' && receipt.delivery
    ? { kind: current.kind, inputStatus: receipt.delivery.inputStatus } as const
    : current.kind === 'handback' || current.kind === 'context' ? { kind: current.kind } as const : current
  return { ok: true, duplicate, eventId: receipt.eventId, disposition } as const
}

/** A malformed or repeated model decision can invalidate only its own candidate. */
function readDecisions(input: unknown, candidates: readonly AssessmentCandidate[]): Map<string, Decision> {
  const decisions = new Map<string, Decision>()
  if (!Array.isArray(input) || input.length > candidates.length * 2) return decisions
  const expected = new Set<string>(candidates.map(candidate => candidate.id))
  const seen = new Set<string>()
  for (const item of input) {
    if (typeof item !== 'object' || item === null || typeof item.id !== 'string' || !expected.has(item.id)) continue
    if (seen.has(item.id)) {
      decisions.delete(item.id)
      continue
    }
    seen.add(item.id)
    const parsed = decisionSchema.safeParse(item)
    if (!parsed.success) continue
    const { id, ...decision } = parsed.data
    decisions.set(id, decision)
  }
  return decisions
}

/** Exact routes and foreground controls never join the semantic assessment queue. */
export function createRouter(options: RoutingOptions) {
  const { store, identity, executor } = options
  if (activeRouters.get(store)?.()) throw new Error('A Router is still active for this store')
  const now = options.now ?? (() => utcInstantSchema.parse(new Date().toISOString()))
  const maxAge = z.int().positive().parse(options.maxEventAgeMs ?? 86_400_000)
  const assessmentScope = new Set(options.assessmentDataScope ?? [])
  let closed = false

  function currentProject(event: SourceEvent, receipt: RoutingReceipt): boolean {
    return store.getProject(event, receipt.projectId)?.status === 'active'
  }

  function fresh(event: SourceEvent, at = now()): boolean {
    const age = Date.parse(at) - Date.parse(event.occurredAt)
    return age >= 0 && age <= maxAge
  }

  function currentAssessment({ ref, version }: PendingAssessment): boolean {
    const stored = store.getRoutingEvent(ref)
    return Boolean(!closed && stored && stored.receipt.version === version && stored.receipt.disposition.kind === 'queued'
      && store.canDispatch() && fresh(stored.event) && currentProject(stored.event, stored.receipt)
      && currentRoutingBody(identity, stored.event, stored.receipt.authority))
  }

  const assess = options.assess
  const queue = assess && createRoutingQueue<PendingAssessment, Decision | undefined>({
    maxOutstanding: options.maxOutstanding, maxPerLane: options.maxPerLane,
    maxBatchSize: options.maxBatchSize, deadlineMs: options.deadlineMs,
    async assess(batch, signal) {
      const candidates = batch.filter(currentAssessment).map(item => Object.freeze({ ...item.candidate }))
      if (candidates.length === 0) return batch.map(() => undefined)
      const decisions = readDecisions(await assess(candidates, signal), candidates)
      return batch.map(item => decisions.get(item.candidate.id))
    },
  })
  function settleInterrupted() {
    while (store.cancelUnfinishedRouting() > 0) { /* Classify persisted assessments in bounded transactions. */ }
  }
  settleInterrupted()
  activeRouters.set(store, () => !closed || (queue?.snapshot().inFlight ?? 0) > 0)

  function change(ref: RoutingEventRef, receipt: RoutingReceipt, disposition: RoutingDispositionUpdate) {
    return store.setRoutingDisposition(ref, receipt.version, disposition)
  }

  function reject(ref: RoutingEventRef, receipt: RoutingReceipt, reason: string) {
    change(ref, receipt, { kind: 'rejected', reason })
  }

  function enqueue({ event, receipt }: RoutedEvent, body: RoutingBody, kind: AssessmentCandidate['kind']) {
    const ref = refFor(event)
    if (!queue) return reject(ref, receipt, 'assessment_disabled')
    if (!body.dataScope.every(label => assessmentScope.has(label))) return reject(ref, receipt, 'disclosure_denied')
    const updated = change(ref, receipt, { kind: 'queued' })
    if (!updated.ok) return
    const { version } = updated.receipt
    const pending = { ref, version, candidate: { id: event.id, text: body.text, kind } }
    const group = [event.ownerId, event.profileId, body.projectId, event.sourceInstanceId, event.actor.accountId]
    const lane = JSON.stringify([...group, event.threadId])
    const batch = JSON.stringify([...group, body.dataScope])
    const admitted = queue.enqueue(lane, pending, batch)
    if (!admitted.ok) {
      store.setRoutingDisposition(ref, version, { kind: 'rejected', reason: admitted.code })
      return
    }
    void admitted.completion.then(outcome => {
      if (closed) return
      const disposition = outcome.ok && outcome.value && currentAssessment(pending)
        ? { kind: 'assessed', decision: outcome.value } as const
        : { kind: 'rejected', reason: outcome.ok ? 'no_current_decision' : outcome.code } as const
      store.setRoutingDisposition(ref, version, disposition)
    }).catch(() => { /* Persisted queued state is visible and is classified on restart. */ })
  }

  function routeToWork(stored: RoutedEvent, body: RoutingBody, subscription: Subscription) {
    const { event, receipt } = stored
    const ref = refFor(event)
    const workRef: WorkRef = { ownerId: event.ownerId, profileId: event.profileId, taskId: subscription.taskId }
    const state = store.getWork(workRef)
    const since = state?.task.status === 'running' ? state.attempt.startedAt : state?.task.updatedAt
    if (!executor || !state || state.task.projectId !== body.projectId
      || state.attempt.mandate.policyVersion !== receipt.authority.policyVersion
      || since === undefined || event.occurredAt < since || (body.target !== undefined
        && (body.target.expectedVersion !== state.task.version || body.target.generation !== state.task.generation))) {
      return reject(ref, receipt, 'target_unavailable')
    }

    const input = {
      expectedVersion: state.task.version, generation: state.task.generation, dataScope: body.dataScope,
      input: { cursor: event.id, text: body.text },
      route: {
        eventId: event.id, expectedReceiptVersion: receipt.version, projectId: body.projectId,
        subscriptionVersion: subscription.version, authority: receipt.authority, mode: 'work' as const,
      },
    }
    function authorize() {
      if (closed || !store.canDispatch() || !fresh(event) || !currentProject(event, receipt)
        || !currentRoutingBody(identity, event, receipt.authority)) return false
      const { ownerId, profileId, sourceInstanceId, accountId, threadId, taskId } = subscription
      const current = store.getSubscription({ ownerId, profileId, sourceInstanceId, accountId, threadId, taskId })
      return current?.enabled === true && current.version === subscription.version
        && (current.expiresAt === undefined || now() < current.expiresAt)
    }
    function settle(result: ExecutorResult) {
      if (!result.ok && !closed) reject(ref, receipt, result.code)
    }

    if (state.task.status === 'running' && body.waitReference === undefined) {
      settle(executor.deliverSubscribed(workRef, input, () => authorize() && options.authorizeDelivery?.(state, event) === true))
      return
    }
    if (state.task.status === 'waiting_event' && body.waitReference === state.task.wait?.referenceId
      && body.waitReference !== undefined && options.authorizeWake) {
      const allowed = () => authorize() && options.authorizeWake?.(state, event) === true
      void executor.wakeSubscribed(workRef, { ...input, referenceId: body.waitReference,
        grantsCurrent: true, budgetAvailable: true, conditionSatisfied: true }, allowed).then(settle, () => {
        if (!closed) reject(ref, receipt, 'host_unavailable')
      })
      return
    }
    reject(ref, receipt, 'target_unavailable')
  }

  function route(stored: RoutedEvent, body: RoutingBody, at: UtcInstant) {
    const { event, receipt } = stored
    const ref = refFor(event)
    const accountId = event.actor.accountId
    const threadId = event.threadId
    if (!accountId || !threadId || !currentProject(event, receipt)) return reject(ref, receipt, 'scope_unavailable')
    if (!fresh(event, at)) return reject(ref, receipt, 'stale_event')
    const scope = { ownerId: ref.ownerId, profileId: ref.profileId, sourceInstanceId: event.sourceInstanceId, accountId, threadId }
    const target = body.target
    if (target !== undefined) {
      const state = store.getWork({ ownerId: scope.ownerId, profileId: scope.profileId, taskId: target.taskId })
      if (state?.task.projectId !== body.projectId || state.task.version !== target.expectedVersion
        || state.task.generation !== target.generation) return reject(ref, receipt, 'target_unavailable')
    }
    const subscriptions = store.listSubscriptions(scope, body.projectId, at)
      .filter(subscription => subscription.authority.policyVersion === receipt.authority.policyVersion
        && subscription.authority.verifiedAt === receipt.authority.verifiedAt)
    const scoped = target === undefined ? subscriptions : subscriptions.filter(item => item.taskId === target.taskId)
    const matching = scoped.filter(subscription => event.occurredAt >= subscription.updatedAt)
    const work = matching.filter(subscription => subscription.mode === 'work')
    if (work.length > 1) {
      change(ref, receipt, { kind: 'assessed', decision: { kind: 'clarify', summary: 'More than one task subscribes to this thread. Specify the task.' } })
      return
    }
    if (work[0]) return routeToWork(stored, body, work[0])
    const context = matching.filter(subscription => subscription.mode === 'context')
    if (context.length > 0) {
      change(ref, receipt, { kind: 'context', taskIds: context.map(subscription => subscription.taskId) })
      return
    }
    if (body.target !== undefined || body.waitReference !== undefined || scoped.length > 0 || body.kind !== 'candidate') {
      return reject(ref, receipt, 'target_unavailable')
    }
    enqueue(stored, body, 'candidate')
  }

  return Object.freeze({
    /** Persist first and acknowledge intake without waiting on a model or native Worker. */
    receive(sourceToken: unknown, input: unknown) {
      if (closed) return { ok: false, code: 'closed' } as const
      const at = now()
      const admitted = authenticateEvent(identity, sourceToken, input, at)
      if (!admitted.ok) return admitted
      if (!store.canDispatch()) return { ok: false, code: 'recovery_required' } as const
      const { event, body, digest, authority } = admitted
      const result = store.recordRoutingEvent(event, digest, { projectId: body.projectId, authority })
      if (!result.ok) return result
      if (result.duplicate) {
        const stored = store.getRoutingEvent(refFor(event))
        return stored && currentRoutingBody(identity, stored.event, stored.receipt.authority)
          ? response(result.receipt, true) : { ok: false, code: 'source_duplicate' } as const
      }
      route({ event, receipt: result.receipt }, body, at)
      return response(store.getRoutingEvent(refFor(event))?.receipt ?? result.receipt, false)
    },
    status(sourceToken: unknown, rawEventId: unknown) {
      if (closed) return undefined
      const source = identity.resolveSource(sourceToken)
      const parsed = sourceEventIdSchema.safeParse(rawEventId)
      if (!source || !parsed.success) return undefined
      const stored = store.getRoutingEvent({ ownerId: source.ownerId, profileId: source.profileId, eventId: parsed.data })
      if (!stored || stored.event.sourceInstanceId !== source.sourceInstanceId || stored.event.actor.accountId !== source.accountId
        || !currentRoutingBody(identity, stored.event, stored.receipt.authority)) return undefined
      return response(stored.receipt, false)
    },
    setSubscription(ownerToken: unknown, input: unknown) {
      if (closed) return { ok: false, code: 'closed' } as const
      const owner = identity.resolveOwner(ownerToken)
      if (!owner) return { ok: false, code: 'permission_denied' } as const
      const parsed = manageSubscriptionSchema.safeParse(input)
      if (!parsed.success) return { ok: false, code: 'invalid_input' } as const
      if (!store.canDispatch()) return { ok: false, code: 'recovery_required' } as const
      const { expectedVersion, ...subscription } = parsed.data
      const profile = identity.currentProfile(owner.profileId)
      const accounts = profile?.verifiedAccounts.filter(account => account.sourceInstanceId === subscription.sourceInstanceId
        && account.accountId === subscription.accountId)
      if (accounts?.length !== 1 || !accounts[0]) return { ok: false, code: 'permission_denied' } as const
      return store.putSubscription({
        ...subscription, ownerId: owner.ownerId, profileId: owner.profileId, updatedAt: now(),
        authority: { policyVersion: owner.policyVersion, verifiedAt: accounts[0].verifiedAt },
      }, expectedVersion)
    },
    /** The executor calls this only after consuming the exact durable handback. */
    handback(ref: WorkRef, eventId: SourceEvent['id']) {
      if (closed) return
      const stored = store.getRoutingEvent({ ownerId: ref.ownerId, profileId: ref.profileId, eventId })
      if (!stored || stored.receipt.disposition.kind !== 'handback' || stored.receipt.delivery?.taskId !== ref.taskId) return
      const body = currentRoutingBody(identity, stored.event, stored.receipt.authority)
      if (!body || !store.canDispatch() || !fresh(stored.event) || !currentProject(stored.event, stored.receipt)) {
        return reject(refFor(stored.event), stored.receipt, 'handback_scope_unavailable')
      }
      enqueue(stored, body, 'handback')
    },
    snapshot: () => queue?.snapshot() ?? { queued: 0, inFlight: 0, closed },
    close() {
      if (closed) return
      closed = true
      queue?.close()
      settleInterrupted()
    },
  })
}

export type EventRouter = ReturnType<typeof createRouter>
