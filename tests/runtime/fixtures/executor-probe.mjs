import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { openWorkStore } from './node_modules/@mosbot-ai/dshpa/lib/storage/store.js'

const cliRequire = createRequire(process.argv[1])
const baseRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter, createUserMessage } = await import(
  pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-llm')).href
)

export const inject = ['appReady', 'appExit', 'dshpa', 'agents', 'agentLoop', 'llm', 'tools', 'jobs', 'subagents']

const scope = { ownerId: 'worker-owner', profileId: 'worker-profile' }
const actor = { role: 'owner', ...scope, clientId: 'worker-client', deviceId: 'worker-device', policyVersion: 'worker-policy' }
const projectId = 'worker-project'
const conversationId = 'worker-conversation'
const provider = 'dshpa-worker-fixture'
const model = 'scripted'
const presetId = 'model-only-fixture'
const dataScope = ['fixture-data']
const seededAt = '2026-11-01T00:00:00.000Z'
const wait = { reason: 'input', referenceId: 'owner-response', resumeCondition: 'Verified fixture owner response' }

function taskRef(label) {
  return { ...scope, taskId: `task-${label}` }
}

function mustSucceed(result, operation) {
  assert.equal(result.ok, true, `${operation}: ${JSON.stringify(result)}`)
  return result
}

function* answer(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function attachModel(ctx) {
  const scripts = new Map()
  class ScriptedModel extends LlmAdapter {
    async *stream(options) {
      const markers = options.messages.filter(message => message.role === 'user')
        .flatMap(message => message.content.filter(block => block.type === 'text')
          .flatMap(block => [...block.text.matchAll(/PA006_INPUT\[([a-z0-9-]+)\]/g)]))
      const marker = markers.at(-1)?.[1]
      const script = scripts.get(marker)
      assert.ok(script, `Missing fixture model script for ${marker}`)
      script.requests.push(options)
      const signal = options.signal
      assert.ok(signal)
      const aborted = Promise.withResolvers()
      const onAbort = () => {
        script.abortReason = signal.reason
        aborted.resolve(undefined)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      try {
        const text = await Promise.race([script.output.promise, aborted.promise])
        if (signal.aborted) throw new Error('Fixture model stream cancelled')
        yield* answer(text)
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    }
  }
  ctx.llm.registerAdapter([provider], new ScriptedModel())
  return label => {
    assert.ok(!scripts.has(label))
    const script = {
      input: { cursor: `cursor-${label}`, text: `PA006_INPUT[${label}] Run the fixture work.` },
      output: Promise.withResolvers(),
      requests: [],
      abortReason: undefined,
      report(kind, fields = {}) {
        this.output.resolve(JSON.stringify({
          kind, cursor: this.input.cursor, summary: `Fixture ${kind} report.`, ...fields,
        }))
      },
    }
    scripts.set(label, script)
    return script
  }
}

async function eventually(observe, description) {
  const until = performance.now() + 4_000
  do {
    const result = observe()
    if (result) return result
    await delay(5)
  } while (performance.now() < until)
  assert.fail(`Timed out waiting for ${description}`)
}

function startJob(ctx, owner, label, onStop = () => {}) {
  const settled = Promise.withResolvers()
  let stopRequested = false
  const id = ctx.jobs.start({
    kind: 'bash', owner, label,
    run() {
      return {
        cancel() {
          if (stopRequested) return
          stopRequested = true
          onStop()
        },
        done: settled.promise,
      }
    },
  })
  return {
    id,
    get stopRequested() { return stopRequested },
    finish(status = 'completed') { settled.resolve({ status }) },
  }
}

async function startChild(ctx, parent) {
  const result = Promise.withResolvers()
  const cleanup = Promise.withResolvers()
  let disposing = false
  let abortReason
  ctx.subagents.registerProvider({
    name: 'pa006-test-child',
    inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start({ signal }) {
      signal.addEventListener('abort', () => {
        abortReason = signal.reason
        result.resolve({ output: [], stopReason: 'aborted' })
      }, { once: true })
      return {
        id: 'pa006-fixture-owned-child',
        result: result.promise,
        async dispose() {
          disposing = true
          await cleanup.promise
        },
      }
    },
  })
  const activation = await ctx.subagents.startActivation({
    provider: 'pa006-test-child', delivery: 'caller', label: 'PA-006 fixture child',
    signal: new AbortController().signal,
    request: { parent, prompt: [{ type: 'text', text: 'Wait for fixture release.' }] },
  })
  return {
    activation,
    get disposing() { return disposing },
    get abortReason() { return abortReason },
    settle() { result.resolve({ output: [], stopReason: 'completed' }) },
    release() { cleanup.resolve() },
  }
}

function fixture(ctx, phase) {
  const stateDirectory = join(process.env.DSH_HOME, 'worker-state')
  const workspaceRoot = join(process.env.DSH_HOME, 'worker-workspaces')
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })
  const rootDirectory = realpathSync(workspaceRoot)
  const store = openWorkStore(stateDirectory)
  if (phase !== 'resume') {
    store.insertProject({
      id: projectId, ...scope, kind: 'project', title: 'Worker contract', purpose: 'Verify native worker ownership.',
      resourceRefs: [], status: 'active', successCriteria: ['Verify ownership.'], planRevision: 1, milestones: [],
    })
    store.insertConversation({
      id: conversationId, ...scope, sessionIds: [],
      originalDestination: { sourceInstanceId: 'fixture-source', externalDestinationId: 'fixture-thread' },
    })
  }
  const executor = ctx.dshpa.host.createWorkerExecutor({
    store, concurrency: phase === 'controls' ? 4 : 1,
    presets: [
      { id: presetId, rootDirectory, provider, model, dataScope },
      { id: 'other-preset', rootDirectory, provider, model, dataScope },
    ],
  })
  const script = attachModel(ctx)
  ctx.jobs.attachController('pa006-native-worker-test')
  return { rootDirectory, store, executor, script }
}

function seed(fixture, label) {
  const ref = taskRef(label)
  mkdirSync(join(fixture.rootDirectory, label), { recursive: true, mode: 0o700 })
  const created = fixture.store.applyCommand({
    type: 'work.create', commandId: `create-${label}`, conversationId,
    payload: {
      projectId, requestedOutcome: 'Return one verifiable artifact.', constraints: [],
      acceptance: { criteria: ['Check the artifact.'], requiresArtifact: true, requiresReceipt: false },
    },
  }, {
    actor, at: seededAt, projectId, conversationId, newTaskId: ref.taskId,
    newAttempt: {
      id: `attempt-${label}`, mandate: { id: `mandate-${label}`, ...scope, policyVersion: actor.policyVersion },
    },
  })
  return { ref, label, state: mustSucceed(created, 'create task').state }
}

function launchInput(seeded, script, options = {}) {
  return {
    expectedVersion: seeded.state.task.version, presetId, cwd: seeded.label, dataScope, input: script.input, ...options,
  }
}

async function launch(fixture, seeded, script, options) {
  const result = mustSucceed(await fixture.executor.launch(seeded.ref, launchInput(seeded, script, options)), 'launch worker')
  await eventually(() => script.requests[0], `${seeded.label} model request`)
  assert.deepEqual(script.requests[0].tools ?? [], [], 'Private worker must remain model-only')
  assert.equal(script.requests[0].model, model)
  return result.state
}

function current(fixture, ref) {
  const value = fixture.executor.query(ref)
  assert.ok(value.state, `Missing task ${ref.taskId}`)
  return value
}

function seal(fixture, ref, id, text) {
  const { state } = current(fixture, ref)
  return fixture.store.artifacts.seal(ref, {
    id,
    attemptId: state.attempt.id,
    generation: state.attempt.generation,
    expectedVersion: state.task.version,
    mediaType: 'text/plain',
    sourceEventIds: [],
    visibility: 'private',
    bytes: new TextEncoder().encode(text),
  })
}

function cancel(fixture, seeded) {
  const { state } = current(fixture, seeded.ref)
  return mustSucceed(fixture.executor.cancel({
    type: 'work.cancel', commandId: `cancel-${seeded.label}`,
    taskId: seeded.ref.taskId, expectedVersion: state.task.version, payload: {},
  }, { actor, at: state.task.updatedAt, projectId, conversationId }), 'cancel worker')
}

async function controls(ctx, fixture) {
  const { executor, script } = fixture
  const tasks = ['one', 'two', 'three', 'four', 'five'].map(label => seed(fixture, label))
  const initial = tasks.map(task => script(`start-${task.label}`))
  const [one, two, three, four, five] = tasks
  const redirected = script('redirected-one')
  const unsealed = script('unsealed-four')
  const progress = script('progress-four')
  const bare = script('bare-native-input')
  const failed = script('failed-four')
  const unrelatedScript = script('unrelated')
  const unrelated = await ctx.agents.create({
    sessionId: 'pa006-unrelated-native', agentOptions: { provider, model },
    meta: { cwd: fixture.rootDirectory },
  })
  unrelated.agent.followup(createUserMessage({
    content: [{ type: 'text', text: unrelatedScript.input.text }], source: { kind: 'user' },
  }))
  const unrelatedJob = startJob(ctx, unrelated.agent.id, 'Unrelated fixture job')
  const otherWorkerJobs = []
  let ownedJob
  let lateJob
  try {
    for (const options of [{ cwd: '..' }, { dataScope: ['unauthorized'] }]) {
      assert.deepEqual(await executor.launch(one.ref, launchInput(one, initial[0], options)),
        { ok: false, code: 'permission_denied' })
    }
    if (process.platform !== 'win32') {
      symlinkSync(process.env.DSH_HOME, join(fixture.rootDirectory, 'escaped-workspace'), 'dir')
      assert.deepEqual(await executor.launch(one.ref, launchInput(one, initial[0], { cwd: 'escaped-workspace' })),
        { ok: false, code: 'permission_denied' })
    }
    assert.equal(initial[0].requests.length, 0)
    const workers = await Promise.all(tasks.slice(0, 4).map((task, index) => launch(fixture, task, initial[index])))
    const owner = workers[1].attempt.sessionId
    ownedJob = startJob(ctx, owner, 'Job owned by the cancelled worker', () => {
      lateJob = startJob(ctx, owner, 'Late job from an owned cancellation callback')
    })
    for (const index of [0, 2, 3]) {
      const sessionId = workers[index].attempt.sessionId
      otherWorkerJobs.push({ sessionId, job: startJob(ctx, sessionId, 'Held worker job') })
    }
    await eventually(() => unrelatedScript.requests[0], 'unrelated native model request')
    assert.equal(new Set(workers.map(state => state.attempt.sessionId)).size, 4)
    assert.equal(new Set(workers.map(state => state.task.conversationId)).size, 1)
    assert.deepEqual(await executor.launch(five.ref, launchInput(five, initial[4])), { ok: false, code: 'capacity' })
    assert.equal(initial[4].requests.length, 0)
    assert.equal(current(fixture, five.ref).state.task.status, 'queued')
    assert.ok(tasks.slice(0, 4).every(task => current(fixture, task.ref).active))
    assert.equal(await executor.waitForRelease(one.ref), false)
    assert.equal(executor.query({ ...one.ref, profileId: 'other-profile' }).state, undefined)

    const oldVersion = workers[0].task.version
    const redirect = mustSucceed(executor.redirect(one.ref, oldVersion, redirected.input), 'redirect worker')
    assert.equal(redirect.state.attempt.worker.inputCursor, redirected.input.cursor)
    assert.deepEqual(executor.redirect(one.ref, oldVersion, { cursor: 'stale-redirect', text: 'Reject this.' }),
      { ok: false, code: 'version_conflict' })
    assert.deepEqual(executor.redirect(one.ref, redirect.state.task.version, redirected.input),
      { ok: false, code: 'duplicate_input' })
    assert.equal(initial[0].abortReason, undefined)
    initial[0].report('progress')
    await eventually(() => redirected.requests[0], 'redirected native model request')
    assert.match(JSON.stringify(redirected.requests[0].messages), /PA006_INPUT\[redirected-one\]/)
    assert.equal(current(fixture, one.ref).state.task.status, 'running')

    const cancelled = cancel(fixture, two)
    assert.equal(cancelled.state.task.status, 'cancelling')
    assert.equal(cancelled.state.task.generation, workers[1].task.generation + 1)
    await eventually(() => ownedJob.stopRequested, 'owned native job cancellation')
    assert.equal(ctx.jobs.get(ownedJob.id, workers[1].attempt.sessionId).status, 'stopping')
    assert.deepEqual(await executor.launch(five.ref, launchInput(five, initial[4])), { ok: false, code: 'capacity' })
    assert.equal(ctx.agents.get(unrelated.agent.id), unrelated.agent)
    assert.equal(unrelated.agent.status, 'running')
    assert.equal(ctx.jobs.get(unrelatedJob.id, unrelated.agent.id).status, 'running')
    assert.equal(unrelatedJob.stopRequested, false)
    assert.equal(unrelatedScript.abortReason, undefined)
    for (const { sessionId, job } of otherWorkerJobs) {
      assert.equal(ctx.jobs.get(job.id, sessionId).status, 'running')
      assert.equal(job.stopRequested, false)
    }
    assert.ok([one, three, four].every(task => current(fixture, task.ref).active))

    ownedJob.finish('killed')
    await eventually(() => lateJob?.stopRequested, 'late owned job cancellation')
    assert.deepEqual(await executor.launch(five.ref, launchInput(five, initial[4])), { ok: false, code: 'capacity' })
    lateJob.finish('killed')
    assert.equal(await executor.waitForRelease(two.ref), true)
    assert.equal(current(fixture, two.ref).state.task.status, 'cancelled')
    assert.equal(ctx.agents.get(workers[1].attempt.sessionId), undefined)
    assert.ok(initial[1].abortReason, 'The cancelled model stream must receive a native abort')
    await launch(fixture, five, initial[4])
    for (const { job } of otherWorkerJobs) job.finish()

    seal(fixture, one.ref, 'artifact-one', 'Evidence from the redirected worker.')
    seal(fixture, five.ref, 'artifact-five', 'Evidence from the worker admitted after cancellation.')
    redirected.report('ready', { artifactIds: ['artifact-one'] })
    initial[2].report('blocked', {
      wait: { reason: 'dependency', referenceId: one.ref.taskId, resumeCondition: 'Dependency completes' },
    })
    initial[4].report('ready', { artifactIds: ['artifact-five'] })
    initial[3].report('ready', { cursor: 'old-cursor', artifactIds: ['stale-artifact'] })
    await eventually(() => current(fixture, four.ref).issue === 'report_unavailable', 'stale cursor rejection')
    const afterStale = current(fixture, four.ref)
    assert.equal(afterStale.state.task.status, 'running')
    assert.deepEqual(afterStale.state.attempt.artifactIds, [])
    assert.equal(afterStale.active, true)
    mustSucceed(executor.redirect(four.ref, afterStale.state.task.version, unsealed.input), 'resume after stale report')
    await eventually(() => unsealed.requests[0], 'unsealed artifact model request')
    unsealed.report('ready', { artifactIds: ['missing-artifact'] })
    await eventually(() => current(fixture, four.ref).issue === 'acceptance_unsatisfied', 'unsealed readiness rejection')
    const afterUnsealed = current(fixture, four.ref)
    assert.equal(afterUnsealed.state.task.status, 'running')
    assert.equal(afterUnsealed.report, undefined)
    mustSucceed(executor.redirect(four.ref, afterUnsealed.state.task.version, progress.input), 'resume after unsealed report')
    await eventually(() => progress.requests[0], 'progress model request')
    progress.report('progress')
    await eventually(() => current(fixture, four.ref).report?.kind === 'progress', 'valid progress')
    const afterProgress = current(fixture, four.ref)
    assert.equal(afterProgress.state.task.status, 'running')
    assert.equal(afterProgress.active, true)
    const liveWorker = ctx.agents.get(afterProgress.state.attempt.sessionId)
    assert.ok(liveWorker)
    bare.report('ready', { cursor: progress.input.cursor, artifactIds: ['bare-artifact'] })
    for (const [method, source] of [
      ['followup', { kind: 'user' }],
      ['steer', { kind: 'dshpa-work-input', cursor: progress.input.cursor }],
    ]) {
      liveWorker[method](createUserMessage({
        content: [{ type: 'text', text: bare.input.text }], source,
      }))
      await liveWorker.whenIdle()
    }
    assert.equal(bare.requests.length, 0, 'Bare native input must not reach a private worker model')
    assert.deepEqual(current(fixture, four.ref).state, afterProgress.state)
    mustSucceed(executor.redirect(four.ref, afterProgress.state.task.version, failed.input), 'follow up after progress')
    await eventually(() => failed.requests[0], 'failure model request')
    failed.report('failed')
    for (const [task, status] of [[one, 'verifying'], [three, 'blocked'], [four, 'failed'], [five, 'verifying']]) {
      await eventually(() => current(fixture, task.ref).state.task.status === status, `${task.label} ${status}`)
      assert.equal(await executor.waitForRelease(task.ref), true)
    }
    assert.deepEqual(current(fixture, one.ref).state.attempt.artifactIds, ['artifact-one'])
    assert.equal(current(fixture, one.ref).state.attempt.outcome, undefined)
    assert.equal(ctx.jobs.get(unrelatedJob.id, unrelated.agent.id).status, 'running')
    assert.equal(unrelatedScript.abortReason, undefined)

    const opening = seed(fixture, 'startup')
    const openingScript = script('startup')
    const pendingLaunch = executor.launch(opening.ref, launchInput(opening, openingScript))
    const started = current(fixture, opening.ref).state
    assert.equal(started.task.status, 'running')
    assert.equal(cancel(fixture, opening).state.task.status, 'cancelling')
    assert.equal((await pendingLaunch).ok, false)
    assert.equal(await executor.waitForRelease(opening.ref), true)
    assert.equal(current(fixture, opening.ref).state.task.status, 'cancelled')
    assert.equal(ctx.agents.get(started.attempt.sessionId), undefined)
    assert.equal(openingScript.requests.length, 0)
  } finally {
    for (const { job } of otherWorkerJobs) job.finish()
    ownedJob?.finish('killed')
    lateJob?.finish('killed')
    unrelatedJob.finish()
    await unrelated.dispose()
  }
}

async function waitAndRelease(ctx, fixture) {
  const { executor, script } = fixture
  const seeded = seed(fixture, 'resume')
  const initial = script('initial-wait')
  const waitingScript = script('second-wait')
  const other = seed(fixture, 'capacity')
  const otherScript = script('capacity')
  const running = await launch(fixture, seeded, initial)
  mustSucceed(executor.redirect(seeded.ref, running.task.version, waitingScript.input), 'redirect before waiting')
  initial.report('progress')
  await eventually(() => waitingScript.requests[0], 'redirected input before waiting')
  const sessionId = running.attempt.sessionId
  const agent = ctx.agents.get(sessionId)
  assert.ok(agent)
  assert.equal(agent.session.header.cwd, join(fixture.rootDirectory, seeded.label))
  const job = startJob(ctx, sessionId, 'Owned wait fixture job')
  let child
  try {
    child = await startChild(ctx, agent)
    waitingScript.report('waiting', { wait })
    await eventually(() => current(fixture, seeded.ref).state.task.status === 'waiting_input', 'durable input wait')
    assert.deepEqual(current(fixture, seeded.ref).state.task.wait, wait)
    assert.equal(current(fixture, seeded.ref).active, true)
    assert.deepEqual(await executor.launch(other.ref, launchInput(other, otherScript)), { ok: false, code: 'capacity' })

    job.finish()
    await eventually(() => child.disposing, 'native child cleanup')
    assert.deepEqual(child.abortReason, { kind: 'parent' })
    assert.equal(current(fixture, seeded.ref).active, true)
    assert.deepEqual(await executor.launch(other.ref, launchInput(other, otherScript)), { ok: false, code: 'capacity' })
    child.release()
    assert.equal(await executor.waitForRelease(seeded.ref), true)
    assert.equal(ctx.agents.get(sessionId), undefined)
    assert.equal(otherScript.requests.length, 0)
    const saved = current(fixture, seeded.ref)
    assert.equal(saved.active, false)
    assert.deepEqual(saved.state.attempt.worker, {
      presetId, cwd: join(fixture.rootDirectory, seeded.label), provider, model, inputCursor: waitingScript.input.cursor,
      inputHistory: [initial.input.cursor, waitingScript.input.cursor],
    })
  } finally {
    job.finish()
    child?.settle()
    child?.release()
    await child?.activation.dispose()
  }
}

async function resume(ctx, fixture) {
  const { store, executor, script } = fixture
  const ref = taskRef('resume')
  const previous = current(fixture, ref).state
  assert.equal(previous.task.status, 'waiting_input')
  assert.equal(previous.attempt.worker.inputCursor, 'cursor-second-wait')
  assert.deepEqual(previous.attempt.worker.inputHistory, ['cursor-initial-wait', 'cursor-second-wait'])
  assert.equal(previous.attempt.worker.presetId, presetId)
  const wake = mustSucceed(store.applyEvent(ref, {
    type: 'wake', at: previous.task.updatedAt, expectedVersion: previous.task.version,
    attemptId: previous.attempt.id, generation: previous.attempt.generation,
    reason: wait.reason, referenceId: wait.referenceId, policyVersion: actor.policyVersion,
    conditionSatisfied: true, runtimeQuiescent: true, grantsCurrent: true, budgetAvailable: true,
  }), 'wake persisted wait')
  const seeded = { ref, label: 'resume', state: wake.state }
  for (const marker of ['initial-wait', 'second-wait']) {
    const duplicate = script(marker)
    assert.deepEqual(await executor.launch(ref, launchInput(seeded, duplicate)), { ok: false, code: 'duplicate_input' })
    assert.equal(duplicate.requests.length, 0)
  }
  const resumed = script('resumed')
  for (const options of [{ presetId: 'other-preset' }, { cwd: 'capacity' }]) {
    assert.deepEqual(await executor.launch(ref, launchInput(seeded, resumed, options)),
      { ok: false, code: 'permission_denied' })
  }
  assert.equal(resumed.requests.length, 0)

  const running = await launch(fixture, seeded, resumed)
  assert.equal(running.attempt.id, previous.attempt.id)
  assert.equal(running.attempt.sessionId, previous.attempt.sessionId)
  assert.equal(running.attempt.worker.inputCursor, resumed.input.cursor)
  assert.deepEqual(running.attempt.worker.inputHistory, [
    'cursor-initial-wait', 'cursor-second-wait', resumed.input.cursor,
  ])
  assert.equal(ctx.agents.get(running.attempt.sessionId).session.header.cwd, previous.attempt.worker.cwd)
  const messages = JSON.stringify(resumed.requests[0].messages)
  assert.match(messages, /PA006_INPUT\[initial-wait\]/)
  assert.match(messages, /PA006_INPUT\[second-wait\]/)
  assert.match(messages, /PA006_INPUT\[resumed\]/)
  seal(fixture, ref, 'artifact-resumed', 'Evidence from the resumed worker.')
  resumed.report('ready', { artifactIds: ['artifact-resumed'] })
  await eventually(() => current(fixture, ref).state.task.status === 'verifying', 'resumed report')
  assert.equal(await executor.waitForRelease(ref), true)
  const released = current(fixture, ref).state
  assert.equal(released.attempt.outcome, undefined)
  assert.ok(released.attempt.worker.releasedAt)
  const verifier = store.createVerifier({
    check({ state, artifacts }) {
      assert.equal(new TextDecoder().decode(artifacts[0].bytes), 'Evidence from the resumed worker.')
      return state.task.acceptance.criteria.map(criterion => ({
        criterion, satisfied: true, evidence: 'Read the sealed bytes after native release.',
      }))
    },
  })
  const verified = mustSucceed(await verifier.verify(ref, { expectedVersion: released.task.version }), 'verify released Worker')
  assert.equal(verified.state.task.status, 'completed')
  assert.equal(store.getVerification(ref, verified.state.task.version)?.artifacts[0]?.id, 'artifact-resumed')
}

async function checkPhase(ctx, phase) {
  const state = fixture(ctx, phase)
  try {
    if (phase === 'controls') await controls(ctx, state)
    else if (phase === 'wait') await waitAndRelease(ctx, state)
    else if (phase === 'resume') await resume(ctx, state)
    else assert.fail(`Unknown worker test phase ${phase}`)
  } finally {
    try {
      assert.equal(await state.executor.close(), true)
    } finally {
      state.store.close()
    }
  }
  console.log(`DSHPA_WORKER ${phase}`)
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void checkPhase(ctx, process.env.DSHPA_CONTRACT_PHASE).then(() => ctx.appExit(0), error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
