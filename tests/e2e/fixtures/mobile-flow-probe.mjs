import assert from 'node:assert/strict'

export const inject = ['appReady', 'appExit', 'dshpaRouting', 'sessionController']

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void (async () => {
      const chat = await ctx.sessionController.create({ sessionId: 'mobile-fixture-chat', cwd: process.cwd(), agentPreset: 'minimal' })
      assert.equal(chat.sessionId, 'mobile-fixture-chat')
      console.log('DSHPA_WEB_FLOW_READY')
    })().catch(error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
