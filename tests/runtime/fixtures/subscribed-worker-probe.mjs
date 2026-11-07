import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { workerMessageDigest } from './node_modules/@mosbot-ai/dshpa/lib/runtime/recovery-session.js'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'dshpa', 'agents', 'llm']

async function run(ctx) {
  let modelCalls = 0
  class Model extends LlmAdapter {
    async *stream(options) {
      modelCalls++
      assert.doesNotMatch(JSON.stringify(options.messages), /Revoked observation/)
      const text = 'Unrelated worker result.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['pa010-fixture'], new Model())
  const runtime = ctx.dshpa.host.workerRuntime
  const options = {
    cwd: process.cwd(), provider: 'pa010-fixture', model: 'scripted',
    resume: false, signal: new AbortController().signal, isCurrent: () => true,
  }
  const primaryId = 'pa010-revoked-worker'
  const unrelatedId = 'pa010-unrelated-worker'
  const primary = await runtime.open({ ...options, sessionId: primaryId })
  const unrelated = await runtime.open({ ...options, sessionId: unrelatedId })
  try {
    const native = ctx.agents.get(primaryId)
    assert.ok(native)
    let authorized = true
    let acknowledgements = 0
    const text = 'Revoked observation from the subscribed account.'
    await native.runMaintenance(async () => {
      await primary.followup({
        cursor: 'revoked-cursor',
        messageId: 'pa010-revoked-input',
        text,
        digest: workerMessageDigest(text),
        authorize: () => authorized,
        acknowledge: () => {
          acknowledgements++
          return true
        },
      })
      assert.equal(acknowledgements, 1)
      assert.equal(modelCalls, 0)
      // The exact input was flushed and acknowledged, then its subscription
      // was revoked before the native driver reached pre-step.
      authorized = false
    })
    await primary.whenIdle()
    assert.equal(modelCalls, 0)
    assert.equal(primary.readReport(), undefined)

    const otherText = 'Unrelated input remains usable.'
    await unrelated.followup({
      cursor: 'unrelated-cursor', messageId: 'pa010-unrelated-input',
      text: otherText, digest: workerMessageDigest(otherText), acknowledge: () => true,
    })
    await unrelated.whenIdle()
    assert.equal(modelCalls, 1)
    assert.equal(unrelated.readReport(), 'Unrelated worker result.')
    assert.equal(await primary.stop(), true)
    assert.ok(ctx.agents.get(unrelatedId), 'Revocation and stop must leave unrelated native handles active')
  } finally {
    await Promise.all([primary.stop(), unrelated.stop()])
  }
  console.log('PA010_NATIVE_REVOKED_INPUT_DENIED')
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void run(ctx).then(() => ctx.appExit(0), error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
