import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmError, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ModelDeployment, QuotaBucket, RoutingDecision } from '@mosbot-ai/dshpa-plugin-api/model-routing'
import { modelDeploymentSchema, quotaBucketSchema } from '@mosbot-ai/dshpa-plugin-api/model-routing'
import { nativeRoutingPlanSchema, prepareDshRouting } from '@mosbot-ai/dshpa-model-routing'
import { chooseFallback, classifyInferenceFailure, fallbackPolicySchema, type InferenceFailure } from '@mosbot-ai/dshpa-model-routing/fallback'
import { z } from 'zod'
import { inferenceExecutor, inferenceWaitPrefix, utcInstantSchema, versionSchema, type UtcInstant } from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import { createPrivateWorkers } from '../policy/private-worker.js'
import type { StoredInferenceAttempt } from '../storage/inference.js'
import type { WorkRef, WorkStore } from '../storage/store.js'
import type { BudgetService } from './budget.js'
import { computeLimitsSchema, conservativeRequestBounds } from './compute.js'

const routeSchema = z.strictObject({ deployment: modelDeploymentSchema, bucket: quotaBucketSchema })
const executionSchema = z.strictObject({
  initial: nativeRoutingPlanSchema,
  candidates: z.array(routeSchema).max(96),
  fallback: fallbackPolicySchema,
  expectedVersion: versionSchema,
  unattended: z.boolean(),
  gatewayRetries: z.literal(0).default(0),
  continuation: z.boolean().default(false),
})
type Execution = z.infer<typeof executionSchema>
type Dispatch = Extract<RoutingDecision, { kind: 'dispatch' }>
type Plan = Omit<z.infer<typeof nativeRoutingPlanSchema>, 'decision'> & { decision: Dispatch }
type Effects = NonNullable<ReturnType<WorkStore['confirmedInferenceEffects']>>
type Failure = InferenceFailure & { readonly nextCheckAt?: string }
type RunResult = { kind: 'completed'; text: string } | { kind: 'failed'; failure: Failure } | { kind: 'uncertain' }
type Result =
  | { readonly kind: 'completed'; readonly attemptId: string; readonly text?: string }
  | { readonly kind: 'waiting_resource'; readonly referenceId: string; readonly reason: string; readonly nextCheckAt?: string }
  | { readonly kind: 'stopped'; readonly reason: string }

export interface RoutedInferenceAuthority {
  /** Check live policy, account, credential binding, and disclosure grant for this exact destination. */
  authorize(ref: WorkRef, decision: Dispatch, deployment: ModelDeployment, bucket: QuotaBucket): boolean
  /** Supply newly authorized plain-text evidence for this inference stage, including permitted confirmed receipts. */
  assemble(ref: WorkRef, decision: Dispatch, effects: Effects, signal?: AbortSignal): Promise<string | undefined>
}

const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex')
const pin = ({ id, revision }: { id: string; revision: number }) => ({ id, revision })
const key = (value: { id: string; revision: number }) => JSON.stringify(pin(value))
const stop = (reason: string) => ({ kind: 'stopped', reason }) as const
const limits = computeLimitsSchema.parse({})

export function inferenceAcceptanceDigest(state: WorkState): string {
  return hash(state.task.acceptance)
}

function denied(code: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message: 'Routed inference could not be admitted.' } } }
}

function hasOutput(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'block-end'
}

function hasToolCall(chunk: StreamChunk): boolean {
  return chunk.type === 'tool-call-delta'
    || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
    || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')
}

/** Trusted, compute-only inference coordination for an existing business Task. */
export function createRoutedInferenceExecutor(ctx: Context, options: {
  readonly store: WorkStore
  readonly budget: BudgetService
  readonly authority: RoutedInferenceAuthority
  readonly flush: (session: Session) => Promise<void>
  readonly quota?: Parameters<WorkStore['createInferenceLedger']>[0]
  readonly now?: () => UtcInstant
}) {
  const { store, budget, authority, flush } = options
  const ledger = store.createInferenceLedger(options.quota, budget)
  const now = () => utcInstantSchema.parse(options.now?.() ?? new Date().toISOString())
  const active = new Set<string>()

  function permitted(ref: WorkRef, plan: Plan): boolean {
    try { return authority.authorize(ref, structuredClone(plan.decision), structuredClone(plan.deployment), structuredClone(plan.bucket)) === true }
    catch { return false }
  }

  function budgetRequest(ref: WorkRef, state: WorkState, plan: Plan, unattended: boolean) {
    const { requirements } = plan.decision
    return { ownerId: ref.ownerId, profileId: ref.profileId, provider: plan.deployment.provider, model: plan.deployment.model,
      task: { taskId: ref.taskId, attemptId: state.attempt.id, generation: state.attempt.generation, expectedVersion: state.task.version },
      unattended, upperInputTokens: requirements.inputTokens, upperOutputTokens: requirements.outputTokens }
  }

  function runFailure(error: unknown): Failure {
    return error instanceof LlmError ? classifyInferenceFailure(error.failure, Date.parse(now())) : { reason: 'unavailable' }
  }

  async function runOne(ref: WorkRef, state: WorkState, plan: Plan, input: Execution, outer?: AbortSignal): Promise<RunResult> {
    const timeout = AbortSignal.timeout(limits.maxWallTimeMs)
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout
    const interrupted = (): Failure => ({ reason: outer?.aborted ? 'cancelled' : timeout.aborted ? 'unavailable' : 'authorization' })
    const effects = store.confirmedInferenceEffects(ref)
    if (!effects) return { kind: 'failed', failure: { reason: 'authorization' } } as const
    const effectsDigest = hash(effects)
    const sameTask = () => {
      if (signal?.aborted) return false
      const live = store.getWork(ref)
      return live?.task.status === 'running' && live.task.version === state.task.version && live.attempt.id === state.attempt.id
        && live.task.generation === state.task.generation && inferenceAcceptanceDigest(live) === plan.decision.acceptanceDigest
        && permitted(ref, plan)
    }
    const current = () => sameTask() && !store.hasUnsettledEffects(ref, state.attempt.id)
      && hash(store.confirmedInferenceEffects(ref) ?? null) === effectsDigest
    if (!current()) return { kind: 'failed', failure: interrupted() }
    const text = await authority.assemble(ref, structuredClone(plan.decision), effects, signal)
    if (!text || !current()) return { kind: 'failed', failure: interrupted() }

    let failure: Failure = { reason: 'unavailable' }
    let completed = false
    let reconciled = true
    let dispatched = false
    let claimed = false
    const prepared = await prepareDshRouting(ctx, plan, {
      isCurrent: current,
      async *dispatch(_fence, request: GenerateOptions, next) {
        if (dispatched || !current()) { yield denied('ROUTING_DENIED'); return }
        dispatched = true
        const bounds = conservativeRequestBounds(request, limits)
        if (!bounds || bounds.upperInputTokens > plan.decision.requirements.inputTokens) {
          failure = { reason: 'context' }
          yield denied('CONTEXT_WINDOW_EXCEEDED')
          return
        }
        let claim
        try {
          claim = ledger.begin(ref, { ...plan, expectedVersion: state.task.version, unattended: input.unattended,
            maxAttempts: input.fallback.maxAttempts })
        } catch {
          reconciled = false
          yield denied('ROUTING_LEDGER_UNAVAILABLE')
          return
        }
        if (!claim.ok) {
          failure = claim.code === 'quota' && claim.quota
            ? { reason: claim.quota.reason === 'quota-unknown' ? 'quota' : claim.quota.reason, nextCheckAt: claim.quota.nextCheckAt }
            : claim.code === 'budget_exceeded' || claim.code === 'pricing_unavailable' || claim.code === 'capacity' ? { reason: 'budget' }
            : { reason: 'authorization' }
          yield denied('ROUTING_NOT_ADMITTED')
          return
        }
        claimed = true
        let usage: TokenUsage | undefined
        let partial = false
        let outputBytes = 0
        try {
          for await (const chunk of next()) {
            if (!sameTask()) {
              failure = interrupted()
              yield denied('ROUTING_DENIED')
              return
            }
            if (hasToolCall(chunk)) {
              failure = { reason: 'rejected' }
              yield denied('ROUTING_TOOL_DENIED')
              return
            }
            if (hasOutput(chunk)) {
              outputBytes += Buffer.byteLength(JSON.stringify(chunk))
              if (outputBytes > bounds.upperOutputTokens * 64 || (!partial && !ledger.partial(ref, plan.attempt.id))) {
                failure = { reason: 'rejected' }
                yield denied('ROUTING_OUTPUT_LIMIT')
                return
              }
              partial = true
            }
            if (chunk.type === 'usage') usage = chunk.usage
            if (chunk.type === 'finish') {
              if (chunk.reason.kind === 'stop') {
                completed = partial
                if (usage && (usage.outputTokens > bounds.upperOutputTokens || usage.inputTokens
                  + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > plan.decision.requirements.inputTokens)) {
                  completed = false
                  failure = { reason: 'budget' }
                  yield denied('ROUTING_USAGE_LIMIT')
                  return
                }
              } else if (chunk.reason.kind === 'error') failure = classifyInferenceFailure(chunk.reason.failure, Date.parse(now()))
              else failure = signal.aborted ? interrupted() : { reason: 'rejected' }
              yield chunk
              return
            }
            yield chunk
          }
          yield denied('ROUTING_STREAM_CLOSED')
        } catch (error) {
          failure = signal.aborted ? interrupted() : runFailure(error)
          yield denied('ROUTING_STREAM_INTERRUPTED')
        } finally {
          const reservation = claim.reservation
          if (!completed && signal.aborted) failure = interrupted()
          try {
            if (!(completed && usage && budget.settle(reservation, usage))) budget.uncertain(reservation)
          } catch { reconciled = false }
        }
      },
    }, signal)
    if (!prepared.ok && signal.aborted) return { kind: 'failed', failure: interrupted() }
    if (!prepared.ok) return { kind: 'failed', failure: { reason: prepared.code === 'permission_denied' ? 'authorization'
      : prepared.code === 'host_unavailable' ? 'unavailable' : 'rejected' } } as const

    const approved = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const approvedDigest = hash(approved.content)
    let inputConsumed = false
    let inputRejected = false
    const workers = createPrivateWorkers(ctx, (agentCtx, agent) => {
      const setup = prepared.options.setup(agentCtx, agent)
      agentCtx.on('agent/request-error', async () => undefined, { prepend: true })
      agentCtx.on('agent/pre-step', async ({ messages }, next) => {
        const [message] = messages
        if (inputConsumed || inputRejected || messages.length !== 1 || message?.id !== approved.id
          || hash(message.content) !== approvedDigest) {
          inputRejected = true
          failure = { reason: 'authorization' }
          return { kind: 'reject' }
        }
        const decision = await next()
        if (decision.kind === 'enter') inputConsumed = true
        return decision
      }, { prepend: true })
      return setup
    })
    let resultText: string | undefined
    let disposed = false
    let handle
    try { handle = await workers.create(prepared.options) }
    catch (error) {
      return { kind: 'failed', failure: signal.aborted ? interrupted() : runFailure(error) }
    }
    const cancel = () => handle.agent.cancel({ kind: 'hook', reason: 'Routed inference cancelled' })
    try {
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal.aborted || !current()) return { kind: 'failed', failure: interrupted() }
      handle.agent.followup(approved)
      await handle.agent.whenIdle()
      await flush(handle.agent.session)
      if (completed) {
        const result = handle.agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message' && !event.data.interrupted)
        if (result?.type === 'assistant/message') resultText = result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      }
    } catch (error) {
      if (!dispatched) failure = runFailure(error)
      reconciled = false
    } finally {
      signal?.removeEventListener('abort', cancel)
      try {
        await handle.dispose()
        const agents = ctx.get('agents')
        disposed = agents !== undefined && agents.get(handle.agent.id) !== handle.agent
      } catch { /* Hold the continuation when native teardown is unverified. */ }
    }
    if (completed && (!resultText || !current())) {
      completed = false
      failure = resultText ? interrupted() : { reason: 'rejected' }
    }
    if (!reconciled || !disposed || (claimed && !ledger.finish(ref, plan.attempt.id, completed ? undefined : failure))) {
      return { kind: 'uncertain' } as const
    }
    if (completed && resultText) return { kind: 'completed', text: resultText } as const
    return { kind: 'failed', failure } as const
  }

  function park(ref: WorkRef, state: WorkState, referenceId: string, reason: string, nextCheckAt?: string): Result {
    if (state.task.status === 'waiting_resource') return { kind: 'waiting_resource', referenceId, reason, nextCheckAt: state.task.wait?.notBefore }
    const at = now()
    const result = store.applyEvent(ref, { type: 'wait', at, expectedVersion: state.task.version,
      attemptId: state.attempt.id, generation: state.attempt.generation,
      wait: { reason: 'resource', referenceId,
        ...(nextCheckAt && nextCheckAt > at ? { notBefore: nextCheckAt } : {}),
        resumeCondition: 'Recheck the authorized inference routes and resume this exact stage.',
      } })
    return result.ok ? { kind: 'waiting_resource', referenceId, reason, nextCheckAt: result.state.task.wait?.notBefore } : stop(result.code)
  }

  async function execute(ref: WorkRef, input: Execution, signal?: AbortSignal): Promise<Result> {
    const { initial } = input
    if (initial.decision.kind !== 'dispatch') return stop('invalid_input')
    let state = store.getWork(ref)
    if (!state || state.task.version !== input.expectedVersion || state.attempt.executor !== inferenceExecutor
      || state.attempt.worker || initial.attempt.taskId !== ref.taskId || initial.attempt.taskAttemptId !== state.attempt.id
      || initial.attempt.generation !== state.task.generation || initial.decision.acceptanceDigest !== inferenceAcceptanceDigest(state)
      || store.hasUnsettledEffects(ref, state.attempt.id)) return stop('stale_attempt')
    const referenceId = inferenceWaitPrefix + hash([initial, input.candidates, input.fallback, input.unattended])
    const waiting = state.task.status === 'waiting_resource'
    if (waiting ? (!input.continuation || state.task.wait?.referenceId !== referenceId) : state.task.status !== 'running' || input.continuation) {
      return stop('invalid_transition')
    }
    let plan: Plan = { ...initial, decision: initial.decision }
    if (waiting && !permitted(ref, plan)) return stop('permission_denied')
    const candidates = new Map<string, z.infer<typeof routeSchema>>([[key(initial.deployment), { deployment: initial.deployment, bucket: initial.bucket }]])
    for (const route of input.candidates) {
      const prior = candidates.get(key(route.deployment))
      if (route.deployment.accountId !== route.bucket.accountId || route.deployment.quotaBucketId !== route.bucket.id
        || (prior && hash(prior) !== hash(route))) return stop('invalid_input')
      candidates.set(key(route.deployment), route)
    }

    function available(candidate: Plan) {
      if (!permitted(ref, candidate)) return { kind: 'wait' } as const
      const { requirements } = candidate.decision
      const quota = ledger.quota({ ownerId: ref.ownerId, profileId: ref.profileId }, candidate.bucket,
        requirements.inputTokens + requirements.outputTokens)
      if (quota.kind === 'wait') return { kind: 'wait', nextCheckAt: quota.nextCheckAt } as const
      const { provider, model } = candidate.deployment
      return budget.canBegin(budgetRequest(ref, state!, candidate, input.unattended))
        ? { kind: 'ready', incrementalCost: budget.incrementalCost(provider, model) } as const
        : { kind: 'wait' } as const
    }

    function withAttempt(route: z.infer<typeof routeSchema>, decision: Dispatch, previousId: string): Plan {
      return { ...plan, ...route, decision, attempt: {
        ...initial.attempt, id: randomUUID(), requestSeriesId: randomUUID(), previousAttemptId: previousId,
        decisionId: decision.id, deployment: pin(route.deployment), accountId: route.bucket.accountId,
        quotaBucketId: route.bucket.id, createdAt: now(),
        pricingRevision: route.deployment.pricing.kind === 'configured' ? route.deployment.pricing.revision : undefined,
      } }
    }

    function move(last: StoredInferenceAttempt, failure: Failure, allowRetry = false): Result | undefined {
      const previous = candidates.get(key({ id: last.deploymentId, revision: last.deploymentRevision }))
      if (!previous) return stop('authorization')
      const prior: Dispatch = { ...plan.decision, id: last.decisionId, deployment: pin(previous.deployment) }
      const decisionId = randomUUID()
      const selected = chooseFallback({ failure, prior, previous: previous.deployment,
        visited: ledger.history(ref, last.id).map(row => ({ id: row.deploymentId, revision: row.deploymentRevision })),
        policy: plan.policy, fallback: input.fallback, candidates: [...candidates.values()].map(route => route.deployment),
        decisionId, now: now(), inspect(deployment, priorDecision) {
          return available({ ...plan, ...candidates.get(key(deployment))!, decision: {
            ...priorDecision, id: decisionId, deployment: pin(deployment), basis: 'fallback',
          } })
        },
      })
      if (selected.kind === 'stop') return stop(selected.reason)
      if (selected.kind === 'fallback') {
        plan = withAttempt(candidates.get(key(selected.deployment))!, selected.decision, last.id)
        return undefined
      }
      if (allowRetry && input.fallback.owner === 'core' && last.ordinal < input.fallback.maxAttempts
        && ['rate-limit', 'quota', 'budget', 'unavailable'].includes(failure.reason)) {
        const candidate = withAttempt(previous, { ...prior, id: decisionId, decidedAt: now(), basis: 'retry' }, last.id)
        if (available(candidate).kind === 'ready') {
          plan = candidate
          return undefined
        }
      }
      return park(ref, state!, referenceId, selected.reason, selected.nextCheckAt)
    }

    const previous = ledger.history(ref, initial.attempt.id).at(-1)
    if (previous?.status === 'streaming') return stop('active')
    if (previous?.status === 'completed') return { kind: 'completed', attemptId: previous.id }
    if (previous) {
      const result = move(previous, previous.failure ?? { reason: 'unavailable' }, waiting)
      if (result) return result
    } else if (waiting) {
      plan = { ...plan, attempt: { ...plan.attempt, requestSeriesId: randomUUID() } }
    }
    if (waiting) {
      if (!permitted(ref, plan) || signal?.aborted) return stop('permission_denied')
      const woke = store.continueInference(ref, state.task.version, referenceId, state.attempt.mandate.policyVersion, now())
      if (!woke.ok) return stop(woke.code)
      state = woke.state
    }

    for (let index = 0; index < input.fallback.maxAttempts; index++) {
      if (signal?.aborted) return stop('cancelled')
      const result = await runOne(ref, state, plan, input, signal)
      if (result.kind === 'completed') return { ...result, attemptId: plan.attempt.id }
      if (result.kind === 'uncertain') return stop('reconciliation_required')
      if (result.failure.reason === 'authorization' || result.failure.reason === 'cancelled' || result.failure.reason === 'rejected') {
        return stop(result.failure.reason)
      }
      let last = ledger.get(ref, plan.attempt.id)
      if (!last) {
        if (signal?.aborted || !permitted(ref, plan) || !ledger.deny(ref, { ...plan, expectedVersion: state.task.version,
          unattended: input.unattended, maxAttempts: input.fallback.maxAttempts }, result.failure)) return stop('stale_attempt')
        last = ledger.get(ref, plan.attempt.id)
        if (!last) return stop('reconciliation_required')
      }
      const next = move(last, result.failure)
      if (next) return next
    }
    return park(ref, state, referenceId, 'attempt-limit')
  }

  return Object.freeze({
    async run(ref: WorkRef, raw: unknown, signal?: AbortSignal): Promise<Result> {
      const input = executionSchema.safeParse(raw)
      if (!input.success) return stop('invalid_input')
      const id = hash([ref.ownerId, ref.profileId, ref.taskId])
      if (active.has(id)) return stop('active')
      active.add(id)
      try { return await execute({ ...ref }, input.data, signal) }
      catch { return stop(signal?.aborted ? 'cancelled' : 'host_unavailable') }
      finally { active.delete(id) }
    },
  })
}

export type RoutedInferenceExecutor = ReturnType<typeof createRoutedInferenceExecutor>
