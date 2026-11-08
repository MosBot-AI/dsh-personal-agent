import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { contentHasImage, isAgentLoopRequest, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  inferenceAttemptSchema, modelDeploymentSchema, quotaBucketSchema, routingDecisionSchema, routingPolicyRevisionSchema,
  type DeploymentPin,
} from '@mosbot-ai/dshpa-plugin-api/model-routing'
import { z } from 'zod'

export const nativeRoutingPlanSchema = z.strictObject({
  deployment: modelDeploymentSchema,
  bucket: quotaBucketSchema,
  policy: routingPolicyRevisionSchema,
  decision: routingDecisionSchema,
  attempt: inferenceAttemptSchema,
})

export interface NativeRoutingFence {
  readonly taskId: string
  readonly taskAttemptId: string
  readonly generation: number
  readonly decisionId: string
  readonly acceptanceDigest?: string
  readonly attemptId: string
  readonly previousAttemptId?: string
  readonly requestSeriesId: string
  readonly policyId: string
  readonly policyRevision: number
  readonly deploymentId: string
  readonly deploymentRevision: number
  readonly pricingRevision?: number
  readonly accountId: string
  readonly quotaBucketId: string
  readonly quotaBucketRevision: number
  readonly provider: string
  readonly model: string
}

export interface RoutingCore {
  /** Verify the exact task, route/account binding, deployment and policy pins from authoritative state. */
  isCurrent(fence: NativeRoutingFence): boolean
  /** Core owns budget admission, claiming and settlement for each actual stream, including retries. */
  dispatch(fence: NativeRoutingFence, request: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
}

type PreparedRoute = Pick<Required<CreateAgentOptions>, 'sessionId' | 'agentOptions' | 'setup'>
type FailureCode = 'invalid_plan' | 'unsupported_effort' | 'unsupported_capability' | 'permission_denied' | 'host_unavailable'
type Prepared = { ok: true; options: PreparedRoute; fence: NativeRoutingFence } | { ok: false; code: FailureCode }
const failure = (code: FailureCode) => ({ ok: false, code }) as const

const samePin = (left: DeploymentPin, right: DeploymentPin) => left.id === right.id && left.revision === right.revision

function denied(): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: {
      code: 'ROUTING_DENIED', message: 'The pinned route is no longer authorized for this inference attempt.',
    } } }
  })()
}

/** Prepare a new native inference Session. The Task and its completed effects stay with the core. */
export async function prepareDshRouting(ctx: Context, input: unknown, core: RoutingCore, signal?: AbortSignal): Promise<Prepared> {
  const parsed = nativeRoutingPlanSchema.safeParse(input)
  if (!parsed.success) return failure('invalid_plan')
  const { deployment, bucket, policy, decision, attempt } = parsed.data
  if (decision.kind !== 'dispatch' || attempt.status !== 'planned' || !samePin(policy, decision.policy)
    || !samePin(deployment, decision.deployment) || !samePin(deployment, attempt.deployment)
    || deployment.accountId !== bucket.accountId || deployment.quotaBucketId !== bucket.id
    || attempt.pricingRevision !== (deployment.pricing.kind === 'configured' ? deployment.pricing.revision : undefined)
    || deployment.accountId !== attempt.accountId || deployment.quotaBucketId !== attempt.quotaBucketId
    || decision.id !== attempt.decisionId || decision.taskId !== attempt.taskId
    || decision.taskAttemptId !== attempt.taskAttemptId || decision.generation !== attempt.generation
    || ((decision.basis === 'escalation' || decision.basis === 'fallback' || decision.basis === 'retry') && !attempt.previousAttemptId)) return failure('invalid_plan')
  if (policy.mode === 'fixed' ? !samePin(policy.deployment, deployment) || decision.basis === 'fallback' || decision.basis === 'escalation'
      || (policy.effort !== undefined && decision.basis !== 'override' && decision.effort !== policy.effort)
    : !Object.values(policy.pools).some(pool => pool.some(pin => samePin(pin, deployment)))) return failure('permission_denied')

  const { requirements } = decision
  const contextTokens = requirements.inputTokens + requirements.outputTokens
  if (!requirements.capabilities.every(capability => deployment.capabilities.includes(capability))
    || requirements.outputTokens > deployment.outputTokens || contextTokens > deployment.contextTokens) return failure('unsupported_capability')
  if (!requirements.dataScope.every(label => deployment.dataScope.includes(label))) return failure('permission_denied')
  const mapping = decision.effort === undefined ? undefined : deployment.effort[decision.effort]
  if ((decision.effort !== undefined && mapping === undefined) || mapping?.kind === 'thinking-budget') return failure('unsupported_effort')

  const { provider, model } = deployment
  const fence: NativeRoutingFence = Object.freeze({
    taskId: attempt.taskId, taskAttemptId: attempt.taskAttemptId, generation: attempt.generation,
    decisionId: decision.id, acceptanceDigest: decision.acceptanceDigest, attemptId: attempt.id, previousAttemptId: attempt.previousAttemptId, requestSeriesId: attempt.requestSeriesId,
    policyId: policy.id, policyRevision: policy.revision, deploymentId: deployment.id, deploymentRevision: deployment.revision,
    pricingRevision: attempt.pricingRevision, accountId: bucket.accountId, quotaBucketId: bucket.id, quotaBucketRevision: bucket.revision, provider, model,
  })
  const current = () => {
    if (signal?.aborted) return false
    try { return core.isCurrent(fence) === true } catch { return false }
  }
  if (!current()) return failure('permission_denied')
  const llm = ctx.get('llm')
  const agents = ctx.get('agents')
  if (!llm || !agents) return failure('host_unavailable')

  const reasoningEffort = mapping?.kind === 'provider' ? ReasoningEffortId(mapping.id) : undefined
  let effectiveEffort: ReasoningEffortId | undefined
  try {
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (info.provider !== provider || info.id !== model) return failure('host_unavailable')
    if ((info.context && contextTokens > info.context.contextWindow)
      || (requirements.capabilities.includes('images') && !info.inputModalities?.includes('image'))) return failure('unsupported_capability')
    if (reasoningEffort !== undefined && !info.reasoning?.efforts.some(item => item.id === reasoningEffort)) return failure('unsupported_effort')
    effectiveEffort = reasoningEffort ?? info.reasoning?.defaultEffort
    if (effectiveEffort !== undefined && !deployment.nativeEfforts.includes(effectiveEffort)) return failure('unsupported_effort')
  } catch {
    return failure(current() ? 'host_unavailable' : 'permission_denied')
  }
  if (!current()) return failure('permission_denied')

  const key = JSON.stringify([attempt.taskId, attempt.taskAttemptId, attempt.generation, attempt.requestSeriesId])
  const sessionId = SessionId('dshpa-inference-' + createHash('sha256').update(key).digest('hex'))
  const selection = Object.freeze({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
  const agentOptions = Object.freeze({ ...selection, maxTokens: requirements.outputTokens })
  let used = false

  const setup: PreparedRoute['setup'] = (agentCtx, agent) => {
    if (used || agent.id !== sessionId || agent.session.header.parentSession !== undefined || agent.session.header.isSeeded
      || agent.session.snapshotEvents().length > 0 || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
      || !current()) throw new Error('Routing requires a fresh authorized inference Session')
    used = true
    agent.model.select(selection)
    const selectionMatches = (captured: typeof selection) => captured.provider === provider && captured.model === model
      && captured.reasoningEffort === reasoningEffort
    let first = true
    agentCtx.on('agent/pre-step', async (step, next) => {
      if (!current() || !selectionMatches(step.modelSelection)) return { kind: 'reject' }
      const result = await next()
      if (!current() || step.signal.aborted) return { kind: 'reject' }
      if (result.kind !== 'enter' || !first) return result
      first = false
      return { ...result, startsRequestSeries: true }
    }, { prepend: true })
    agentCtx.effect(() => ctx.on('llm/stream', (request, next) => {
      if (request.sessionId !== sessionId) return next()
      const authorized = () => current() && !request.signal?.aborted && agents.get(agent.id) === agent
      if (!authorized() || !isAgentLoopRequest(request) || request.provider !== provider || request.model !== model
        || request.reasoningEffort !== effectiveEffort || request.maxTokens !== requirements.outputTokens
        || ((request.tools?.length ?? 0) > 0 && !requirements.capabilities.includes('tools'))
        || (!requirements.capabilities.includes('images') && request.messages.some(message => contentHasImage(message.content)))) return denied()
      let dispatched = false
      return core.dispatch(fence, request, async function* () {
        if (dispatched || !authorized()) {
          yield* denied()
          return
        }
        dispatched = true
        yield* next()
      })
    }, { prepend: true }), 'dshpa: pinned native inference admission')
    return { commit() {
      const captured = agent.model.current()
      if (!captured || !selectionMatches(captured) || !current()) throw new Error('Routing authority changed before native publication')
    } }
  }

  return { ok: true, fence, options: Object.freeze({ sessionId, agentOptions, setup }) }
}
