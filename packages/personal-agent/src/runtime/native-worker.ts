import { createHmac, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { freezeMessage, isAgentLoopRequest, LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId as nativeSessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { WORKER_INPUT_LIMIT, type SessionId } from '../domain/model.js'
import { createPrivateWorkers } from '../policy/private-worker.js'
import {
  computeCooldown, computeDenied, meteredStream, providerComputeIssue, recordProviderCooldown,
  type ComputeIssue, type NativeWorkerCompute,
} from './compute.js'
import { workerMessageDigest } from './recovery-session.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dshpa-work-input': { kind: 'dshpa-work-input'; cursor: string; digest?: string }
  }
}

export interface NativeWorkerInput {
  readonly cursor: string
  readonly text: string
  readonly messageId: string
  readonly digest: string
  /** Synchronous exact journal acknowledgement after the native flush. */
  readonly acknowledge: () => boolean
  /** Trusted routed-input disclosure check, repeated at native step admission. */
  readonly authorize?: () => boolean
  readonly unattended?: boolean
}

export interface NativeWorker {
  followup(input: NativeWorkerInput): Promise<void>
  steer(input: NativeWorkerInput): Promise<void>
  flush(): Promise<void>
  whenIdle(): Promise<void>
  readReport(): string | undefined
  readComputeIssue?(): ComputeIssue | undefined
  stop(): Promise<boolean>
}

export type WorkerObservation = { readonly kind: 'start' | 'progress' | 'step' }
  | { readonly kind: 'tool'; readonly digest: string }
  | { readonly kind: 'issue'; readonly code: ComputeIssue['code'] }

export interface NativeWorkerRuntime {
  open(input: {
    readonly sessionId: SessionId
    readonly cwd: string
    readonly provider: string
    readonly model: string
    readonly resume: boolean
    readonly signal: AbortSignal
    readonly isCurrent: () => boolean
    readonly authorizeContext?: () => boolean
    readonly contextWindow?: () => number | undefined
    readonly compute?: NativeWorkerCompute
    readonly onObservation?: (observation: WorkerObservation) => void
  }): Promise<NativeWorker>
}

type OpenInput = Parameters<NativeWorkerRuntime['open']>[0]

interface Delivery {
  readonly cursor: string
  readonly messageId: string
  readonly digest: string
  stepTurn?: number
  matchingTurn?: number
  text?: string
  report?: string
  ended: boolean
}

/** Scope verified against the installed DSH jobs and subagent services. */
interface OwnedJob {
  readonly id: string
  readonly owner?: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
}

interface Jobs {
  readonly events: {
    subscribe(filter: { owners: 'all' }, listener: (event: { job?: OwnedJob }) => void): () => void
  }
  list(caller: Agent['id']): readonly OwnedJob[]
  wait(id: string, timeoutMs: number, caller: Agent['id']): Promise<OwnedJob>
  kill(id: string, caller: Agent['id'], reason: string): unknown
}

interface Subagents {
  drainDescendants(parents: readonly Agent[]): Promise<void>
}

const STOP_TIMEOUT_MS = 10_000

interface MintedInput {
  readonly cursor: string
  readonly digest: string
  readonly durable: Promise<boolean>
  readonly authorize?: () => boolean
  readonly unattended?: boolean
}

function authorized(check: (() => boolean) | undefined): boolean {
  if (!check) return true
  try {
    return check() === true
  } catch {
    return false
  }
}

async function acknowledged(acks: readonly Promise<boolean>[], signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  if (acks.length === 0) return true
  const cancelled = Promise.withResolvers<false>()
  const abort = () => cancelled.resolve(false)
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([Promise.all(acks).then(results => results.every(Boolean)), cancelled.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function observeDelivery(delivery: Delivery, event: SessionEvent): void {
  if (delivery.ended) return
  switch (event.type) {
    case 'step/start':
      delivery.stepTurn = event.data.turn
      break
    case 'user/message': {
      const { id, source } = event.data
      if (id === delivery.messageId && source.kind === 'dshpa-work-input' && source.cursor === delivery.cursor
        && source.digest === delivery.digest) {
        delivery.matchingTurn = delivery.stepTurn
      }
      break
    }
    case 'assistant/attempt':
      if (event.data.turn === delivery.matchingTurn) delivery.text = undefined
      break
    case 'assistant/message': {
      if (event.data.turn !== delivery.matchingTurn) break
      const { content } = event.data.message
      delivery.text = event.data.interrupted || content.some(block => block.type === 'tool-call')
        ? undefined
        : content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      break
    }
    case 'turn/end':
      if (event.data.turn === delivery.matchingTurn) {
        delivery.ended = true
        if (event.data.reason.kind === 'completed' && delivery.text?.trim()) delivery.report = delivery.text
      }
      break
  }
}

function ownedAgents(registry: AgentRegistry, parent: Agent): Agent[] {
  const live = registry.list()
  const owned = new Set([parent])
  for (const owner of owned) {
    for (const candidate of live) {
      if (registry.isOwnedBy(candidate.id, owner)) owned.add(candidate)
    }
  }
  return [...owned]
}

function isLiveJob(job: OwnedJob): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

function isSettledJob(job: OwnedJob): boolean {
  return job.status === 'killed' || job.status === 'completed'
}

function jobsOwnedBy(jobs: Jobs | undefined, registry: AgentRegistry, owners: readonly Agent[]) {
  if (jobs === undefined) return []
  return owners.flatMap(owner => registry.get(owner.id) === owner
    ? jobs.list(owner.id).filter(job => job.owner === owner.id).map(job => ({ owner, job }))
    : [])
}

async function stopJob(jobs: Jobs, registry: AgentRegistry, owner: Agent, job: OwnedJob): Promise<boolean> {
  if (registry.get(owner.id) !== owner) return false
  // Install the waiter first so job settlement is collected by the stop.
  const completion = jobs.wait(job.id, STOP_TIMEOUT_MS, owner.id).catch(() => undefined)
  let requested = true
  try {
    if (job.status === 'running') jobs.kill(job.id, owner.id, 'Private worker stopped')
  } catch {
    requested = false
  }
  let settled = await completion
  while (requested && settled && registry.get(owner.id) === owner && isLiveJob(settled)) {
    settled = await jobs.wait(job.id, STOP_TIMEOUT_MS, owner.id).catch(() => undefined)
  }
  return requested && settled !== undefined && settled.id === job.id
    && settled.owner === owner.id && isSettledJob(settled)
}

async function stopOwnedWorker(ctx: Context, handle: AgentHandle): Promise<boolean> {
  const { agent } = handle
  const registry = ctx.agents
  const jobs = ctx.get('jobs') as Jobs | undefined
  const subagents = ctx.get('subagents') as Subagents | undefined
  const seenOwners = new Set<Agent>()
  const observedJobs = new Map<string, OwnedJob>()
  let verified = true
  let unsubscribe: (() => void) | undefined

  const recordJob = (job: OwnedJob) => {
    observedJobs.set(job.id, job)
    if (!isLiveJob(job) && !isSettledJob(job)) verified = false
  }
  const snapshotJobs = (owners: readonly Agent[]) => {
    const owned = jobsOwnedBy(jobs, registry, owners)
    for (const { job } of owned) recordJob(job)
    return owned
  }

  async function drain(owners: Agent[]) {
    for (const owner of owners) seenOwners.add(owner)
    const jobsStopped = async () => {
      const live = snapshotJobs(owners).filter(({ job }) => isLiveJob(job))
      if (jobs === undefined) return true
      return (await Promise.all(live.map(({ owner, job }) => stopJob(jobs, registry, owner, job)))).every(Boolean)
    }
    const cleanup = await Promise.allSettled([
      jobsStopped(),
      Promise.resolve().then(() => subagents?.drainDescendants([agent])),
      Promise.allSettled(owners.map(async owner => {
        owner.cancel({ kind: 'user' })
        await owner.whenIdle()
      })).then(results => results.every(result => result.status === 'fulfilled')),
    ])
    if (cleanup.some(result => result.status === 'rejected' || result.value === false)) verified = false
  }

  try {
    // Observe through disposal so a late trusted callback cannot hide an
    // unverified job by creating it after the last explicit inventory.
    unsubscribe = jobs?.events.subscribe({ owners: 'all' }, ({ job }) => {
      if (job?.owner === undefined) return
      if (ownedAgents(registry, agent).some(owner => owner.id === job.owner && registry.get(owner.id) === owner)) {
        recordJob(job)
      }
    })
    await drain(ownedAgents(registry, agent))
    const late = ownedAgents(registry, agent)
    if (late.some(owner => !seenOwners.has(owner)) || snapshotJobs(late).some(({ job }) => isLiveJob(job))) {
      await drain(late)
    }
    const final = ownedAgents(registry, agent)
    if (final.some(owner => !seenOwners.has(owner)) || snapshotJobs(final).some(({ job }) => isLiveJob(job))) verified = false
  } catch {
    verified = false
  }
  try {
    await handle.dispose()
    return verified && [...observedJobs.values()].every(isSettledJob)
      && [...seenOwners].every(owner => registry.get(owner.id) !== owner)
      && registry.get(agent.id) !== agent
      && ownedAgents(registry, agent).length === 1
  } catch {
    return false
  } finally {
    unsubscribe?.()
  }
}

async function boundedStop(completion: Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS) })
    return await Promise.race([completion, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function matchesRoute(input: OpenInput, route: { provider: string; model: string } | undefined): boolean {
  return route?.provider === input.provider && route.model === input.model
}

function installComputeGate(
  ctx: Context, agentCtx: Context, agent: Agent, input: OpenInput,
  compute: NativeWorkerCompute, active: () => boolean, onIssue: (issue?: ComputeIssue) => void,
) {
  const { limits, budget } = compute
  let deadline: NodeJS.Timeout | undefined
  let deadlineAt = 0
  let step: { turn: number; unattended: boolean; claimed: boolean } | undefined
  const clear = () => {
    clearTimeout(deadline)
    deadline = undefined
    step = undefined
  }
  const available = () => active() && performance.now() < deadlineAt
  const deny = (code: string) => (async function* () {
    onIssue({ code })
    yield computeDenied(code)
  })()

  // The pinned LLM service emits this waterfall for the prepared native
  // call as well as direct streams. Its dispatch is unscoped, so match the
  // exact live Session and native request identity here.
  agentCtx.effect(() => ctx.on('llm/stream', (request, next) => {
    if (request.sessionId !== agent.id) return next()
    if (!step || step.claimed || !available() || !matchesRoute(input, request)
      || !isAgentLoopRequest(request) || ctx.agents.get(agent.id) !== agent) return deny('compute_limit')
    if (!authorized(input.authorizeContext)) return deny('permission_denied')
    if (input.contextWindow) {
      const window = input.contextWindow()
      const meter = ctx.get('tokenMeter')
      if (!window || !meter) return deny('context_budget_unavailable')
      const estimate = request.messages.reduce((total, message) => total + meter.estimateMessage(message.id !== undefined ? message : {
        role: 'user', content: message.content, id: MessageId('dshpa-context-measurement'),
        source: { kind: 'dshpa-work-input', cursor: 'measurement' },
      }), Buffer.byteLength(request.system ?? '') + 64)
      if (!Number.isSafeInteger(estimate) || estimate + limits.maxOutputTokens > window) return deny('context_budget_exceeded')
    }
    const scope = compute.scope(step.unattended)
    if (!scope) return deny('permission_denied')
    step.claimed = true
    return meteredStream({ budget, request, limits, scope, onIssue, current: available,
      next: () => authorized(input.authorizeContext) ? next() : deny('permission_denied') })
  }, { prepend: true }), 'dshpa: metered native requests')
  agentCtx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'turn/end' && event.data.turn === step?.turn) clear()
  })
  agentCtx.effect(() => clear, 'dshpa: compute deadline')

  return (turn: number, index: number, unattended: boolean): boolean => {
    if (turn > limits.maxTurns) {
      onIssue({ code: 'turn_limit' })
      return false
    }
    const automatic = unattended || (step?.turn === turn ? step.unattended : compute.initiallyUnattended === true)
    const scope = compute.scope(automatic)
    if (!scope) return false
    const cooldown = computeCooldown(budget, scope, input.provider, input.model)
    if (cooldown) {
      onIssue(cooldown)
      return false
    }
    if (index > limits.maxStepsPerTurn) {
      onIssue({ code: 'compute_limit' })
      return false
    }
    if (step?.turn !== turn) {
      clear()
      deadlineAt = performance.now() + limits.maxWallTimeMs
      deadline = setTimeout(() => {
        if (step?.turn !== turn || ctx.agents.get(agent.id) !== agent) return
        if (active()) onIssue({ code: 'compute_limit' })
        agent.cancel({ kind: 'hook', reason: 'Worker compute time limit reached' })
      }, limits.maxWallTimeMs)
    }
    if (!available()) {
      onIssue({ code: 'compute_limit' })
      return false
    }
    onIssue()
    step = { turn, unattended: automatic, claimed: false }
    return true
  }
}

export function createNativeWorkerRuntime(
  ctx: Context,
  flushSession: (session: Session) => Promise<void>,
): NativeWorkerRuntime {
  return Object.freeze<NativeWorkerRuntime>({
    async open(options) {
      const input = { ...options }
      let stopping: Promise<boolean> | undefined
      let delivery: Delivery | undefined
      let issue: ComputeIssue | undefined
      let sends = 0
      let admittedInput = false
      const minted = new Map<string, MintedInput>()
      const sent = new Set<string>()
      const digestKey = input.onObservation ? randomBytes(32) : undefined
      const active = () => stopping === undefined && !input.signal.aborted && input.isCurrent()
      const contextCurrent = () => authorized(input.authorizeContext)
      const notify = (observation: WorkerObservation) => {
        try { if (active()) input.onObservation?.(observation) } catch { /* Diagnostics do not drive the Worker. */ }
      }
      function setIssue(observed?: ComputeIssue) {
        const changed = observed !== undefined && observed.code !== issue?.code
        issue = observed
        if (changed) notify({ kind: 'issue', code: observed.code })
      }
      const assertActive = () => {
        if (!active()) throw new Error('The private worker attempt is no longer current')
      }
      assertActive()
      const workers = createPrivateWorkers(ctx, (agentCtx, agent) => {
        function checkLaunch() {
          assertActive()
          if (agent.session.header.cwd !== input.cwd || !matchesRoute(input, agent.model.current())) {
            throw new Error('The private worker session does not match its authorized directory and model')
          }
          if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
            throw new Error('Pending native worker input requires reconciliation')
          }
        }
        checkLaunch()
        const admitCompute = input.compute && installComputeGate(
          ctx, agentCtx, agent, input, input.compute, active, setIssue,
        )
        // Private Workers require a new owner-authorized input after a model
        // failure. The native retry hook cannot repeat an admitted request.
        agentCtx.on('agent/request-error', async () => undefined, { prepend: true })
        agentCtx.on('agent/error', ({ error }) => {
          if (issue || !active() || !(error instanceof LlmError)) return
          // Model preparation can fail before the metered stream and before
          // DSH records the user message. No budget claim was made in that case.
          const failure = providerComputeIssue(error.failure)
          const compute = input.compute
          const scope = compute?.scope(false)
          setIssue(compute && scope ? recordProviderCooldown(compute.budget, scope, input, failure) : failure)
        })
        agentCtx.on('agent/pre-step', async ({ messages, modelSelection, signal, turn, step }, next) => {
          let owned = true
          const inputs: MintedInput[] = []
          for (const { id, source } of messages) {
            const message = minted.get(id)
            minted.delete(id)
            if (!message || source.kind !== 'dshpa-work-input' || source.cursor !== message.cursor || source.digest !== message.digest) {
              owned = false
            } else {
              inputs.push(message)
            }
          }
          const mayDisclose = () => contextCurrent() && inputs.every(message => authorized(message.authorize))
          if (!owned || (inputs.length === 0 && !admittedInput) || !active()
            || !matchesRoute(input, modelSelection) || !mayDisclose()) {
            return { kind: 'reject' }
          }
          if (!await acknowledged(inputs.map(message => message.durable), signal)
            || signal.aborted || !active() || !mayDisclose()) return { kind: 'reject' }
          const decision = await next()
          if (!active() || signal.aborted || !mayDisclose()) return { kind: 'reject' }
          if (decision.kind === 'enter' && admitCompute
            && !admitCompute(turn, step, inputs.some(message => message.unattended === true))) return { kind: 'reject' }
          if (decision.kind === 'enter' && inputs.length > 0) admittedInput = true
          return decision
        }, { prepend: true })
        agentCtx.on('session/event', (session, event) => {
          if (session !== agent.session) return
          if (delivery !== undefined) observeDelivery(delivery, event)
          if (event.type === 'step/start') notify({ kind: 'step' })
          if (!digestKey || event.type !== 'assistant/message' || event.data.interrupted) return
          for (const block of event.data.message.content) {
            if (block.type !== 'tool-call') continue
            const digest = createHmac('sha256', digestKey).update(JSON.stringify([block.name, block.arguments])).digest('hex')
            notify({ kind: 'tool', digest })
          }
        })
        return { commit: checkLaunch }
      })
      const id = nativeSessionId(input.sessionId)
      const agentOptions = { provider: input.provider, model: input.model, maxTokens: input.compute?.limits.maxOutputTokens }
      const handle = input.resume
        ? await workers.resume({ resumeSessionId: id, agentOptions, signal: input.signal })
        : await workers.create({ sessionId: id, meta: { cwd: input.cwd }, agentOptions, signal: input.signal })
      const { agent } = handle

      async function deliver(method: 'followup' | 'steer', {
        cursor, text, messageId, digest, acknowledge, authorize, unattended,
      }: NativeWorkerInput) {
        assertActive()
        if (!authorized(authorize) || !contextCurrent()) throw new Error('The private worker input authority changed')
        if (sends >= WORKER_INPUT_LIMIT) throw new Error('The private worker input limit was reached')
        if (sent.has(messageId) || workerMessageDigest(text) !== digest) {
          throw new Error('The private worker input identity or digest does not match')
        }
        const message = freezeMessage({
          id: MessageId(messageId),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'dshpa-work-input', cursor, digest },
        })
        const durable = Promise.withResolvers<boolean>()
        sends++
        issue = undefined
        sent.add(message.id)
        minted.set(message.id, { cursor, digest, durable: durable.promise, authorize, unattended })
        delivery = { cursor, messageId: message.id, digest, ended: false }
        try {
          agent[method](message)
          // followup/steer wake natively. The pre-step gate waits on this
          // barrier and the exact SQLite acknowledgement before inference.
          await flushSession(agent.session)
          assertActive()
          if (!authorized(authorize) || acknowledge() !== true) throw new Error('The private worker input acknowledgement was rejected')
          assertActive()
          durable.resolve(true)
        } catch (error) {
          minted.delete(message.id)
          if (delivery?.messageId === message.id) delivery = undefined
          durable.resolve(false)
          throw error
        }
      }

      return Object.freeze<NativeWorker>({
        followup: input => deliver('followup', input),
        steer: input => deliver('steer', input),
        flush: () => flushSession(agent.session),
        whenIdle: () => agent.whenIdle(),
        readReport: () => active() ? delivery?.report : undefined,
        readComputeIssue: () => issue?.code.startsWith('provider_')
          ? { ...issue, inputAdmitted: delivery?.matchingTurn !== undefined } : issue,
        stop() {
          stopping ??= Promise.resolve().then(() => stopOwnedWorker(ctx, handle)).catch(() => false)
          return boundedStop(stopping)
        },
      })
    },
  })
}
