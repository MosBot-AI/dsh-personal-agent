import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Resolve the same installed LLM package that the published DSH base uses.
const cliRequire = createRequire(process.argv[1])
const baseRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter, createUserMessage, expandAssistantStream } = await import(
  pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-llm')).href
)

export const inject = ['appReady', 'appExit', 'loader', 'agents', 'agentLoop', 'sessions', 'llm', 'tools']

const sessionId = 'dshpa-host-contract'
const agentOptions = { provider: 'dshpa-contract-model', model: 'scripted' }
const toolName = 'dshpa_contract_tool'
const denial = 'PA-002 scoped guard denied the tool'

class ScriptedModel extends LlmAdapter {
  requests = []

  constructor(responses) {
    super()
    this.responses = responses
  }

  async *stream(options) {
    this.requests.push(options)
    const respond = this.responses.shift()
    assert.ok(respond, 'The native model made an unexpected request')
    yield* respond(options)
  }
}

function user(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function* answer(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolCall(id) {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: toolName, argumentsDelta: '{}' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: toolName, arguments: '{}' } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function fixtureTool(name, onCall) {
  return {
    name,
    description: 'Deterministic native contract fixture',
    parameters: { type: 'object', additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      onCall()
      return 'fixture tool executed'
    },
  }
}

async function* untilCancelled({ signal }, entered, observed) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'unfinished reply' }
  entered.resolve()
  assert.ok(signal, 'Native dispatch must provide a cancellation signal')
  await new Promise((_, reject) => {
    const abort = () => {
      observed.resolve(signal.reason)
      reject(new Error('Fixture stream cancelled'))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

async function awaitActive(entered, idle) {
  await Promise.race([
    entered.promise,
    idle.then(() => assert.fail('The native agent became idle before the scripted stream was reached')),
  ])
}

function assertStreamReplay(frames, events, sequence) {
  const start = frames.findIndex(frame => frame.type === 'start' && frame.turn === 1 && frame.step === 2)
  assert.ok(start >= 0, 'The scripted final answer must publish an attempt start')
  const end = frames.findIndex((frame, index) => index > start && frame.type === 'end')
  assert.ok(end > start, 'The live attempt must end after its chunks')
  const chunks = frames.slice(start + 1, end)
  assert.deepEqual(chunks.map(frame => frame.type), chunks.map(() => 'chunk'))
  assert.deepEqual(chunks.map(frame => frame.index), chunks.map((_, index) => index))
  assert.deepEqual(frames[end].outcome, { kind: 'committed', eventType: 'assistant/message', seq: sequence })
  const committed = events.find(event => event.seq === sequence)
  assert.deepEqual(
    expandAssistantStream(committed.data.stream).map(member => member.chunk),
    chunks.map(frame => frame.chunk),
  )
}

async function createAndFlush(ctx, host) {
  const enteredToolCall = Promise.withResolvers()
  const finishToolCall = Promise.withResolvers()
  const enteredCancellation = Promise.withResolvers()
  const observedCancellation = Promise.withResolvers()
  const model = new ScriptedModel([
    async function* () {
      enteredToolCall.resolve()
      await finishToolCall.promise
      yield* toolCall('guarded-call')
    },
    () => answer('durable final answer'),
    options => untilCancelled(options, enteredCancellation, observedCancellation),
  ])
  ctx.llm.registerAdapter([agentOptions.provider], model)

  let toolCalls = 0
  ctx.tools.register(fixtureTool(toolName, () => { toolCalls += 1 }))
  const handle = await host.agents.create({ sessionId, agentOptions })
  const { agent } = handle
  assert.equal(ctx.agents.get(sessionId), agent)
  const scopedTool = fixtureTool('dshpa_scope_probe', () => assert.fail('Scoped probe must never execute'))
  agent.ctx.tools.register(scopedTool)
  assert.ok(ctx.tools.get(scopedTool.name, agent))
  assert.equal(ctx.tools.get(scopedTool.name), undefined)

  let guards = 0
  agent.ctx.tools.guard(execution => {
    if (execution.name !== toolName) return
    assert.equal(Object.isFrozen(execution.arguments), true)
    guards += 1
    return denial
  })
  agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })

  const frames = []
  let sawLiveDeltaBeforeCommit = false
  ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    frames.push(frame)
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta'
      && frame.chunk.text === 'durable final answer') {
      sawLiveDeltaBeforeCommit = !agent.session.snapshotEvents().some(event =>
        event.type === 'assistant/message' && event.data.step === 2)
    }
  })

  agent.inject(user('injected while idle'))
  await agent.whenIdle()
  assert.equal(agent.status, 'idle')
  assert.equal(model.requests.length, 0)
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'))
  assert.ok(!agent.session.snapshotEvents().some(event => event.type === 'turn/start'))

  agent.followup(user('ordinary follow-up'))
  const firstIdle = agent.whenIdle()
  await awaitActive(enteredToolCall, firstIdle)
  assert.equal(agent.status, 'running')
  agent.steer(user('steer this active turn'))
  agent.inject(user('inject at the next step'))
  finishToolCall.resolve()
  await firstIdle
  assert.equal(agent.status, 'idle')
  assert.equal(model.requests.length, 2)
  const firstRequest = JSON.stringify(model.requests[0].messages)
  const nextRequest = JSON.stringify(model.requests[1].messages)
  assert.match(firstRequest, /injected while idle/)
  assert.match(firstRequest, /ordinary follow-up/)
  assert.doesNotMatch(firstRequest, /steer this active turn|inject at the next step/)
  assert.match(nextRequest, /steer this active turn/)
  assert.match(nextRequest, /inject at the next step/)
  assert.match(nextRequest, new RegExp(denial))
  assert.equal(guards, 1)
  assert.equal(toolCalls, 0)

  const firstTurn = agent.session.snapshotEvents()
  assert.equal(firstTurn.filter(event => event.type === 'turn/start').length, 1)
  const results = firstTurn.filter(event => event.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0].data.message.isError, true)
  assert.match(JSON.stringify(results[0].data.message.content), new RegExp(denial))
  assert.equal(sawLiveDeltaBeforeCommit, true)
  const final = firstTurn.findLast(event => event.type === 'assistant/message')
  assert.deepEqual(final.data.message.content, [{ type: 'text', text: 'durable final answer' }])
  assert.equal(final.data.interrupted, undefined)
  assertStreamReplay(frames, firstTurn, final.seq)

  agent.followup(user('cancel this active turn'))
  const cancelledIdle = agent.whenIdle()
  await awaitActive(enteredCancellation, cancelledIdle)
  assert.equal(agent.status, 'running')
  agent.cancel({ kind: 'user' })
  await cancelledIdle
  assert.deepEqual(await observedCancellation.promise, { kind: 'user' })
  assert.equal(agent.status, 'idle')

  const events = agent.session.snapshotEvents()
  const ended = events.filter(event => event.type === 'turn/end')
  assert.deepEqual(ended.map(event => event.data.reason), [
    { kind: 'completed' },
    { kind: 'aborted', reason: { kind: 'user' } },
  ])
  const messages = events.filter(event => event.type === 'assistant/message')
  assert.equal(messages.length, 3)
  assert.equal(messages[2].data.interrupted, true)
  assert.deepEqual(messages[2].data.message.content, [{ type: 'text', text: 'unfinished reply' }])
  assert.ok(!events.some(event => event.type === 'assistant/chunk'))

  await host.flush(agent.session)
  const persistence = ctx.get('sessionPersistence')
  assert.ok(persistence, 'The JSONL persistence backend must be composed')
  const readHandle = await persistence.open(sessionId, 'read')
  try {
    assert.deepEqual((await readHandle.read()).events, events)
  } finally {
    await readHandle.close()
  }

  await handle.dispose()
  assert.equal(ctx.agents.get(sessionId), undefined)
  assert.equal(ctx.sessions.get(sessionId), undefined)
  assert.equal(ctx.tools.get(scopedTool.name, agent), undefined)
}

async function resumeAndDispose(ctx, host) {
  const entered = Promise.withResolvers()
  const observed = Promise.withResolvers()
  const model = new ScriptedModel([
    () => toolCall('resumed-call'),
    () => answer('reply after restarting the host'),
    options => untilCancelled(options, entered, observed),
  ])
  ctx.llm.registerAdapter([agentOptions.provider], model)
  let toolCalls = 0
  ctx.tools.register(fixtureTool(toolName, () => { toolCalls += 1 }))
  const { agent } = await host.agents.resume({ resumeSessionId: sessionId, agentOptions })
  assert.equal(ctx.agents.get(sessionId), agent)
  const replayed = agent.session.snapshotEvents()
  const messages = replayed.filter(event => event.type === 'assistant/message')
  assert.equal(messages.length, 3)
  assert.deepEqual(messages[1].data.message.content, [{ type: 'text', text: 'durable final answer' }])
  assert.equal(messages[2].data.interrupted, true)
  assert.deepEqual(replayed.findLast(event => event.type === 'turn/end').data.reason, {
    kind: 'aborted',
    reason: { kind: 'user' },
  })

  agent.followup(user('continue after resume'))
  await agent.whenIdle()
  assert.equal(toolCalls, 1)
  assert.match(JSON.stringify(model.requests[1].messages), /fixture tool executed/)
  await host.flush(agent.session)

  agent.followup(user('exercise owner disposal'))
  const idle = agent.whenIdle()
  await awaitActive(entered, idle)
  const bundle = [...ctx.loader.entries()].find(entry => entry.options.id === 'dshpa')
  assert.ok(bundle?.fiber, 'Expected an active dshpa bundle entry')
  await bundle.fiber.dispose()
  await idle
  assert.deepEqual(await observed.promise, { kind: 'disposed' })
  assert.equal(ctx.agents.get(sessionId), undefined)
  assert.equal(ctx.sessions.get(sessionId), undefined)
  assert.equal(ctx.get('dshpa'), undefined)
}

async function checkPhase(ctx, phase) {
  const host = ctx.get('dshpa')?.host
  assert.ok(host, 'Expected the dshpa host adapter from the active bundle')
  switch (phase) {
    case 'create':
      await createAndFlush(ctx, host)
      break
    case 'resume':
      await resumeAndDispose(ctx, host)
      break
    case 'no-persistence': {
      const session = ctx.sessions.create(sessionId)
      await assert.rejects(host.flush(session), /no durability listener/)
      const failure = new Error('Fixture durability failure')
      ctx.on('session/flush', async candidate => {
        if (candidate === session) throw failure
      })
      await assert.rejects(host.flush(session), error => error === failure)
      break
    }
    default:
      assert.fail(`Unknown host contract phase: ${phase}`)
  }
  console.log(`DSHPA_HOST ${phase}`)
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void checkPhase(ctx, process.env.DSHPA_CONTRACT_PHASE).then(() => ctx.appExit(0), error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
