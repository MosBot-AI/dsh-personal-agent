import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { openWorkStore } from './node_modules/@mosbot-ai/dshpa/lib/storage/store.js'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter, LlmError } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'agents', 'dshpa', 'jobs', 'llm']

const at = '2026-11-07T08:00:00.000Z'
const scope = { ownerId: 'ops-fixture-owner', profileId: 'ops-fixture-profile' }
const actor = { role: 'owner', ...scope, clientId: 'ops-fixture-client', deviceId: 'ops-fixture-device', policyVersion: 'ops-v1' }
const provider = 'pa021-fixture'
const projectId = 'ops-fixture-project'
const privateMarker = 'private fixture provider content'
const cwd = realpathSync(process.cwd())
const credentialFailures = new Map([
  ['missing-credential', 'MISSING_CREDENTIAL'],
  ['invalid-credential', 'INVALID_CREDENTIAL'],
  ['account-sign-in', 'ACCOUNT_SIGN_IN_REQUIRED'],
])
const models = ['healthy', 'auth-prepare', 'auth-stream', ...credentialFailures.keys(),
  'http-outage', 'transport', 'invalid-model', 'late', 'tools']
const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }

function* finish(status, code, providerRetryAfterMs) {
  yield { type: 'finish', reason: { kind: 'error', failure: { status, code, message: privateMarker, providerRetryAfterMs } } }
}

function* reply(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function attachAdapter(ctx) {
  const calls = new Map()
  const preparations = new Map()
  const healthy = Promise.withResolvers()
  const transport = Promise.withResolvers()
  let healthySignal
  class Fixture extends LlmAdapter {
    async prepareCall(provider, model, signal) {
      preparations.set(model, (preparations.get(model) ?? 0) + 1)
      if (model === 'auth-prepare') throw new LlmError(privateMarker, 'AUTH', { status: 401 })
      if (model === 'invalid-model') throw new LlmError(privateMarker, 'UNKNOWN_MODEL')
      return super.prepareCall(provider, model, signal)
    }

    async *stream(options) {
      calls.set(options.model, (calls.get(options.model) ?? 0) + 1)
      assert.equal(options.tools?.length ?? 0, 0)
      if (options.model === 'auth-stream') { yield* finish(403, 'FORBIDDEN'); return }
      const credentialFailure = credentialFailures.get(options.model)
      if (credentialFailure) { yield* finish(undefined, credentialFailure); return }
      if (options.model === 'http-outage') { yield* finish(503, 'HTTP_503', 120_000); return }
      if (options.model === 'transport') {
        await transport.promise
        throw new LlmError(privateMarker, 'TRANSPORT')
      }
      if (options.model === 'late') {
        if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
        yield* finish(503, 'SERVER')
        return
      }
      if (options.model === 'tools') {
        for (const index of [0, 1]) {
          const block = { type: 'tool-call', id: `fixture-${index}`, name: 'bash', arguments: JSON.stringify({ value: privateMarker }) }
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
          yield { type: 'block-end', index, block }
        }
        yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      assert.equal(options.model, 'healthy')
      healthySignal = options.signal
      await healthy.promise
      const text = options.messages.flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      const cursor = [...text.matchAll(/Include "cursor": "([^"]+)"/g)].at(-1)?.[1]
      yield* reply(JSON.stringify({ kind: 'progress', cursor, summary: 'Ordinary fixture progress.' }))
    }
  }
  ctx.llm.registerAdapter([provider], new Fixture())
  return { calls, preparations, healthy, transport, healthySignal: () => healthySignal }
}

async function eventually(test, description) {
  const deadline = performance.now() + 3_000
  do {
    const observed = test()
    if (observed) return observed
    await delay(5)
  } while (performance.now() < deadline)
  assert.fail(description)
}

function success(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.state
}

async function run(ctx, store) {
  const seen = attachAdapter(ctx)
  ctx.jobs.attachController('pa021-provider-fixture')
  store.insertProject({ id: projectId, ...scope, kind: 'project', title: 'Provider fixture', purpose: 'Verify resident outage handling.',
    resourceRefs: [], status: 'active', successCriteria: ['Faults stay scoped.'], planRevision: 1, milestones: [] })
  const budget = store.createBudget({ pricingVersion: 'ops-v1', now: () => at,
    routes: models.map(model => ({ provider, model, currency: null, pricing: { kind: 'known', ceilingMicros: 0,
      inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 } })),
    limits: [{ currency: null, ownerDayMicros: 0, taskMicros: 0, maxCallsPerDay: 20, maxCallsPerTask: 4, maxConcurrent: 4 }],
  })
  const observations = []
  const executor = ctx.dshpa.host.createWorkerExecutor({
    store, concurrency: 4, now: () => at,
    presets: models.map(model => ({ id: model, rootDirectory: cwd, provider, model, dataScope: ['fixture'] })),
    compute: { budget, limits: { maxStepsPerTurn: 1, maxWallTimeMs: 10_000 } },
    onObservation(ref, state, observation) {
      observations.push({ ref, attemptId: state.attempt.id, generation: state.attempt.generation, observation })
    },
  })

  async function launch(model, label = model) {
    const ref = { ...scope, taskId: `task-${label}` }
    const task = success(store.applyCommand({ type: 'work.create', commandId: `create-${label}`, payload: {
      projectId, requestedOutcome: 'Run the keyless fixture.', constraints: [],
      acceptance: { criteria: ['Verify the boundary.'], requiresArtifact: false, requiresReceipt: false },
    } }, { actor, at, projectId, newTaskId: ref.taskId, newAttempt: { id: `attempt-${label}`,
      mandate: { id: `mandate-${label}`, ...scope, policyVersion: actor.policyVersion } } }))
    const running = success(await executor.launch(ref, {
      expectedVersion: task.task.version, presetId: model, cwd, dataScope: ['fixture'],
      input: { cursor: `cursor-${label}`, text: 'Run the isolated provider fixture.' },
    }))
    return { ref, running }
  }

  async function cancel(ref) {
    const current = store.getWork(ref)
    const cancelled = success(executor.cancel({ type: 'work.cancel', commandId: `cancel-${ref.taskId}`, taskId: ref.taskId,
      expectedVersion: current.task.version, payload: {} }, { actor, at, projectId }))
    assert.equal(cancelled.task.generation, current.task.generation + 1)
    assert.equal(await executor.waitForRelease(ref), true)
    assert.equal(store.getWork(ref).task.status, 'cancelled')
    assert.equal(store.getWork(ref).task.wait, undefined)
    assert.equal(observations.some(item => item.ref.taskId === ref.taskId && item.observation.kind === 'issue'), false)
  }

  async function awaitWait(ref, code, admitted, until = '2026-11-07T08:01:00.000Z') {
    const state = await eventually(() => {
      const { state } = executor.query(ref)
      return state?.task.status === 'waiting_resource' && state
    }, `Expected the ${code} resource wait`)
    assert.equal(await executor.waitForRelease(ref), true)
    assert.equal(executor.query(ref).issue, code)
    assert.equal(executor.query(ref).active, false)
    assert.equal(state.task.wait.notBefore, until)
    assert.match(state.task.wait.resumeCondition, admitted ? /input already admitted/ : /stopped before native Session admission/)
    assert.ok(!state.task.wait.resumeCondition.includes(privateMarker))
    assert.equal(ctx.agents.get(state.attempt.sessionId), undefined)
    assert.ok(store.getWork(ref).attempt.worker.releasedAt)
    return store.getWork(ref)
  }

  const ownedDone = Promise.withResolvers()
  try {
    const healthy = await launch('healthy')
    await eventually(() => seen.healthySignal(), 'Unrelated Worker did not reach its provider')
    const healthyAgent = ctx.agents.get(healthy.running.attempt.sessionId)
    const prepared = await launch('auth-prepare')
    await awaitWait(prepared.ref, 'provider_authentication', false)
    assert.equal(seen.preparations.get('auth-prepare'), 1)
    assert.equal(seen.calls.has('auth-prepare'), false)
    assert.equal(budget.snapshot(scope).currencies[0].uncertainCalls, 0)

    const stream = await launch('auth-stream')
    const parked = await awaitWait(stream.ref, 'provider_authentication', true)
    assert.equal(seen.calls.get('auth-stream'), 1)
    for (const model of credentialFailures.keys()) {
      const { ref } = await launch(model)
      const waiting = await awaitWait(ref, 'provider_authentication', true)
      assert.match(waiting.task.wait.resumeCondition, /Verify model provider authorization/)
      assert.equal(seen.calls.get(model), 1)
    }
    const repeated = await launch('missing-credential', 'missing-credential-cooldown')
    await eventually(() => executor.query(repeated.ref).state?.task.status === 'waiting_resource',
      'Same-route credential cooldown did not park the next Worker')
    assert.equal(await executor.waitForRelease(repeated.ref), true)
    assert.equal(executor.query(repeated.ref).issue, 'provider_authentication')
    assert.equal(seen.calls.get('missing-credential'), 1)
    const wake = { type: 'wake', at, expectedVersion: parked.task.version, attemptId: parked.attempt.id,
      generation: parked.attempt.generation, reason: 'resource', referenceId: parked.task.wait.referenceId,
      policyVersion: actor.policyVersion, grantsCurrent: true, budgetAvailable: true, conditionSatisfied: true, runtimeQuiescent: true }
    assert.deepEqual(store.applyEvent(stream.ref, wake), { ok: false, code: 'condition_unmet' })

    const unavailable = await launch('http-outage')
    await awaitWait(unavailable.ref, 'provider_unavailable', true, '2026-11-07T08:02:00.000Z')
    assert.equal(seen.calls.get('http-outage'), 1)

    const transport = await launch('transport')
    await eventually(() => seen.calls.has('transport'), 'Transport Worker did not reach its provider')
    let stopRequested = false
    ctx.jobs.start({ kind: 'bash', owner: transport.running.attempt.sessionId, label: 'Provider fixture cleanup barrier',
      run: () => ({ cancel() { stopRequested = true }, done: ownedDone.promise }) })
    seen.transport.resolve()
    await eventually(() => stopRequested, 'The failed Worker did not stop its owned job')
    assert.equal(executor.query(transport.ref).state.task.status, 'waiting_resource')
    assert.equal(executor.query(transport.ref).active, true, 'An unquiesced Worker must retain its slot')
    assert.equal(ctx.agents.get(healthy.running.attempt.sessionId), healthyAgent)
    assert.equal(seen.healthySignal().aborted, false)
    ownedDone.resolve({ status: 'killed' })
    await awaitWait(transport.ref, 'provider_unavailable', true)

    const rejected = await launch('invalid-model')
    await awaitWait(rejected.ref, 'provider_rejected', false)
    assert.equal(seen.calls.has('invalid-model'), false)

    const late = await launch('late')
    await eventually(() => seen.calls.has('late'), 'Cancellation Worker did not reach its provider')
    await cancel(late.ref)
    const sameRoute = await launch('late', 'unrelated-same-route')
    await eventually(() => seen.calls.get('late') === 2, 'A cancelled Worker poisoned a separate attempt on the same route')
    await cancel(sameRoute.ref)

    const tool = await launch('tools')
    await eventually(() => executor.query(tool.ref).state?.task.status === 'waiting_resource', 'Tool step cap did not park the Worker')
    assert.equal(await executor.waitForRelease(tool.ref), true)
    const digests = observations.filter(item => item.ref.taskId === tool.ref.taskId && item.observation.kind === 'tool')
      .map(item => item.observation.digest)
    assert.equal(digests.length, 2)
    assert.match(digests[0], /^[a-f0-9]{64}$/)
    assert.equal(digests[0], digests[1])
    assert.ok(!JSON.stringify(observations).includes(privateMarker))

    assert.equal(seen.healthySignal().aborted, false)
    seen.healthy.resolve()
    await eventually(() => executor.query(healthy.ref).report?.kind === 'progress', 'The unrelated Worker did not complete its turn')
    assert.deepEqual(observations.filter(item => item.ref.taskId === healthy.ref.taskId).map(item => item.observation.kind),
      ['start', 'step', 'progress'])
    const totals = budget.snapshot(scope).currencies[0]
    assert.equal(totals.claimedCalls, 0)
    assert.equal(totals.uncertainCalls, 8)
    assert.equal(success(store.applyEvent(stream.ref, { ...wake, at: parked.task.wait.notBefore })).task.status, 'queued')
    assert.equal(seen.calls.get('auth-stream'), 1, 'An explicit wake requeues without replaying the admitted input')
  } finally {
    ownedDone.resolve({ status: 'killed' })
    seen.healthy.resolve()
    seen.transport.resolve()
    assert.equal(await executor.close(), true)
  }
  console.log('PA021_NATIVE_PROVIDER_PASS')
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    const store = openWorkStore(join(process.env.DSH_HOME, 'ops-provider-store'))
    void run(ctx, store).then(() => {
      store.close()
      ctx.appExit(0)
    }, error => {
      store.close()
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
