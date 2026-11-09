import { expect, it } from 'vitest'
import { readBounded } from '../../packages/media-comfyui/src/http.js'

it('classifies an output body timeout as a retryable transport failure', async () => {
  let reads = 0
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]))
      else controller.error(new DOMException('Timed out', 'TimeoutError'))
    },
  }))
  await expect(readBounded(response, 100)).rejects.toMatchObject({ code: 'provider_unavailable' })
})

it('keeps a successfully delivered oversized body invalid and cancels its stream', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(3)) },
    cancel() { cancelled = true },
  }))
  await expect(readBounded(response, 2)).rejects.toMatchObject({ code: 'invalid_result' })
  expect(cancelled).toBe(true)
})
