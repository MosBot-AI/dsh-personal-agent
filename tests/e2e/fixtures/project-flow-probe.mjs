import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

const provider = 'pa014-project-fixture'
const model = 'project-worker'

export const inject = ['appReady', 'appExit', 'llm', 'sessionController']

async function initialize(ctx) {
  let parentSession
  class FixtureModel extends LlmAdapter {
    async listModels() { return [{ provider, id: model, name: model }] }

    async resolveModel() { return { provider, id: model, name: model, context: { contextWindow: 65_536 } } }

    async *stream(options) {
      assert.deepEqual(options.tools ?? [], [])
      const input = options.messages.findLast(message => message.source?.kind === 'dshpa-work-input')
      assert.ok(input)
      const cursor = input.source.cursor
      let report
      if (cursor === 'pa014-draft') {
        parentSession = options.sessionId
        assert.ok(parentSession)
        report = { kind: 'plan', cursor, summary: 'Propose one downstream task.', steps: ['Check the published brief.'] }
      } else if (cursor === 'pa014-parent') {
        assert.equal(options.sessionId, parentSession)
        report = { kind: 'ready', cursor, summary: 'Parent sourced brief.', artifactIds: [] }
      } else {
        assert.equal(cursor, 'pa014-child')
        assert.ok(options.sessionId)
        assert.notEqual(options.sessionId, parentSession)
        report = { kind: 'ready', cursor, summary: 'Verified downstream review.', artifactIds: [] }
      }
      const text = JSON.stringify(report)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 14, outputTokens: 5, totalTokens: 19 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([provider], new FixtureModel())
  const created = await ctx.sessionController.create({ sessionId: 'pa014-primary', cwd: realpathSync(process.cwd()), agentPreset: 'minimal' })
  assert.equal(created.sessionId, 'pa014-primary')
  console.log('DSHPA_WEB_FLOW_READY')
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void initialize(ctx).catch(error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
