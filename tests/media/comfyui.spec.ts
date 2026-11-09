import { createHash } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { accepted, comfyFixture, imageSpec, mediaRequest, videoSpec } from './fixture.js'

it('uses approved versioned local graphs and verifies decoded video output', async () => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  onTestFinished(() => registry.close())
  const request = mediaRequest(videoSpec)
  const prepared = accepted(await registry.invoke(pin, (provider, signal) => provider.durableSubmission!.prepare(request, signal)))
  const invalid = await registry.invoke(pin, (provider, signal) =>
    provider.durableSubmission!.submit({ ...request, prompt: 'Changed input' }, prepared, signal))
  expect(invalid).toEqual({ ok: false, code: 'conflict' })
  expect(fixture.submissions).toHaveLength(0)
  const handle = accepted(await registry.invoke(pin, (provider, signal) => provider.durableSubmission!.submit(request, prepared, signal)))
  expect(handle).toEqual(prepared.handle)
  const bytes = fixture.complete(handle.handleId, videoSpec)
  const output = accepted(await registry.invoke(pin, (provider, signal) => provider.collect({ access: request.access, handle }, signal)))
  expect(output).toMatchObject([{ mediaType: 'video/mp4', width: 16, height: 16, durationMs: 500,
    sizeBytes: bytes.length, contentHash: createHash('sha256').update(bytes).digest('hex') }])
})

it('limits cancellation to a verified handle and waits when a queued job starts during cancellation', async () => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  onTestFinished(() => registry.close())
  const request = mediaRequest(imageSpec)
  const prepared = accepted(await registry.invoke(pin, (provider, signal) => provider.durableSubmission!.prepare(request, signal)))
  const handle = accepted(await registry.invoke(pin, (provider, signal) => provider.durableSubmission!.submit(request, prepared, signal)))
  fixture.pending.set('unrelated', [1, 'unrelated', {}, {}, []])
  const foreign = { ...request.access, taskId: 'other-task' }
  expect(await registry.invoke(pin, (provider, signal) => provider.cancel({ access: foreign, handle }, signal)))
    .toEqual({ ok: false, code: 'permission_denied' })
  expect(fixture.cancelled).toEqual([])
  fixture.faults.cancelRace = true
  expect(await registry.invoke(pin, (provider, signal) => provider.cancel({ access: request.access, handle }, signal)))
    .toEqual({ ok: true, value: { state: 'running' } })
  expect(fixture.cancelled).toEqual([handle.handleId])
  expect(fixture.pending.has('unrelated')).toBe(true)
})

it('rejects a network node and fails closed on an untrusted submit redirect', async () => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  onTestFinished(() => registry.close())
  const request = mediaRequest()
  fixture.faults.apiNode = true
  const prepare = () => registry.invoke(pin, (provider, signal) => provider.durableSubmission!.prepare(request, signal))
  expect(await prepare()).toEqual({ ok: false, code: 'unsupported_capability' })
  fixture.faults.apiNode = false
  const prepared = accepted(await prepare())
  fixture.faults.redirect = true
  expect(await registry.invoke(pin, (provider, signal) => provider.durableSubmission!.submit(request, prepared, signal)))
    .toEqual({ ok: false, code: 'uncertain' })
  expect(fixture.submissions).toHaveLength(0)
})

it('rejects corrupt image bytes and reports a terminal backend error', async () => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  onTestFinished(() => registry.close())
  async function submit(operationId: string) {
    const request = { ...mediaRequest(), operationId }
    const prepared = accepted(await registry.invoke(pin, (provider, signal) => provider.durableSubmission!.prepare(request, signal)))
    const handle = accepted(await registry.invoke(pin, (provider, signal) => provider.durableSubmission!.submit(request, prepared, signal)))
    return { access: request.access, handle }
  }
  const corrupt = await submit('bad-bytes')
  fixture.complete(corrupt.handle.handleId, imageSpec, true)
  expect(await registry.invoke(pin, (provider, signal) => provider.collect(corrupt, signal))).toEqual({ ok: false, code: 'invalid_result' })
  const failed = await submit('oom')
  fixture.fail(failed.handle.handleId)
  expect(await registry.invoke(pin, (provider, signal) => provider.inspect(failed, signal))).toEqual({ ok: true, value: { state: 'failed' } })
})
