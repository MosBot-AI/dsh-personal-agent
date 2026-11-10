import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)
const { NativeToolExecutor } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-tool-executor-native')).href)
const provider = 'pa031-desktop-fixture'
const model = 'desktop-worker'

export const inject = ['appReady', 'appExit', 'llm', 'sessionController', 'tools', 'agents']

async function initialize(ctx) {
  ctx.provide('computerUse', { providerName: 'cua-driver-native' })
  ctx.tools.register({
    name: 'cua_driver_native__check_permissions', description: 'Pinned Linux capability fixture',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      assert.fail('Target admission must not invoke native Linux discovery, capability checks or input')
    },
  })
  ctx.tools.register({
    name: 'bash', description: 'Forbidden execution fixture', parameters: { type: 'object' },
    output: { schema: {}, render: () => [] }, async execute() { assert.fail('Unrestricted shell executed') },
  })

  class FixtureModel extends LlmAdapter {
    async listModels() { return [{ provider, id: model, name: model }] }
    async resolveModel() { return { provider, id: model, name: model, context: { contextWindow: 65_536 } } }

    async *stream() { assert.fail('Linux capability probe must not admit a model call') }
  }

  ctx.llm.registerAdapter([provider], new FixtureModel())
  await ctx.sessionController.create({ sessionId: 'pa031-primary', cwd: realpathSync(process.cwd()), agentPreset: 'minimal' })
  const ordinary = await ctx.agents.create({ sessionId: 'pa031-unmanaged', setup(agentCtx) {
    agentCtx.tools.setExecutor(new NativeToolExecutor(agentCtx))
  } })
  try {
    for (const name of ['bash', 'cua_driver_native__check_permissions']) {
      const denied = await ctx.tools.execute({
        agent: ordinary.agent, signal: new AbortController().signal,
        calls: [{ type: 'tool-call', id: `pa031-forbidden-${name}`, name, arguments: '{}' }],
      })
      assert.equal(denied.results[0]?.result.isError, true)
      assert.match(denied.results[0]?.result.error.message, /only owner-leased native tools/u)
    }
  } finally { await ordinary.dispose() }
  console.log('DSHPA_WEB_FLOW_READY')
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void initialize(ctx).catch(error => { console.error(error); ctx.appExit(1) })
  }))
}
