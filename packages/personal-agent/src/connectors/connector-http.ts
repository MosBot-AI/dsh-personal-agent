import { ConnectorError } from './registry.js'

export const MAX_RESPONSE_BYTES = 1024 * 1024

export async function boundedConnectorJson(response: Response, limit = MAX_RESPONSE_BYTES): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
  const length = Number(response.headers.get('content-length') ?? 0)
  if (contentType !== 'application/json' || length > limit || !response.body) {
    await response.body?.cancel()
    throw new ConnectorError('invalid_result')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > limit) throw new ConnectorError('invalid_result')
      chunks.push(result.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown
  } catch {
    throw new ConnectorError('invalid_result')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
