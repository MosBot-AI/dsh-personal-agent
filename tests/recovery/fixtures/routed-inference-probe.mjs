import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const app = dirname(require.resolve('@mosbot-ai/dshpa/package.json'))
const load = path => import(pathToFileURL(join(app, 'lib', path)).href)
const { openWorkStore } = await load('storage/store.js')
const { inferenceAcceptanceDigest } = await load('runtime/routed-inference.js')
const { createIdentityBoundary } = await load('policy/identity.js')
const { canonicalizeAction } = await load('policy/grants.js')
const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter, createUserMessage } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'llm', 'dshpa']

const scope = { ownerId: 'inference-owner', profileId: 'inference-profile' }
const at = '2026-11-08T02:00:00.000Z'
const pin = { id: 'routing', revision: 1 }
const a = { id: 'a', revision: 1 }
const b = { id: 'b', revision: 1 }
const policy = { ...pin, mode: 'automatic', maxSwitches: 2, pools: { fast: [a], balanced: [a, b], deep: [b] } }
const fallback = { owner: 'core', maxAttempts: 3, chains: { 'rate-limit': [b], unavailable: [b] } }
const atTime = ms => new Date(Date.parse(at) + ms).toISOString()
const binding = { sourceInstanceId: 'source', accountId: 'effect-account', kind: 'fixture-write',
  resourceRef: 'fixture-resource', dataScope: ['fixture'], limits: { maxUses: 1 } }

function route(deployment) {
  const accountId = `account-${deployment.id}`
  const bucket = { id: 'bucket', accountId, revision: 1, requestsPerMinute: 2, tokensPerMinute: 32768 }
  return { bucket, deployment: { ...deployment, provider: `provider-${deployment.id}`, model: 'fixture', accountId,
    quotaBucketId: bucket.id, destination: { kind: 'network', origin: `https://${deployment.id}.example.test` },
    dataScope: ['fixture'], capabilities: [], contextTokens: 8192, outputTokens: 512, nativeEfforts: [], effort: {} } }
}
const first = route(a)
const replacement = route(b)
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result }

class Adapter extends LlmAdapter {
  requests = []
  constructor(provider, fail, crash = false) { super(); this.provider = provider; this.fail = fail; this.crash = crash }
  async listModels() { return [{ provider: this.provider, id: 'fixture', name: 'fixture' }] }
  async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 8192 } } }
  async *stream(request) {
    this.requests.push(request)
    assert.deepEqual(request.tools ?? [], [])
    const text = this.fail ? 'abandoned partial output' : 'verified replacement'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    if (this.crash) process.exit(86)
    if (this.fail) {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 20_000, message: 'Fixture rate limit.',
      } } }
      return
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 32, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function seed(store, name, now, handoff) {
  const project = { ...scope, id: `project-${name}`, kind: 'project', title: 'Inference recovery',
    purpose: 'Verify scoped inference.', status: 'active', resourceRefs: [], successCriteria: ['Verify result'],
    milestones: [], planRevision: 1 }
  const taskId = `task-${name}`
  const attemptId = `attempt-${name}`
  const ref = { ...scope, taskId }
  const profile = { id: scope.profileId, ownerId: scope.ownerId, policyVersion: 'policy-v1',
    verifiedAccounts: [{ sourceInstanceId: binding.sourceInstanceId, accountId: binding.accountId, verifiedAt: at }],
    verifiedDevices: [{ deviceId: 'device', verifiedAt: at }] }
  const identity = createIdentityBoundary(() => profile)
  const token = identity.bindOwner({ ...scope, clientId: 'client', deviceId: 'device', sessionId: 'owner-session' })
  const action = { ...scope, ...binding, taskId, attemptId, generation: 1, operationId: `effect-${name}`,
    policyVersion: profile.policyVersion, payload: { text: 'Confirmed effect' } }
  const digest = canonicalizeAction(action).digest
  store.insertProject(project)
  const { state: queued } = ok(store.applyCommand({
    type: 'work.create', commandId: `create-${name}`, payload: { projectId: project.id,
      requestedOutcome: 'Verify the model result', constraints: [],
      acceptance: { criteria: ['Verify result'], requiresArtifact: false, requiresReceipt: false } },
  }, { actor: identity.resolveOwner(token), at: now(), projectId: project.id, newTaskId: taskId,
    newAttempt: { id: attemptId, mandate: { ...scope, id: `mandate-${name}`, policyVersion: profile.policyVersion } } }, handoff ? {
    effects: [{ operationId: action.operationId, taskId, attemptId, generation: 1, status: 'prepared',
      intent: 'Fixture effect', payloadDigest: digest }],
  } : {}))
  const { state } = ok(store.applyEvent(ref, { type: 'start', at: now(), executor: 'routed-inference',
    expectedVersion: queued.task.version, attemptId, generation: 1,
    scope: { capabilities: [binding.kind], dataScope: binding.dataScope } }))
  if (handoff) {
    const gate = store.createActionGate({ identity, now, routes: [{ binding, permitsPayload: () => true, handoff }] })
    const requestId = `approval-${name}`
    const review = gate.review(action, { requestId, expiresAt: atTime(300_000) }, token)
    assert.equal(review.decision, 'ask')
    const approval = gate.respond({ requestId, expectedVersion: review.version,
      digest: review.approval.action.payloadDigest, decision: 'approve' }, token)
    assert.equal(approval.status, 'approved')
    ok(gate.dispatch(action, approval.grantId, state.task.version))
    const recovery = store.createEffectRecovery({ now, routes: [{ ...scope, binding, lookup(request) {
      const { operationId, taskId, attemptId, generation, sourceInstanceId, accountId, digest, providerIdempotencyKey } = request
      return { operationId, taskId, attemptId, generation, sourceInstanceId, accountId, digest, providerIdempotencyKey,
        kind: 'confirmed', receiptId: 'verified-effect-receipt' }
    } }] })
    recovery.classifyInterrupted()
    assert.equal(ok(await recovery.reconcile(ref, action.operationId)).effect.status, 'confirmed')
  }
  return { ref, state }
}

function execution(work, now) {
  const { ref, state } = work
  const fence = { taskId: ref.taskId, taskAttemptId: state.attempt.id, generation: state.task.generation }
  const id = `decision-${ref.taskId}`
  return {
    initial: {
      ...first, policy,
      decision: { ...fence, kind: 'dispatch', id, policy: pin, deployment: a, decidedAt: now(),
        acceptanceDigest: inferenceAcceptanceDigest(state), basis: 'rule', excluded: [],
        requirements: { capabilities: [], dataScope: ['fixture'], inputTokens: 1024, outputTokens: 128 } },
      attempt: { ...fence, id: `inference-${ref.taskId}`, decisionId: id, requestSeriesId: `series-${ref.taskId}`,
        deployment: a, accountId: first.bucket.accountId, quotaBucketId: first.bucket.id, createdAt: now(),
        status: 'planned', budgetReservationIds: [] },
    },
    candidates: [replacement], fallback, expectedVersion: state.task.version, unattended: true,
  }
}

async function exercise(ctx) {
  const A = new Adapter(first.deployment.provider, true)
  const B = new Adapter(replacement.deployment.provider, false)
  ctx.llm.registerAdapter([A.provider], A)
  ctx.llm.registerAdapter([B.provider], B)
  const root = join(process.cwd(), 'inference-work')
  let clock = at
  const now = () => clock
  let store = openWorkStore(root)
  let allowReplacement = true
  let effectsDispatched = 0
  const assemblies = []
  function attach(maxMicros = 100, freeReplacement = false) {
    const pricing = { kind: 'known', inputMicrosPerMillion: 1, outputMicrosPerMillion: 1,
      cacheReadMicrosPerMillion: 1, cacheWriteMicrosPerMillion: 1, ceilingMicros: 20 }
    const budget = store.createBudget({ now, pricingVersion: 'fixture',
      routes: [A, B].map(adapter => ({ provider: adapter.provider, model: 'fixture', currency: 'USD',
        pricing: freeReplacement && adapter === B ? { kind: 'known', inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
          cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0, ceilingMicros: 0 } : pricing })),
      limits: [{ currency: 'USD', ownerDayMicros: maxMicros, taskMicros: Math.min(maxMicros, 40), maxCallsPerDay: 12, maxCallsPerTask: 5, maxConcurrent: 3 }],
    })
    const quota = { now, allowBoundedUnknown: true }
    const executor = ctx.dshpa.host.createInferenceExecutor({ store, budget, quota, now, authority: {
      authorize(_ref, decision, deployment) {
        return decision.acceptanceDigest?.length === 64 && (deployment.id !== 'b' || allowReplacement)
      },
      async assemble(ref, decision, effects) {
        assemblies.push({ taskId: ref.taskId, deployment: decision.deployment.id, effects })
        return 'Authorized task evidence: ' + effects.map(effect => effect.receipt.providerReceiptId).join(', ')
      },
    } })
    return { executor, ledger: store.createInferenceLedger(quota) }
  }
  try {
    let f = attach()
    const one = await seed(store, 'fallback', now, () => { effectsDispatched++ })
    const request = execution(one, now)
    assert.deepEqual(await f.executor.run(one.ref, { ...request, gatewayRetries: 1 }), { kind: 'stopped', reason: 'invalid_input' })
    assert.equal(A.requests.length + B.requests.length, 0)
    const result = await f.executor.run(one.ref, request)
    assert.equal(result.kind, 'completed', JSON.stringify(result))
    assert.equal(result.text, 'verified replacement')
    assert.equal(A.requests.length, 1)
    assert.equal(B.requests.length, 1)
    assert.notEqual(A.requests[0].sessionId, B.requests[0].sessionId)
    assert.doesNotMatch(JSON.stringify(B.requests[0].messages), /abandoned partial/)
    assert.match(JSON.stringify(B.requests[0].messages), /verified-effect-receipt/)
    assert.equal(effectsDispatched, 1)
    assert.deepEqual(assemblies.slice(0, 2).map(value => value.effects[0].operationId), ['effect-fallback', 'effect-fallback'])
    assert.deepEqual(f.ledger.history(one.ref, request.initial.attempt.id).map(row => [row.status, row.budgetStatus, row.partial]), [
      ['interrupted', 'uncertain', true], ['completed', 'settled', true],
    ])
    assert.equal(store.getWork(one.ref).task.version, one.state.task.version)

    clock = atTime(61_000)
    const two = await seed(store, 'wait', now)
    const parked = execution(two, now)
    allowReplacement = false
    const wait = await f.executor.run(two.ref, parked)
    assert.equal(wait.kind, 'waiting_resource', JSON.stringify(wait))
    assert.equal(wait.nextCheckAt, atTime(81_000))
    store.close()
    store = openWorkStore(root)
    f = attach()
    const durable = store.getWork(two.ref)
    assert.equal(durable.task.status, 'waiting_resource')
    assert.equal(durable.task.wait.referenceId, wait.referenceId)
    allowReplacement = true
    const continuation = { ...parked, continuation: true, expectedVersion: durable.task.version }
    assert.deepEqual(await f.executor.run(two.ref, continuation), { kind: 'stopped', reason: 'condition_unmet' })
    clock = atTime(81_000)
    const resumed = await f.executor.run(two.ref, continuation)
    assert.equal(resumed.kind, 'completed', JSON.stringify(resumed))
    assert.equal(resumed.text, 'verified replacement')
    assert.equal(A.requests.length, 2)
    assert.equal(B.requests.length, 2)
    assert.equal(store.getWork(two.ref).attempt.id, two.state.attempt.id)
    assert.deepEqual(store.getWork(two.ref).task.acceptance, two.state.task.acceptance)

    store.close()
    store = openWorkStore(join(process.cwd(), 'free-work'))
    f = attach(0, true)
    const free = await seed(store, 'free', now)
    const denied = execution(free, now)
    denied.fallback = { owner: 'core', maxAttempts: 3, chains: {}, terminal: [b] }
    denied.candidates = [{ ...replacement, deployment: { ...replacement.deployment, destination: { kind: 'local' } } }]
    const freeResult = await f.executor.run(free.ref, denied)
    assert.equal(freeResult.kind, 'completed', JSON.stringify(freeResult))
    assert.equal(A.requests.length, 2)
    assert.equal(B.requests.length, 3)
    assert.deepEqual(f.ledger.history(free.ref, denied.initial.attempt.id).map(row => [row.status, row.budgetStatus]), [
      ['denied', null], ['completed', 'settled'],
    ])

    store.close()
    store = openWorkStore(join(process.cwd(), 'retry-work'))
    f = attach()
    const fixed = await seed(store, 'retry', now)
    const retry = execution(fixed, now)
    retry.initial.policy = { ...pin, mode: 'fixed', deployment: a }
    retry.initial.decision.basis = 'fixed'
    retry.candidates = []
    retry.fallback = { owner: 'core', maxAttempts: 2, chains: {} }
    const fixedWait = await f.executor.run(fixed.ref, retry)
    assert.equal(fixedWait.kind, 'waiting_resource', JSON.stringify(fixedWait))
    assert.equal(fixedWait.nextCheckAt, atTime(101_000))
    const exact = { ...retry, continuation: true, expectedVersion: store.getWork(fixed.ref).task.version }
    assert.equal((await f.executor.run(fixed.ref, exact)).kind, 'waiting_resource')
    assert.equal(A.requests.length, 3)
    clock = atTime(101_000)
    A.fail = false
    const retried = await f.executor.run(fixed.ref, exact)
    assert.equal(retried.kind, 'completed', JSON.stringify(retried))
    assert.equal(A.requests.length, 4)
    assert.notEqual(A.requests[2].sessionId, A.requests[3].sessionId)
    assert.doesNotMatch(JSON.stringify(A.requests[3].messages), /abandoned partial/)

    const injected = await seed(store, 'injected', now)
    const remove = ctx.on('agent/created', ({ agent }) => {
      if (agent.id.startsWith('dshpa-inference-')) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'unapproved native input' }], source: { kind: 'user' } }))
      }
    })
    try {
      const deniedInput = await f.executor.run(injected.ref, execution(injected, now))
      assert.deepEqual(deniedInput, { kind: 'stopped', reason: 'authorization' })
      assert.equal(A.requests.length, 4)
    } finally { remove() }
  } finally { store.close() }
}

async function crashAndRecover(ctx, phase) {
  const crash = phase === 'inference-crash'
  const A = new Adapter(first.deployment.provider, true, crash)
  const B = new Adapter(replacement.deployment.provider, false)
  ctx.llm.registerAdapter([A.provider], A)
  ctx.llm.registerAdapter([B.provider], B)
  const store = openWorkStore(join(process.cwd(), 'crash-work'))
  const file = join(process.cwd(), 'approved-inference.json')
  const now = () => crash ? at : atTime(120_000)
  try {
    const pricing = { kind: 'known', inputMicrosPerMillion: 1, outputMicrosPerMillion: 1,
      cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0, ceilingMicros: 20 }
    const budget = store.createBudget({ now, pricingVersion: 'fixture',
      routes: [A, B].map(adapter => ({ provider: adapter.provider, model: 'fixture', currency: 'USD', pricing })),
      limits: [{ currency: 'USD', ownerDayMicros: 100, taskMicros: 40, maxCallsPerDay: 10, maxCallsPerTask: 5, maxConcurrent: 3 }],
    })
    const quota = { now, allowBoundedUnknown: true }
    const executor = ctx.dshpa.host.createInferenceExecutor({ store, budget, quota, now, authority: {
      authorize: () => true, assemble: async (_ref, _decision, effects) =>
        'Fresh authorized evidence. ' + effects.map(effect => effect.receipt.providerReceiptId).join(', '),
    } })
    if (crash) {
      const work = await seed(store, 'crash', now, () => {})
      const request = execution(work, now)
      writeFileSync(file, JSON.stringify({ ref: work.ref, request }))
      const result = await executor.run(work.ref, request)
      assert.fail('Expected process exit during partial stream: ' + JSON.stringify(result))
    }
    const { ref, request } = JSON.parse(readFileSync(file, 'utf8'))
    const ledger = store.createInferenceLedger(quota)
    const prior = ledger.get(ref, request.initial.attempt.id)
    assert.equal(prior.status, 'interrupted')
    assert.equal(prior.budgetStatus, 'uncertain')
    assert.equal(prior.partial, true)
    assert.equal(store.getEffect(ref, 'effect-crash').status, 'confirmed')
    assert.equal(A.requests.length, 0)
    const result = await executor.run(ref, request)
    assert.equal(result.kind, 'completed', JSON.stringify(result))
    assert.equal(result.text, 'verified replacement')
    assert.equal(A.requests.length, 0)
    assert.equal(B.requests.length, 1)
    assert.doesNotMatch(JSON.stringify(B.requests[0].messages), /abandoned partial/)
    assert.match(JSON.stringify(B.requests[0].messages), /verified-effect-receipt/)
    assert.equal(store.getEffect(ref, 'effect-crash').status, 'confirmed')
    assert.equal(ledger.get(ref, request.initial.attempt.id).budgetStatus, 'uncertain')
  } finally { store.close() }
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    const phase = process.env.DSHPA_CONTRACT_PHASE
    const operation = phase === 'inference-crash' || phase === 'inference-recover' ? crashAndRecover(ctx, phase) : exercise(ctx)
    void operation.then(() => {
      console.log(phase === 'inference-recover' ? 'PA042_NATIVE_INFERENCE recovered' : 'PA042_NATIVE_INFERENCE fallback wait receipts')
      ctx.appExit(0)
    },
      error => { console.error(error); ctx.appExit(1) })
  }))
}
