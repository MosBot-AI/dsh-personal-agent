import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { prepareDshRouting } from '@mosbot-ai/dshpa-model-routing'
import { inferenceAttemptSchema, quotaObservationSchema } from '@mosbot-ai/dshpa-plugin-api/model-routing'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter, createUserMessage } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'agents', 'llm']

const at = '2026-11-08T01:00:00.000Z'
const task = { taskId: 'same-business-task', taskAttemptId: 'same-task-attempt', generation: 3 }
const a = { id: 'a', revision: 1 }
const b = { id: 'b', revision: 1 }
const policy = { id: 'owner-policy', revision: 2, mode: 'automatic',
  pools: { fast: [a], balanced: [a, b], deep: [b] }, maxSwitches: 1 }

function plan(pin, effort, basis = 'rule', previousAttemptId) {
  const provider = `native-${pin.id}`
  const model = `model-${pin.id}`
  const accountId = `account-${pin.id}`
  const quotaBucketId = `quota-${pin.id}`
  const decisionId = `decision-${pin.id}`
  return {
    deployment: { ...pin, accountId, quotaBucketId, provider, model,
      destination: { kind: 'local' }, dataScope: ['fixture'], capabilities: [],
      contextTokens: 4096, outputTokens: 512, nativeEfforts: ['basic', 'deep'],
      effort: { low: { kind: 'provider', id: 'basic' }, high: { kind: 'provider', id: 'deep' } } },
    bucket: { id: quotaBucketId, accountId, revision: 4 },
    policy,
    decision: { kind: 'dispatch', id: decisionId, ...task, policy: { id: policy.id, revision: policy.revision },
      decidedAt: at, requirements: { capabilities: [], dataScope: ['fixture'], inputTokens: 1024, outputTokens: 512 },
      excluded: [], deployment: pin, effort, basis },
    attempt: { id: `inference-${pin.id}`, ...task, decisionId, requestSeriesId: `series-${pin.id}`,
      previousAttemptId, deployment: pin, accountId, quotaBucketId, status: 'planned', createdAt: at, budgetReservationIds: [] },
  }
}

class Adapter extends LlmAdapter {
  requests = []

  constructor({ provider, model }, failFirst) {
    super()
    this.provider = provider
    this.model = model
    this.failFirst = failFirst
  }

  async listModels() { return [{ provider: this.provider, id: this.model, name: this.model }] }

  async resolveModel(provider, id) {
    assert.equal(provider, this.provider)
    assert.equal(id, this.model)
    return { provider, id, name: id, context: { contextWindow: 4096 },
      reasoning: { efforts: [{ id: 'basic', name: 'Basic' }, { id: 'deep', name: 'Deep' }], defaultEffort: 'basic' } }
  }

  async *stream(request) {
    this.requests.push(request)
    if (this.failFirst && this.requests.length === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_RETRY', message: 'Retry this test request' } } }
      return
    }
    const text = this.failFirst ? 'Earlier route answer must stay in its own Session.' : 'New route answer.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const requestSelection = request => [request.provider, request.model, request.reasoningEffort, request.maxTokens]

function headers(agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'request/header').map(event => event.data)
}

async function exercise(ctx) {
  const first = plan(a, 'low')
  const next = plan(b, 'high', 'fallback', first.attempt.id)
  const modelA = new Adapter(first.deployment, true)
  const modelB = new Adapter(next.deployment, false)
  ctx.llm.registerAdapter([modelA.provider], modelA)
  ctx.llm.registerAdapter([modelB.provider], modelB)

  let authorized = true
  let allowBudget = true
  let revokeBeforeDispatch = false
  const admitted = []
  const core = {
    isCurrent: fence => authorized && fence.taskId === task.taskId && fence.generation === task.generation
      && fence.quotaBucketRevision === 4 && fence.policyRevision === 2,
    async *dispatch(fence, request, stream) {
      admitted.push({ fence, route: requestSelection(request) })
      if (allowBudget) {
        const pending = stream()
        if (revokeBeforeDispatch) authorized = false
        yield* pending
      }
      else yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_BUDGET', message: 'Core refused budget' } } }
    },
  }

  const misbound = { ...first, attempt: { ...first.attempt, accountId: next.deployment.accountId } }
  assert.deepEqual(await prepareDshRouting(ctx, misbound, core), { ok: false, code: 'invalid_plan' })
  const fixed = { ...next, policy: { id: policy.id, revision: policy.revision, mode: 'fixed', deployment: a } }
  assert.deepEqual(await prepareDshRouting(ctx, fixed, core), { ok: false, code: 'permission_denied' })
  assert.deepEqual(await prepareDshRouting(ctx, { ...first, decision: { ...first.decision, effort: 'medium' } }, core),
    { ok: false, code: 'unsupported_effort' })
  const unknownEffort = { ...first, deployment: { ...first.deployment, nativeEfforts: ['fake'],
    effort: { low: { kind: 'provider', id: 'fake' } } } }
  assert.deepEqual(await prepareDshRouting(ctx, unknownEffort, core), { ok: false, code: 'unsupported_effort' })
  const vision = { ...first, decision: { ...first.decision,
    requirements: { ...first.decision.requirements, capabilities: ['images'] } } }
  assert.deepEqual(await prepareDshRouting(ctx, vision, core), { ok: false, code: 'unsupported_capability' })
  assert.equal(inferenceAttemptSchema.safeParse({ ...first.attempt, budgetReservationIds: ['already-claimed'] }).success, false)
  assert.equal(quotaObservationSchema.safeParse({
    bucket: { id: 'bucket', revision: 1 }, observedAt: at, status: 'unknown', provenance: 'unknown', remainingTokens: 500,
  }).success, false)

  const chosen = await prepareDshRouting(ctx, first, core)
  assert.ok(chosen.ok, JSON.stringify(chosen))
  const captured = []
  const assembled = []
  let retries = 0
  const dropAssembly = ctx.on('system-prompt/assemble', async (_assembly, info, resume) => {
    if (info.agent?.id === chosen.options.sessionId) assembled.push(info.modelSelection)
    return resume()
  })
  const prior = await ctx.agents.create({ ...chosen.options, setup(agentCtx, agent) {
    const commit = chosen.options.setup(agentCtx, agent)
    agentCtx.on('agent/pre-step', async (event, resume) => { captured.push(event.modelSelection); return resume() })
    agentCtx.on('agent/request-error', async () => {
      retries++
      // This updates the live selection, but the current native step has already captured A.
      agent.model.select({ provider: modelB.provider, model: modelB.model, reasoningEffort: 'deep' })
      return { kind: 'retry' }
    })
    return commit
  } })
  try {
    const forged = []
    for await (const event of ctx.llm.stream({ provider: modelA.provider, model: modelA.model,
      sessionId: chosen.options.sessionId, messages: [user('Forged request')], reasoningEffort: 'basic', maxTokens: 512 })) {
      forged.push(event)
    }
    assert.equal(forged.at(-1)?.reason.failure.code, 'ROUTING_DENIED')
    assert.equal(admitted.length, 0)
    prior.agent.followup(user('Earlier route request must stay in its own Session.'))
    await prior.agent.whenIdle()
    assert.equal(retries, 1)
    assert.deepEqual(captured, [{ provider: modelA.provider, model: modelA.model, reasoningEffort: 'basic' }])
    assert.deepEqual(assembled, captured, 'Assembly captures the same route as pre-step and runs once')
    const expectedA = [modelA.provider, modelA.model, 'basic', 512]
    assert.deepEqual(modelA.requests.map(requestSelection), [expectedA, expectedA])
    assert.equal(modelB.requests.length, 0)
    assert.deepEqual(admitted.map(row => row.route), [expectedA, expectedA])
    assert.ok(admitted.every(row => row.fence.accountId === 'account-a' && row.fence.quotaBucketId === 'quota-a'))
    assert.deepEqual(headers(prior.agent).map(row => [row.reason, row.startsSeries, row.header.config.reasoningEffort]),
      [['initial', true, 'basic']])
  } finally { dropAssembly(); await prior.dispose() }

  const rerouted = await prepareDshRouting(ctx, next, core)
  assert.ok(rerouted.ok)
  assert.notEqual(rerouted.options.sessionId, chosen.options.sessionId)
  const handle = await ctx.agents.create(rerouted.options)
  try {
    handle.agent.followup(user('Fresh authorized evidence.'))
    await handle.agent.whenIdle()
    assert.deepEqual(modelB.requests.map(requestSelection), [[modelB.provider, modelB.model, 'deep', 512]])
    assert.doesNotMatch(JSON.stringify(modelB.requests[0].messages), /Earlier route/)
    assert.equal(admitted.at(-1).fence.taskId, task.taskId)
    assert.equal(admitted.at(-1).fence.previousAttemptId, first.attempt.id)
    assert.equal(admitted.at(-1).fence.accountId, 'account-b')
    assert.deepEqual(headers(handle.agent).map(row => [row.reason, row.startsSeries]), [['initial', true]])
    authorized = false
    handle.agent.followup(user('The revoked plan must remain idle.'))
    await handle.agent.whenIdle()
    assert.equal(modelB.requests.length, 1)
  } finally { await handle.dispose() }

  authorized = true
  allowBudget = false
  const refused = await prepareDshRouting(ctx, { ...next, attempt: { ...next.attempt, id: 'refused', requestSeriesId: 'refused' } }, core)
  assert.ok(refused.ok)
  const denied = await ctx.agents.create(refused.options)
  try {
    denied.agent.followup(user('Core budget denies this request.'))
    await denied.agent.whenIdle()
    assert.equal(admitted.at(-1).fence.attemptId, 'refused')
    assert.equal(modelB.requests.length, 1)
  } finally { await denied.dispose() }

  allowBudget = true
  const defaultRoute = await prepareDshRouting(ctx, { ...next,
    decision: { ...next.decision, effort: undefined },
    attempt: { ...next.attempt, id: 'default-effort', requestSeriesId: 'default-effort' },
  }, core)
  assert.ok(defaultRoute.ok)
  assert.equal(defaultRoute.options.agentOptions.reasoningEffort, undefined)
  const defaulted = await ctx.agents.create(defaultRoute.options)
  try {
    defaulted.agent.followup(user('Use the verified adapter default.'))
    await defaulted.agent.whenIdle()
    assert.equal(modelB.requests.length, 2)
    assert.equal(modelB.requests.at(-1).reasoningEffort, 'basic')
    revokeBeforeDispatch = true
    defaulted.agent.followup(user('Revoke after the core receives the next iterable.'))
    await defaulted.agent.whenIdle()
    assert.equal(modelB.requests.length, 2)
    assert.equal(authorized, false)
    assert.equal(admitted.at(-1).fence.attemptId, 'default-effort')
  } finally { await defaulted.dispose() }

  authorized = true
  revokeBeforeDispatch = false
  const excessTool = await prepareDshRouting(ctx, { ...next,
    attempt: { ...next.attempt, id: 'excess-tool', requestSeriesId: 'excess-tool' },
  }, core)
  assert.ok(excessTool.ok)
  const withTool = await ctx.agents.create({ ...excessTool.options, setup(agentCtx, agent) {
    const commit = excessTool.options.setup(agentCtx, agent)
    agentCtx.tools.register({ name: 'not_in_scope', description: 'Schema outside the approved capability',
      parameters: { type: 'object', additionalProperties: false }, output: { schema: {}, render: () => [] },
      async execute() { assert.fail('Unapproved tool executed') } })
    return commit
  } })
  try {
    withTool.agent.followup(user('The extra tool cannot enter the provider request.'))
    await withTool.agent.whenIdle()
    assert.equal(modelB.requests.length, 2)
    assert.ok(admitted.every(row => row.fence.attemptId !== 'excess-tool'))
  } finally { await withTool.dispose() }

  let lateError
  const late = await ctx.agents.create({ sessionId: 'deprecated-hook-test', agentOptions: chosen.options.agentOptions,
    setup(agentCtx) {
      agentCtx.on('agent/request', async (_request, resume) => ({ ...await resume(), reasoningEffort: 'deep' }))
      agentCtx.on('agent/error', ({ error }) => { lateError = error })
    },
  })
  try {
    late.agent.followup(user('Attempt a late effort change.'))
    await late.agent.whenIdle()
    assert.match(String(lateError), /after step preparation fixed/)
    assert.equal(modelA.requests.length, 2)
  } finally { await late.dispose() }
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void exercise(ctx).then(() => {
      console.log('PA040_NATIVE_ROUTING pinned retry fresh-series')
      ctx.appExit(0)
    }, error => { console.error(error); ctx.appExit(1) })
  }))
}
