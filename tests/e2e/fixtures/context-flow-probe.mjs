import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import CheckpointedCompaction from '@mosbot-ai/dshpa/checkpoint-compaction'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'llm', 'sessionController', 'dshpaCheckpointCompactionReady', 'dshpaCheckpointPrunerReady']

const provider = 'pa011-context-fixture'
const chatModel = 'context-chat'
const workerModel = 'context-worker'
const primary = 'pa011-web-context-primary'
const foreign = 'pa011-web-context-foreign'
const stock = 'pa011-web-context-stock'

function* answer(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 14, outputTokens: 5, totalTokens: 19 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function initialize(ctx) {
  const compaction = ctx.get('compaction')
  assert.ok(compaction instanceof CheckpointedCompaction,
    `Expected checkpointed native compaction, observed ${compaction?.constructor.name}`)
  ctx.on('session/event', (session, event) => {
    if (session.id === primary && event.type === 'compaction/end' && event.data.error) {
      console.error(`PA011 fixture compaction failed: ${event.data.error}`)
    }
  })
  class FixtureModel extends LlmAdapter {
    async listModels() {
      return [chatModel, workerModel].map(id => ({ provider, id, name: id }))
    }

    async resolveModel(providerId, model) {
      assert.equal(providerId, provider)
      assert.ok(model === chatModel || model === workerModel)
      return { provider, id: model, name: model, context: { contextWindow: 65_536 } }
    }

    async *stream(options) {
      assert.notEqual(options.purpose, 'compaction', `Managed Web compaction must stay local (${options.sessionId})`)
      if (options.model === chatModel) {
        yield* answer('The configured native conversation stayed available.')
        return
      }
      assert.equal(options.model, workerModel)
      assert.equal(options.maxTokens, 1_536)
      assert.deepEqual(options.tools ?? [], [])
      const latest = options.messages.findLast(message => message.source?.kind === 'dshpa-work-input')
      assert.ok(latest)
      const text = latest.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.match(text, /Task context follows as data/u)
      const cursor = /"cursor": "([^"]+)"/u.exec(text)?.[1]
      if (cursor === 'pa011-web-revocation-1' || cursor === 'pa011-web-revocation-2') {
        assert.match(text, /Foreign Indigo Canary/u)
        assert.doesNotMatch(text, /蓝海目标/u)
        if (cursor.endsWith('-2')) assert.match(text, /择期复核证据/u)
        yield* answer(JSON.stringify({ kind: 'waiting', cursor, summary: 'Confirm the next scoped input.', wait: {
          reason: 'input', referenceId: `${cursor}-question`, resumeCondition: 'Confirm the next scoped input.',
        } }))
        return
      }
      assert.match(text, /蓝海目标/u)
      assert.doesNotMatch(text, /Foreign Indigo Canary/u)
      if (cursor === 'pa011-web-worker-start') {
        yield* answer(JSON.stringify({ kind: 'waiting', cursor, summary: 'Confirm the review date.', wait: {
          reason: 'input', referenceId: 'pa011-web-question', resumeCondition: 'Confirm the review date.',
        } }))
        return
      }
      assert.equal(cursor, 'pa011-web-worker-answer')
      assert.match(text, /周五复核/u)
      yield* answer(JSON.stringify({ kind: 'ready', cursor, summary: '独特结果标记。 The scoped Worker saw the injected context.', artifactIds: [] }))
    }
  }
  ctx.llm.registerAdapter([provider], new FixtureModel())
  const cwd = realpathSync(process.cwd())
  for (const [sessionId, agentPreset] of [[primary, 'dshpa-context'], [foreign, 'dshpa-context'], [stock, 'minimal']]) {
    const created = await ctx.sessionController.create({ sessionId, cwd, agentPreset })
    assert.equal(created.sessionId, sessionId)
    await ctx.sessionController.selectModel({ sessionId, provider, model: chatModel })
  }
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
