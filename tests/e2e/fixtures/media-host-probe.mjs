import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const inject = ['appReady', 'appExit', 'dshpaMedia']

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    try {
      const request = JSON.parse(readFileSync('media-request.json', 'utf8'))
      const media = ctx.get('dshpaMedia')
      const staleAccess = { ...request.access, generation: request.access.generation + 1 }
      assert.deepEqual(media.inspect({ access: staleAccess, operationId: request.operationId }),
        { ok: false, code: 'permission_denied' })
      const enqueued = media.enqueue(request)
      assert.ok(enqueued.ok, 'Native media enqueue failed: ' + enqueued.code)
      console.log('DSHPA_WEB_FLOW_READY')
    } catch (error) {
      console.error(error)
      ctx.appExit(1)
    }
  }))
}
