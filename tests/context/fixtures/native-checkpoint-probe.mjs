import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import CheckpointedCompaction from '@mosbot-ai/dshpa/checkpoint-compaction'
import CheckpointedPruner from '@mosbot-ai/dshpa/checkpoint-pruner'
import { openWorkStore } from './node_modules/@mosbot-ai/dshpa/lib/storage/store.js'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { createUserMessage, LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'agents', 'sessions', 'sessionPersistence', 'llm', 'tools', 'tokenMeter', 'dshpa']

const phase = process.env.DSHPA_CONTRACT_PHASE
const scope = { ownerId: 'checkpoint-owner', profileId: 'checkpoint-profile' }
const actor = { ...scope, role: 'owner', deviceId: 'checkpoint-device', clientId: 'checkpoint-client', policyVersion: 'fixture-v1' }
const ref = { ...scope, taskId: 'checkpoint-task' }
const projectId = 'checkpoint-project'
const conversationId = 'checkpoint-conversation'
const managedSession = 'checkpoint-managed-session'
const unrelatedSession = 'checkpoint-unrelated-session'
const sourceId = 'checkpoint-cited-source'
const objective = 'Preserve the scoped project brief.'
const constraint = '仅使用已经授权的来源。'
const decision = '采用已确认的蓝色方案。'
const question = 'Which review date has the owner approved?'
const rawMarker = 'raw fixture conversation body'
const route = { provider: 'pa011-native-fixture', model: 'keyless' }
const at = () => new Date().toISOString()

function report(result) {
  console.log(`PA011_NATIVE_CHECKPOINT ${JSON.stringify({ phase, ...result })}`)
}

function requireResult(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result
}

function seed(store) {
  const now = at()
  const sourceInstanceId = 'checkpoint-fixture-source'
  store.insertProject({ id: projectId, ...scope, kind: 'project', title: 'Checkpoint fixture', purpose: objective,
    resourceRefs: [], status: 'active', successCriteria: ['Keep the evidence bound.'], planRevision: 1, milestones: [] })
  store.insertConversation({ id: conversationId, ...scope, sessionIds: [managedSession],
    originalDestination: { sourceInstanceId, externalDestinationId: 'checkpoint-fixture-thread' } })
  requireResult(store.applyCommand({ type: 'work.create', commandId: 'checkpoint-create-task', conversationId, payload: {
    projectId, requestedOutcome: objective, constraints: [constraint],
    acceptance: { criteria: ['Keep the evidence bound.'], requiresArtifact: false, requiresReceipt: false },
  } }, { actor, at: now, projectId, conversationId, newTaskId: ref.taskId,
    newAttempt: { id: 'checkpoint-attempt', mandate: { id: 'checkpoint-mandate', ...scope, policyVersion: actor.policyVersion } },
  }, { sourceEvent: { id: sourceId, ...scope, sourceInstanceId, externalEventId: 'checkpoint-external-event', externalRevision: '1',
    actor: { kind: 'person', externalActorId: actor.ownerId, deviceId: actor.deviceId },
    body: { text: 'The owner confirmed the source.' }, occurredAt: now, receivedAt: now, provenance: {} } }))
}

function text(blocks) {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function* reply(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function attachModel(ctx) {
  const counts = { managedSummaryCalls: 0, unrelatedSummaryCalls: 0 }
  const requests = []
  let sentBulk = false
  class Fixture extends LlmAdapter {
    async *stream(options) {
      if (options.purpose === 'compaction') {
        if (options.sessionId === managedSession) {
          counts.managedSummaryCalls++
          throw new Error('Managed compaction disclosed conversation history')
        }
        assert.equal(options.sessionId, unrelatedSession)
        counts.unrelatedSummaryCalls++
        yield* reply('Unrelated native summary.')
        return
      }
      requests.push(options)
      const input = options.messages.map(message => text(message.content)).join('\n')
      if (options.sessionId === managedSession && input.includes('[PRUNE_FIXTURE]') && !sentBulk) {
        sentBulk = true
        const block = { type: 'tool-call', id: 'checkpoint-bulk-call', name: 'checkpoint_bulk', arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield* reply('A short fixture response.')
    }
  }
  ctx.llm.registerAdapter([route.provider], new Fixture())
  ctx.tools.register({ name: 'checkpoint_bulk', description: 'Return harmless fixture text for native pruning.',
    parameters: { type: 'object', additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'Unprivileged fixture tool output. '.repeat(150),
  })
  return { counts, requests }
}

function capture(store, session) {
  if (session.id !== managedSession) return { kind: 'unmanaged' }
  const { task, attempt } = store.getWork(ref)
  const existing = store.getLatestContextCheckpoint(ref, managedSession)
  const pointer = { kind: 'event', eventId: sourceId }
  const saved = store.captureContextCheckpoint(ref, { sessionId: managedSession, compactionId: `fixture-${randomUUID()}`,
    attemptId: attempt.id, generation: attempt.generation, expectedVersion: task.version, at: at(), nativeSeq: session.seq,
    ...(existing ? {} : { decisions: [{ text: decision, sources: [pointer] }], questions: [{ text: question, sources: [pointer] }] }),
  })
  if (!saved.ok) return { kind: 'unavailable' }
  const checkpoint = saved.checkpoint
  return { kind: 'managed', summary: JSON.stringify({ id: checkpoint.id, objective: checkpoint.objective,
    constraints: checkpoint.constraints, decisions: checkpoint.decisions, questions: checkpoint.questions, pointers: checkpoint.pointers }),
  isCurrent() {
    const current = store.getWork(ref)
    return current?.task.version === checkpoint.taskVersion && current?.task.generation === checkpoint.generation
      && current?.attempt.id === checkpoint.attemptId
  } }
}

async function turn(agent, input) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function persisted(ctx) {
  const reader = await ctx.sessionPersistence.open(managedSession, 'read')
  try {
    const events = []
    for (;;) {
      const page = await reader.read(events.length, 64)
      if (page.events.length === 0) return events
      events.push(...page.events)
      assert.ok(events.length < 512)
    }
  } finally {
    await reader.close()
  }
}

function verifyCheckpoint(checkpoint) {
  const source = { kind: 'event', eventId: sourceId }
  assert.equal(checkpoint.objective, objective)
  assert.deepEqual(checkpoint.constraints, [constraint])
  assert.deepEqual(checkpoint.decisions, [{ text: decision, sources: [source] }])
  assert.deepEqual(checkpoint.questions, [{ text: question, sources: [source] }])
  assert.ok(checkpoint.pointers.some(pointer => pointer.kind === 'event' && pointer.eventId === sourceId))
}

function verifyEvents(events) {
  const starts = events.filter(event => event.type === 'compaction/start')
  const summaries = events.filter(event => event.type === 'compaction/summary')
  const ends = events.filter(event => event.type === 'compaction/end')
  assert.equal(starts.length, 10)
  assert.equal(summaries.length, 10)
  assert.equal(ends.length, 10)
  for (const [index, summary] of summaries.entries()) {
    assert.equal(starts[index].data.compactionId, summary.data.compactionId)
    assert.equal(ends[index].data.compactionId, summary.data.compactionId)
    assert.equal(ends[index].data.error, undefined)
    assert.equal(summary.data.provider, 'dshpa-local')
    assert.equal(summary.data.model, 'structured-checkpoint-v1')
    assert.equal(summary.data.llmStreamCall, undefined)
    const content = text(summary.data.summary)
    assert.ok(content.includes(decision) && content.includes(sourceId) && !content.includes(rawMarker))
    const next = events[summary.seq + 1]
    assert.equal(next.type, 'user/message')
    assert.equal(next.surfaceOp.op, 'replace')
    assert.equal(next.data.source.kind, 'compact-checkpoint')
  }
  return starts
}

async function checkFailure(ctx, store, agent, model) {
  await turn(agent, `[PRUNE_FIXTURE] ${`${rawMarker} `.repeat(150)}`)
  await ctx.dshpa.host.flush(agent.session)
  const before = agent.session.seq
  const surface = agent.session.surface.replaceGeneration
  const db = store.storage.db
  db.exec(`CREATE TEMP TRIGGER checkpoint_fixture_failure BEFORE INSERT ON context_checkpoints
    BEGIN SELECT RAISE(ABORT, 'fixture checkpoint write failure'); END`)
  const signal = new AbortController().signal
  const compaction = ctx.get('compaction')
  const pruner = ctx.get('toolResultPruner')
  const persistence = error => error?.code === 'persistence'
  async function duringStep(action) {
    let observation
    const unsubscribe = ctx.on('agent/pre-step', async ({ agent: current }, next) => {
      if (current === agent && !observation) {
        const seq = agent.session.seq
        const generation = agent.session.surface.replaceGeneration
        try {
          observation = { seq, generation, value: action(), replaced: agent.session.surface.replaceGeneration }
        } catch (error) {
          observation = { seq, generation, error, replaced: agent.session.surface.replaceGeneration }
        }
      }
      return next()
    })
    try {
      await turn(agent, 'Continue the native pruning fixture.')
      assert.ok(observation)
      return observation
    } finally {
      unsubscribe()
    }
  }
  try {
    await assert.rejects(async () => compaction.compactNow(agent, signal), persistence)
    assert.equal(agent.session.seq, before)
    assert.equal(agent.session.surface.replaceGeneration, surface)
    const failed = await duringStep(() => pruner.pruneSession(agent.session))
    assert.ok(persistence(failed.error))
    assert.equal(failed.generation, failed.replaced)
    assert.equal(store.getLatestContextCheckpoint(ref, managedSession), undefined)
  } finally {
    db.exec('DROP TRIGGER checkpoint_fixture_failure')
  }
  assert.throws(() => pruner.pruneSession(agent.session), error => error?.code === 'busy')
  const recovered = await duringStep(() => pruner.pruneSession(agent.session))
  if (recovered.error) throw recovered.error
  assert.equal(recovered.value.pruned.length, 1)
  const saved = store.getLatestContextCheckpoint(ref, managedSession)
  verifyCheckpoint(saved)
  assert.equal(saved.nativeSeq, recovered.seq)
  assert.equal(saved.revision, 1)
  await ctx.dshpa.host.flush(agent.session)
  const events = await persisted(ctx)
  assert.equal(events.filter(event => event.type === 'compaction/prune').length, 1)
  assert.equal(events.filter(event => event.type === 'compaction/start').length, 0)
  report({ writeFailures: 2, replacementsDuringFailure: 0, recoveredPrunes: 1, ...model.counts })
}

async function run(ctx) {
  const store = openWorkStore(join(process.env.DSH_HOME, 'checkpoint-work-store'))
  const isolated = ctx.isolate('dshpaCheckpointPolicy')
  isolated.provide('dshpaCheckpointPolicy', { capture: session => capture(store, session) })
  const model = attachModel(ctx)
  let compactor
  let pruner
  let handle
  let unrelated
  try {
    if (phase !== 'restart') seed(store)
    pruner = await isolated.plugin(CheckpointedPruner, { thresholdChars: 200, headChars: 32, tailChars: 32 })
    compactor = await isolated.plugin(CheckpointedCompaction, { auto: false })
    assert.equal(isolated.get('dshpaCheckpointCompactionReady'), true)
    assert.equal(isolated.get('dshpaCheckpointPrunerReady'), true)
    if (phase === 'restart') {
      const events = await persisted(ctx)
      const starts = verifyEvents(events)
      const latest = store.getLatestContextCheckpoint(ref, managedSession)
      verifyCheckpoint(latest)
      assert.equal(latest.nativeSeq, starts.at(-1).seq)
      assert.equal(latest.revision, 10)
      handle = await ctx.agents.resume({ resumeSessionId: managedSession, agentOptions: route })
      await turn(handle.agent, 'Continue from the saved scope.')
      const request = model.requests.at(-1)
      assert.equal(request.sessionId, managedSession)
      assert.ok(request.messages.some(message => text(message.content).includes(decision) && text(message.content).includes(sourceId)))
      report({ managedCompactions: 10, revision: latest.revision, checkpointId: latest.id,
        continuedWithCheckpoint: true, ...model.counts })
      return
    }

    handle = await ctx.agents.create({ sessionId: managedSession, agentOptions: route })
    if (phase === 'fail-write') return await checkFailure(isolated, store, handle.agent, model)
    const seenAtStart = []
    const unsubscribe = ctx.on('session/event', (session, event) => {
      if (session !== handle.agent.session || event.type !== 'compaction/start') return
      const checkpoint = store.getLatestContextCheckpoint(ref, managedSession)
      seenAtStart.push({ seq: event.seq, saved: checkpoint?.nativeSeq, revision: checkpoint?.revision })
    })
    try {
      const signal = new AbortController().signal
      const compaction = isolated.get('compaction')
      for (let i = 0; i < 10; i++) {
        await turn(handle.agent, `${i}: ${`${rawMarker} `.repeat(150)}`)
        assert.ok(await compaction.compactNow(handle.agent, signal))
      }
      unrelated = await ctx.agents.create({ sessionId: unrelatedSession, agentOptions: route })
      await turn(unrelated.agent, 'Unrelated native text. '.repeat(100))
      assert.ok(await compaction.compactNow(unrelated.agent, signal))
    } finally {
      unsubscribe()
    }
    await ctx.dshpa.host.flush(handle.agent.session)
    const starts = verifyEvents(await persisted(ctx))
    assert.deepEqual(seenAtStart, starts.map((event, index) => ({ seq: event.seq, saved: event.seq, revision: index + 1 })))
    const latest = store.getLatestContextCheckpoint(ref, managedSession)
    verifyCheckpoint(latest)
    report({ managedCompactions: 10, revision: latest.revision, checkpointId: latest.id, ...model.counts })
  } finally {
    await unrelated?.dispose()
    await handle?.dispose()
    await compactor?.dispose()
    await pruner?.dispose()
    store.close()
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void run(ctx).then(() => ctx.appExit(0), error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
