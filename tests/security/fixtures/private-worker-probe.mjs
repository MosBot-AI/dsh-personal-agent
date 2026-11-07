import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const cliRequire = createRequire(process.argv[1])
const baseRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter, createUserMessage } = await import(
  pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-llm')).href
)
const { PtcExecutor } = await import(
  pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-tool-executor-ptc')).href
)

export const inject = [
  'appReady', 'appExit', 'agents', 'dshpa',
  ...(process.env.DSHPA_CONTRACT_PHASE === 'missing-tools' ? [] : ['llm', 'tools', 'systemPrompt']),
]

const sessionId = 'dshpa-private-worker'
const ordinaryId = 'dshpa-ordinary-worker'
const agentOptions = { provider: 'dshpa-private-contract', model: 'scripted' }
const canary = 'fixture-ambient-credential-do-not-disclose'
const denial = /Tools are disabled for private workers/
const restricted = ['bash', 'browser', 'web_fetch', 'file_read', 'mcp__fixture__raw']
const lateTool = 'late_scoped_mcp'

function user(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function call(name) {
  const args = name === 'run_code'
    ? { code: 'return process.env.DSHPA_PRIVATE_TEST_CANARY', description: 'Read ambient process credential' }
    : name === 'bash'
      ? { command: 'printenv DSHPA_PRIVATE_TEST_CANARY' }
      : {}
  return { type: 'tool-call', id: `call-${name}`, name, arguments: JSON.stringify(args) }
}

function tool(name, execute, callbacks = {}) {
  return {
    name,
    description: 'Private worker boundary fixture',
    parameters: { type: 'object', additionalProperties: true },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute,
    ...callbacks,
  }
}

class ScriptedModel extends LlmAdapter {
  requests = []

  async *stream(options) {
    this.requests.push({ messages: options.messages, tools: options.tools })
    if (this.requests.length === 1) {
      for (const [index, name] of [...restricted, lateTool, 'run_code'].entries()) {
        const block = call(name)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: block.id, name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    assert.equal(this.requests.length, 2, 'Unexpected model call')
    const text = 'The fixture worker remains available for model-only work.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function denyResult(batch) {
  assert.equal(batch.results.length, 1)
  assert.equal(batch.results[0].result.isError, true)
  assert.match(JSON.stringify(batch.results[0].result.content), denial)
  assert.doesNotMatch(JSON.stringify(batch.results[0].result.content), /fixture-ambient-credential/)
}

async function exercise(ctx, host, phase) {
  process.env.DSHPA_PRIVATE_TEST_CANARY = canary
  const model = new ScriptedModel()
  ctx.llm.registerAdapter([agentOptions.provider], model)
  let bodies = 0
  let globalActivations = 0
  let classifiers = 0
  let finalizers = 0
  let privateApprovalRequests = 0
  let ptcRuns = 0

  const readCanary = async () => {
    bodies++
    return process.env.DSHPA_PRIVATE_TEST_CANARY
  }
  for (const name of restricted) {
    ctx.tools.register(tool(name, readCanary), {
      when() {
        globalActivations++
        return true
      },
    })
  }
  ctx.tools.register(tool('ordinary_fixture', async () => 'ordinary body ran'))
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent?.id !== sessionId) return next()
    privateApprovalRequests++
    return { kind: 'ask', reason: 'Fixture approval must not bypass the private policy' }
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.id !== sessionId) return
    assert.deepEqual(ctx.tools.schemas(agent), [], 'Inherited tools must be hidden at publication')
    // Registration after private policy installation must remain unable to
    // classify, execute, or turn a denial into a credential-bearing result.
    agent.ctx.tools.register(tool(lateTool, readCanary, {
      isConcurrencySafe() {
        classifiers++
        return true
      },
      finalizeContent() {
        finalizers++
        return [{ type: 'text', text: process.env.DSHPA_PRIVATE_TEST_CANARY }]
      },
    }))
    if (phase === 'resume') {
      assert.match(JSON.stringify(agent.inbox.nextTurn), /Run the pending turn after resume/)
      // The host needs a wake signal for persisted input. Latch it during
      // publication so the first resumed step cannot run ahead of policy.
      agent.steer(user('Wake this resumed worker.'))
    }
  })

  const privateHandle = phase === 'create'
    ? await host.privateWorkers.create({
      sessionId,
      agentOptions: { ...agentOptions, ambientCredential: canary },
      setup: () => assert.fail('Private worker accepted caller setup'),
    })
    : await host.privateWorkers.resume({ resumeSessionId: sessionId, agentOptions })
  const { agent } = privateHandle
  assert.equal(Object.hasOwn(agent.options, 'ambientCredential'), false)
  assert.ok(ctx.tools.get(lateTool, agent), 'The late scoped tool must really exist')
  if (phase === 'create') agent.followup(user('Try the forbidden tools.'))
  await agent.whenIdle()
  assert.equal(model.requests.length, 2, `${phase} turn events: ${JSON.stringify(agent.session.snapshotEvents().slice(-8))}`)
  assert.deepEqual(model.requests[0].tools ?? [], [], 'The private model sees no tool schemas')
  assert.ok(!JSON.stringify(model.requests).includes(canary))
  assert.ok(!JSON.stringify(agent.session.snapshotEvents()).includes(canary))

  const turnResults = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    .slice(-(restricted.length + 2))
  assert.equal(turnResults.length, restricted.length + 2)
  assert.ok(turnResults.every(event => event.data.message.isError && denial.test(JSON.stringify(event.data.message.content))))
  assert.equal(privateApprovalRequests, 0, 'Private calls must bypass an approval request')
  assert.equal(bodies, 0)
  assert.equal(globalActivations, 0)
  assert.equal(classifiers, 0)
  assert.equal(finalizers, 0)

  // A newer scoped allow listener can short-circuit the early denial, but it
  // cannot lift the monotonic guard on the shared native invocation pipeline.
  let laterAllows = 0
  agent.ctx.on('tools/pre-execute', async () => {
    laterAllows++
    return { kind: 'allow' }
  }, { prepend: true })
  const signal = new AbortController().signal
  denyResult(await ctx.tools.execute({ agent, calls: [call(lateTool)], signal }))
  assert.equal(laterAllows, 1)
  assert.equal(bodies, 0)
  assert.equal(finalizers, 0)

  const ordinary = await host.agents.create({ sessionId: ordinaryId, agentOptions })
  try {
    const outcome = await ctx.tools.execute({ agent: ordinary.agent, calls: [call('ordinary_fixture')], signal })
    assert.equal(outcome.results[0].result.isError, false)
    assert.equal(outcome.results[0].result.value, 'ordinary body ran')

    // Exercise the installed reserved transport directly as an alternate
    // executor, while its actual program runner stays a harmless fixture.
    ctx.provide('workingDirectory', { ensure: async () => process.cwd() })
    ctx.provide('ptcRuntime', {
      language: 'typescript',
      programFormat: 'function-body',
      resolve: input => input,
      async run() {
        ptcRuns++
        return { logs: [], value: 'fixture program runner' }
      },
      release() {},
    })
    const ptc = new PtcExecutor(ctx)
    assert.deepEqual(ptc.describe([]).schemas.map(schema => schema.name), ['run_code'])
    denyResult(await ptc.execute({ agent, calls: [call('run_code')], signal }))
    assert.equal(laterAllows, 2)
    assert.equal(ptcRuns, 0)
    const positive = await ptc.execute({ agent: ordinary.agent, calls: [call('run_code')], signal })
    assert.equal(positive.results[0].result.isError, false)
    assert.equal(ptcRuns, 1)
  } finally {
    await ordinary.dispose()
  }

  if (phase === 'create') {
    // Persist a pending turn, then leave without orderly agent disposal so
    // resume must protect queued input before the native loop can run it.
    await agent.runMaintenance(async () => {
      agent.followup(user('Run the pending turn after resume.'))
      await host.flush(agent.session)
      console.log('DSHPA_PRIVATE_WORKER create')
      process.exit(0)
    })
  }
  assert.match(JSON.stringify(model.requests[0].messages), /Run the pending turn after resume/)
  await privateHandle.dispose()
}

async function run(ctx, phase) {
  const { host } = ctx.dshpa
  if (phase === 'missing-tools') {
    assert.equal(ctx.get('tools'), undefined)
    await assert.rejects(host.privateWorkers.create({ sessionId, agentOptions }), /tool registry is unavailable/)
    await assert.rejects(host.privateWorkers.resume({ resumeSessionId: sessionId, agentOptions }), /tool registry is unavailable/)
    assert.equal(ctx.agents.get(sessionId), undefined)
  } else {
    await exercise(ctx, host, phase)
  }
  console.log(`DSHPA_PRIVATE_WORKER ${phase}`)
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void run(ctx, process.env.DSHPA_CONTRACT_PHASE).then(() => ctx.appExit(0), error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
