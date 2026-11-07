import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createIdentityBoundary } from './node_modules/@mosbot-ai/dshpa/lib/policy/identity.js'
import { authenticateEvent } from './node_modules/@mosbot-ai/dshpa/lib/runtime/intake.js'
import { createDshRoutingAssessor } from './node_modules/@mosbot-ai/dshpa/lib/runtime/routing-model.js'
import { openWorkStore } from './node_modules/@mosbot-ai/dshpa/lib/storage/store.js'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'dshpa', 'agents', 'llm']

const scope = { ownerId: 'pa013-owner', profileId: 'pa013-profile' }
const actor = { role: 'owner', ...scope, clientId: 'pa013-client', deviceId: 'pa013-device', policyVersion: 'p1' }
const provider = 'pa013-fixture'
const at = '2026-11-07T08:00:00.000Z'
const projectId = 'pa013-project'
const cwd = realpathSync(process.cwd())
const models = ['known', 'unknown', 'rate', 'rate-missing', 'rate-long', 'rate-overflow', 'rate-redirect', 'rate-router',
  'slow', 'tool', 'turn', 'oversize', 'over-output', 'router']
const limits = { maxInputBytes: 32_768, maxOutputTokens: 128, maxTurns: 2, maxStepsPerTurn: 1, maxWallTimeMs: 500 }
const usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 17 }
const local = {
  kind: 'known', inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
  cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0, ceilingMicros: 0,
}

function* reply(text, observedUsage = usage) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: observedUsage }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function attachModel(ctx) {
  const calls = new Map()
  const redirected = Promise.withResolvers()
  let sawTimeoutAbort = false
  class Model extends LlmAdapter {
    async *stream(options) {
      const key = `${options.purpose ?? 'native'}:${options.model}`
      calls.set(key, (calls.get(key) ?? 0) + 1)
      assert.equal(options.maxTokens, limits.maxOutputTokens)
      assert.equal(options.tools?.length ?? 0, 0)
      if (options.model.startsWith('rate')) {
        if (options.model === 'rate-redirect') await redirected.promise
        const retry = { rate: 50, 'rate-long': 7_200_000, 'rate-overflow': 1e40,
          'rate-redirect': 60_000, 'rate-router': 60_000 }[options.model]
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'RATE_LIMIT', status: 429, message: 'Fixture provider rate limit',
          ...(retry === undefined ? {} : { providerRetryAfterMs: retry }),
        } } }
        return
      }
      if (options.purpose === 'dshpa-routing') {
        yield* reply('[{"id":"candidate","kind":"ignore"}]')
        return
      }
      if (options.model === 'slow') {
        const signal = options.signal
        assert.ok(signal)
        const aborted = Promise.withResolvers()
        const onAbort = () => { sawTimeoutAbort = true; aborted.resolve() }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
        try {
          await aborted.promise
          throw new Error('Fixture stream cancelled by its wall-time limit')
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      }
      if (options.model === 'tool') {
        const block = { type: 'tool-call', id: 'fixture-call', name: 'bash', arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = options.messages.flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      const cursor = [...text.matchAll(/Include "cursor": "([^"]+)"/g)].at(-1)?.[1]
      assert.ok(cursor, 'Fixture input has a trusted report cursor')
      const report = options.model === 'unknown' || options.model === 'turn'
        ? { kind: 'progress', cursor, summary: 'Bounded manual work.' }
        : { kind: 'ready', cursor, summary: 'Metered fixture result.', artifactIds: [] }
      const observed = options.model === 'over-output' ? { ...usage, outputTokens: 129, totalTokens: 142 } : usage
      yield* reply(JSON.stringify(report), observed)
    }
  }
  ctx.llm.registerAdapter([provider], new Model())
  return {
    count(model, purpose = 'native') { return calls.get(`${purpose}:${model}`) ?? 0 },
    releaseRedirect() { redirected.resolve() },
    sawTimeoutAbort() { return sawTimeoutAbort },
  }
}

function requireWork(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.state
}

async function eventually(observe, message) {
  const until = performance.now() + 3_500
  do {
    const value = observe()
    if (value) return value
    await delay(5)
  } while (performance.now() < until)
  assert.fail(message)
}

async function run(ctx, store) {
  const seen = attachModel(ctx)
  store.insertProject({
    id: projectId, ...scope, kind: 'project', title: 'PA-013 metering fixture',
    purpose: 'Check the actual native provider boundary.', resourceRefs: [], status: 'active',
    successCriteria: ['No provider request bypasses local policy.'], planRevision: 1, milestones: [],
  })
  const budget = store.createBudget({
    pricingVersion: 'fixture-v1',
    routes: models.map(model => ({
      provider, model,
      currency: model === 'known' ? 'USD' : null,
      pricing: model === 'unknown' ? { kind: 'unknown' } : model === 'known' ? {
        kind: 'known', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000,
        cacheReadMicrosPerMillion: 1_000_000, cacheWriteMicrosPerMillion: 1_000_000, ceilingMicros: 5_000,
      } : local,
    })),
    limits: [
      { currency: 'USD', ownerDayMicros: 5_000, taskMicros: 5_000, maxCallsPerDay: 20, maxCallsPerTask: 5, maxConcurrent: 2 },
      { currency: null, ownerDayMicros: 0, taskMicros: 0, maxCallsPerDay: 20, maxCallsPerTask: 5, maxConcurrent: 2 },
    ],
    now: () => at,
  })
  const executor = ctx.dshpa.host.createWorkerExecutor({
    store,
    presets: models.map(model => ({ id: model, rootDirectory: cwd, provider, model, dataScope: ['fixture'] })),
    concurrency: 2, now: () => at,
    compute: { budget, limits },
    onProgress() { throw new Error('Attention fixture unavailable') },
  })

  async function launch(label, model, text = 'Run the bounded model fixture.') {
    const ref = { ...scope, taskId: `task-${label}` }
    const queued = requireWork(store.applyCommand({
      type: 'work.create', commandId: `create-${label}`,
      payload: { projectId, requestedOutcome: `Run the ${label} fixture.`, constraints: [],
        acceptance: { criteria: ['Model request is metered.'], requiresArtifact: false, requiresReceipt: false } },
    }, {
      actor, at, projectId, newTaskId: ref.taskId,
      newAttempt: { id: `attempt-${label}`, mandate: { id: `mandate-${label}`, ...scope, policyVersion: 'p1' } },
    }))
    requireWork(await executor.launch(ref, {
      expectedVersion: queued.task.version, presetId: model, cwd, dataScope: ['fixture'],
      input: { cursor: `cursor-${label}`, text },
    }))
    return ref
  }

  async function waitFor(ref, code) {
    await eventually(() => executor.query(ref).state?.task.status === 'waiting_resource', `Missing ${code} wait`)
    assert.equal(await executor.waitForRelease(ref), true)
    assert.equal(executor.query(ref).issue, code)
    assert.equal(executor.query(ref).active, false)
  }

  try {
    const known = await launch('known', 'known')
    await eventually(() => executor.query(known).state?.task.status === 'verifying', 'Missing known result')
    assert.equal(await executor.waitForRelease(known), true)
    assert.equal(seen.count('known'), 1)
    const usd = budget.snapshot(scope).currencies.find(row => row.currency === 'USD')
    assert.equal(usd?.spentMicros, 17)
    assert.equal(usd?.claimedCalls, 0)
    assert.equal(usd?.unknownCostCalls, 0)

    const denied = await launch('denied', 'known')
    await waitFor(denied, 'budget_exceeded')
    assert.equal(seen.count('known'), 1, 'Budget denial must not enter the provider')
    assert.equal(executor.canStart(denied, 'known'), false)

    const manual = await launch('manual', 'unknown')
    await eventually(() => executor.query(manual).report?.kind === 'progress', 'Manual unknown work did not run')
    assert.equal(seen.count('unknown'), 1)
    assert.equal(executor.query(manual).issue, 'attention_unavailable')
    const running = store.getWork(manual)
    assert.equal(running?.task.status, 'running', 'Attention callback failure must not stop the Worker')
    const identity = createIdentityBoundary(id => id === scope.profileId ? {
      id, ownerId: scope.ownerId, policyVersion: 'p1',
      verifiedAccounts: [{ sourceInstanceId: 'source', accountId: 'account', verifiedAt: at }], verifiedDevices: [],
    } : undefined)
    const source = identity.bindSource({ ...scope, sourceInstanceId: 'source', accountId: 'account' })
    const observation = authenticateEvent(identity, source, {
      kind: 'event', projectId, text: 'An unattended subscribed observation.', dataScope: ['fixture'],
      externalEventId: 'subscription', externalRevision: '1', threadId: 'thread', occurredAt: at,
      actorKind: 'service', externalActorId: 'verified-fixture',
    }, at)
    assert.equal(observation.ok, true)
    const subscription = store.putSubscription({
      ...scope, sourceInstanceId: 'source', accountId: 'account', threadId: 'thread', taskId: manual.taskId,
      projectId, mode: 'work', enabled: true, authority: observation.authority, updatedAt: at,
    })
    assert.equal(subscription.ok, true)
    const saved = store.recordRoutingEvent(observation.event, observation.digest, { projectId, authority: observation.authority })
    assert.equal(saved.ok, true)
    requireWork(executor.deliverSubscribed(manual, {
      expectedVersion: running.task.version, generation: running.task.generation, dataScope: ['fixture'],
      input: { cursor: observation.event.id, text: observation.body.text },
      route: { eventId: observation.event.id, expectedReceiptVersion: saved.receipt.version, projectId,
        subscriptionVersion: subscription.subscription.version, mode: 'work', authority: observation.authority },
    }, () => true))
    await waitFor(manual, 'price_unknown')
    assert.equal(seen.count('unknown'), 1, 'Subscribed unknown-price input must be denied even on an existing manual Worker')

    const rate = await launch('rate', 'rate')
    await waitFor(rate, 'provider_rate_limited')
    assert.equal(seen.count('rate'), 1, 'Composed native retry must not repeat an admitted request')
    const rateWait = store.getWork(rate)
    assert.equal(rateWait.task.wait.notBefore, '2026-11-07T08:00:00.050Z')
    const wake = {
      type: 'wake', expectedVersion: rateWait.task.version, attemptId: rateWait.attempt.id,
      generation: rateWait.attempt.generation, reason: 'resource', referenceId: rateWait.task.wait.referenceId,
      policyVersion: 'p1', grantsCurrent: true, budgetAvailable: true, conditionSatisfied: true, runtimeQuiescent: true,
    }
    assert.deepEqual(store.applyEvent(rate, { ...wake, at }), { ok: false, code: 'condition_unmet' })
    assert.equal(requireWork(store.applyEvent(rate, { ...wake, at: rateWait.task.wait.notBefore })).task.status, 'queued')
    assert.equal(seen.count('rate'), 1, 'An authorized wake requeues without automatic paid work')

    const missing = await launch('rate-missing', 'rate-missing')
    await waitFor(missing, 'provider_rate_limited')
    assert.equal(store.getWork(missing).task.wait.notBefore, '2026-11-07T08:01:00.000Z')
    assert.equal(seen.count('rate-missing'), 1)

    const long = await launch('rate-long', 'rate-long')
    await waitFor(long, 'provider_rate_limited')
    assert.equal(store.getWork(long).task.wait.notBefore, '2026-11-07T10:00:00.000Z')

    const overflow = await launch('rate-overflow', 'rate-overflow')
    await waitFor(overflow, 'provider_rate_limited')
    assert.equal(store.getWork(overflow).task.wait.notBefore, '9999-12-31T23:59:59.999Z')

    const redirect = await launch('rate-redirect', 'rate-redirect')
    await eventually(() => seen.count('rate-redirect') === 1, 'The first redirected fixture stream did not start')
    requireWork(executor.redirect(redirect, store.getWork(redirect).task.version, { cursor: 'after-429', text: 'Continue.' }))
    seen.releaseRedirect()
    await waitFor(redirect, 'provider_rate_limited')
    assert.equal(seen.count('rate-redirect'), 1, 'A 429 must fence the newer queued redirect before provider handoff')

    const slow = await launch('slow', 'slow')
    await waitFor(slow, 'compute_limit')
    assert.equal(seen.count('slow'), 1)
    assert.equal(seen.sawTimeoutAbort(), true)

    const tool = await launch('tool', 'tool')
    await waitFor(tool, 'compute_limit')
    assert.equal(seen.count('tool'), 1, 'Tool-induced continuation must obey the native step cap')

    const turns = await launch('turn', 'turn')
    await eventually(() => executor.query(turns).report?.cursor === 'cursor-turn', 'Initial turn did not finish')
    requireWork(executor.redirect(turns, store.getWork(turns).task.version, { cursor: 'turn-two', text: 'Continue.' }))
    await eventually(() => executor.query(turns).report?.cursor === 'turn-two', 'Second turn did not finish')
    requireWork(executor.redirect(turns, store.getWork(turns).task.version, { cursor: 'turn-three', text: 'Continue again.' }))
    await waitFor(turns, 'turn_limit')
    assert.equal(seen.count('turn'), 2, 'The turn cap must reject the third provider request')
    const exhausted = store.getWork(turns)
    assert.equal(exhausted.task.wait.notBefore, '9999-12-31T23:59:59.999Z')
    assert.deepEqual(store.applyEvent(turns, { ...wake, expectedVersion: exhausted.task.version,
      attemptId: exhausted.attempt.id, generation: exhausted.attempt.generation,
      referenceId: exhausted.task.wait.referenceId, at: exhausted.task.wait.notBefore,
    }), { ok: false, code: 'condition_unmet' })

    const oversize = await launch('oversize', 'oversize', 'x'.repeat(40_000))
    await waitFor(oversize, 'compute_limit')
    assert.equal(seen.count('oversize'), 0, 'The serialized input cap must apply before model handoff')

    const overOutput = await launch('over-output', 'over-output')
    await waitFor(overOutput, 'compute_limit')
    assert.equal(seen.count('over-output'), 1, 'Over-limit usage withholds a result after actual provider handoff')
    assert.deepEqual(executor.snapshot(), { active: 0, limit: 2 })

    const route = (model) => createDshRoutingAssessor(ctx.llm, { provider, model }, { budget, ...scope, limits })
    const signal = new AbortController().signal
    const batch = [{ id: 'candidate', text: 'Scoped Router candidate.', kind: 'candidate' }]
    await assert.rejects(route('unknown')(batch, signal))
    assert.equal(seen.count('unknown', 'dshpa-routing'), 0)
    await assert.rejects(route('rate-missing')(batch, signal))
    assert.equal(seen.count('rate-missing', 'dshpa-routing'), 0, 'Worker and Router share the same route cooldown')
    await assert.rejects(route('rate-router')(batch, signal))
    await assert.rejects(route('rate-router')(batch, signal))
    assert.equal(seen.count('rate-router', 'dshpa-routing'), 1, 'The next assessment cannot claim during the Router cooldown')
    assert.deepEqual(await route('router')(batch, signal), [{ id: 'candidate', kind: 'ignore' }])
    assert.equal(seen.count('router', 'dshpa-routing'), 1)
    const totals = budget.snapshot(scope).currencies.find(row => row.currency === null)
    assert.equal(totals?.unknownCostCalls, 1)
    assert.equal(totals?.uncertainCalls, 7)
    assert.equal(totals?.claimedCalls, 0)
  } finally {
    seen.releaseRedirect()
    assert.equal(await executor.close(), true)
  }
  console.log('PA013_PINNED_COMPUTE_GATES_PASS')
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    const store = openWorkStore(join(process.env.DSH_HOME, 'pa013-compute-store'))
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
