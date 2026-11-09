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
const app = 'com.apple.TextEdit'

export const inject = ['appReady', 'appExit', 'llm', 'sessionController', 'tools', 'agents']

async function initialize(ctx) {
  let probes = 0
  let clicks = 0
  let applications = 0
  const steps = new Map()
  ctx.provide('computerUse', { providerName: 'dsh-cua' })
  ctx.tools.register({
    name: 'cua', description: 'Deterministic CUA provider fixture',
    parameters: { type: 'object', additionalProperties: true },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ method, params }, execution) {
      if (method === 'getCapabilities') return {
        platform: 'macos', sessionLocked: false, permissions: { accessibility: ++probes > 1, screenRecording: false },
        methods: ['getApp', 'getState', 'click', 'setValue'],
      }
      if (method === 'getApp') {
        assert.equal(params.selector, app)
        return { bundleId: app, appHandle: `fixture-app-${++applications}`, pid: 123 }
      }
      if (method === 'getState') {
        assert.equal(params.appHandle, `fixture-app-${applications}`)
        return { appHandle: params.appHandle, pid: 123, windowId: 4, snapshotId: `fixture-state-${applications}` }
      }
      assert.equal(method, 'click')
      assert.equal(params.snapshotId, `fixture-state-${applications}`)
      if (++clicks === 1) {
        await new Promise(resolve => {
          if (execution.signal.aborted) resolve()
          else execution.signal.addEventListener('abort', resolve, { once: true })
        })
        // A native input can take time to drain even after it has been fenced.
        await new Promise(resolve => setTimeout(resolve, 160))
        execution.signal.throwIfAborted()
      }
      assert.equal(clicks, 2)
      return { dispatched: true, verified: false }
    },
  })
  ctx.tools.register({
    name: 'bash', description: 'Forbidden execution fixture', parameters: { type: 'object' },
    output: { schema: {}, render: () => [] }, async execute() { assert.fail('Unrestricted shell executed') },
  })

  class FixtureModel extends LlmAdapter {
    async listModels() { return [{ provider, id: model, name: model }] }
    async resolveModel() { return { provider, id: model, name: model, context: { contextWindow: 65_536 } } }

    async *stream(options) {
      const input = options.messages.findLast(message => message.source?.kind === 'dshpa-work-input')
      assert.ok(input)
      const cursor = input.source.cursor
      assert.notEqual(cursor, 'pa031-missing', 'A missing permission must park before model admission')
      if (cursor !== 'pa031-background') {
        assert.deepEqual(options.tools?.map(tool => tool.name), ['dshpa_desktop'])
        const step = steps.get(cursor) ?? 0
        steps.set(cursor, step + 1)
        const appHandle = `fixture-app-${applications}`
        const calls = [
          { method: 'getApp', params: { selector: app } },
          { method: 'getState', params: { appHandle } },
          { method: 'click', params: { appHandle, snapshotId: `fixture-state-${applications}`, elementIndex: 1 } },
        ]
        const request = calls[step]
        if (request) {
          const block = { type: 'tool-call', id: `${cursor}-${step}`, name: 'dshpa_desktop', arguments: JSON.stringify(request) }
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
          yield { type: 'block-end', index: 0, block }
          yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 5, totalTokens: 21 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        assert.equal(cursor, 'pa031-resume')
      } else assert.deepEqual(options.tools ?? [], [])
      const text = JSON.stringify({ kind: 'ready', cursor, summary: 'Verified fixture output.', artifactIds: [] })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 5, totalTokens: 21 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([provider], new FixtureModel())
  await ctx.sessionController.create({ sessionId: 'pa031-primary', cwd: realpathSync(process.cwd()), agentPreset: 'minimal' })
  const ordinary = await ctx.agents.create({ sessionId: 'pa031-unmanaged', setup(agentCtx) {
    agentCtx.tools.setExecutor(new NativeToolExecutor(agentCtx))
  } })
  try {
    for (const name of ['bash', 'cua']) {
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
