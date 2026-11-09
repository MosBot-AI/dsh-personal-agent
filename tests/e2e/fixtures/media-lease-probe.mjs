import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const inject = ['appReady', 'appExit', 'dshpaCompute']

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(async () => {
    try {
      const { access, held } = JSON.parse(readFileSync('media-lease.json', 'utf8'))
      let started = false
      const admission = ctx.get('dshpaCompute').gpu.enqueue(access, () => true, async () => {
        started = true
        return 'completed'
      })
      if (held) {
        assert.deepEqual(admission, { ok: false, code: 'permission_denied' })
        assert.equal(started, false)
      } else {
        assert.equal(admission.ok, true)
        assert.deepEqual(await admission.completion, { ok: true, value: 'completed' })
        assert.equal(started, true)
      }
      console.log('DSHPA_WEB_FLOW_READY')
    } catch (error) {
      console.error(error)
      ctx.appExit(1)
    }
  }))
}
