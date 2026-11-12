import assert from 'node:assert/strict'
import { appendFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'llm', 'sessionController']

async function initialize(ctx) {
  const provider = 'dshpa-admission-benchmark-fixture'
  const model = 'controlled-hold'
  const sessionId = 'admission-benchmark-session'
  const trace = join(process.env.DSH_HOME, 'fixture-streams.jsonl')
  writeFileSync(trace, '', { mode: 0o600 })
  class HeldModel extends LlmAdapter {
    async listModels() { return [{ provider, id: model, name: model }] }
    async resolveModel() { return { provider, id: model, name: model, context: { contextWindow: 65_536 } } }
    async *stream(options) {
      assert.equal(options.model, model)
      assert.deepEqual(options.tools ?? [], [])
      const message = options.messages.findLast(message => message.source?.kind === 'dshpa-work-input')
      const cursor = message?.source?.cursor ?? 'unexpected'
      appendFileSync(trace, JSON.stringify(cursor) + '\n')
      assert.match(cursor, /^held-worker-[1-4]$/u)
      const { signal } = options
      assert.ok(signal)
      await new Promise(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
      signal.throwIfAborted()
    }
  }
  ctx.llm.registerAdapter([provider], new HeldModel())
  const session = await ctx.sessionController.create({
    sessionId, cwd: realpathSync(process.cwd()), agentPreset: 'minimal',
  })
  assert.equal(session.sessionId, sessionId)
  console.log('DSHPA_WEB_FLOW_READY')
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void initialize(ctx).catch(error => { console.error(error); ctx.appExit(1) })
  }))
}
