import { z } from 'zod'
import type { ProviderFailureCode } from '@mosbot-ai/dshpa-plugin-api'

export class BackendError extends Error {
  constructor(readonly code: ProviderFailureCode) { super(code) }
}

export const originSchema = z.string().refine(value => {
  try {
    const url = new URL(value)
    return url.origin === value && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}, 'Expected a canonical HTTP loopback origin')

export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new BackendError('invalid_result')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, size)
      size += value.byteLength
      if (size > limit) throw new BackendError('invalid_result')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function createComfyHttp(origin: string, timeoutMs: number) {
  async function request(path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    try {
      return await fetch(origin + path, {
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        ...(body === undefined ? {} : {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }),
      })
    } catch {
      throw new BackendError(body === undefined ? 'provider_unavailable' : 'uncertain')
    }
  }

  async function json<S extends z.ZodType>(path: string, schema: S, signal: AbortSignal, body?: unknown): Promise<z.output<S>> {
    const response = await request(path, signal, body)
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new BackendError(response.status === 429 ? 'rate_limited' : 'provider_unavailable')
    }
    try {
      const bytes = await readBounded(response, 4 * 1024 * 1024)
      return schema.parse(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      if (error instanceof BackendError) throw error
      throw new BackendError('invalid_result')
    }
  }

  return { request, json }
}
