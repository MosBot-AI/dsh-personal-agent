import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { onTestFinished } from 'vitest'

export const rates = { input: 300_000, output: 1_200_000, cacheRead: 6_000, cacheWrite: 300_000 }
export const model = 'deepseek-flash'
export const outputLimit = 256
const requestLimit = 32_768
const responseLimit = 256 * 1024
const costCeiling = 10_000
type Arm = 'foreground' | 'worker'

class PairFailure extends Error {}

function requirePair(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PairFailure(message)
}

export async function openPairedModel(key: string) {
  const token = randomUUID()
  let armed: { arm: Arm; outcome: string; calls: number; complete?: ReturnType<typeof readUsage> } | undefined
  let fault: string | undefined
  const measured = new Set<Arm>()
  const server = createServer(async (request, response) => {
    try {
      requirePair(request.headers['x-api-key'] === token, 'Unexpected fixture credential')
      requirePair(armed && request.method === 'POST' && request.url === '/v1/messages', 'Unexpected provider route')
      const sample = armed
      requirePair(++sample.calls === 1, 'The arm already consumed its single provider request')
      const signal = AbortSignal.timeout(30_000)
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        requirePair(bytes <= requestLimit, 'The wire request exceeded its input limit')
        chunks.push(chunk)
      }
      const payload = Buffer.concat(chunks).toString('utf8')
      const wire = JSON.parse(payload) as { model: string; max_tokens: number; stream: boolean;
        thinking?: { type: string }; tools?: unknown[]; messages: unknown[] }
      requirePair(wire.model === model, 'Unexpected model ID')
      requirePair(wire.max_tokens === outputLimit, 'Unexpected output token limit')
      requirePair(wire.stream === true && wire.thinking?.type === 'disabled', 'Unexpected provider stream or thinking mode')
      requirePair((wire.tools?.length ?? 0) === 0, 'The request declared model tools')
      requirePair(JSON.stringify(wire.messages).includes(JSON.stringify(sample.outcome).slice(1, -1)), 'Task text did not match')
      requirePair(Math.ceil((bytes * rates.input + outputLimit * rates.output) / 1_000_000) <= costCeiling,
        'The wire estimate exceeded the cost ceiling')
      const upstream = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST', body: payload, redirect: 'error', signal,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01',
          'content-type': 'application/json', accept: 'text/event-stream' },
      })
      requirePair(upstream.ok && upstream.body && upstream.headers.get('content-type')?.includes('text/event-stream'),
        `Provider response status ${upstream.status}`)
      const eventChunks: Uint8Array[] = []
      let responseBytes = 0
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for await (const chunk of upstream.body) {
        responseBytes += chunk.byteLength
        requirePair(responseBytes <= responseLimit, 'The wire response exceeded its size limit')
        eventChunks.push(chunk)
        response.write(chunk)
      }
      sample.complete = readUsage(Buffer.concat(eventChunks).toString('utf8'))
      response.end()
    } catch (error) {
      // Never expose working credentials, prompts, or raw provider errors.
      fault ??= error instanceof PairFailure ? error.message : 'The matched provider exchange did not complete'
      if (response.headersSent) response.destroy()
      else response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: {
        type: 'invalid_request_error', message: fault,
      } }))
    }
  })
  onTestFinished(async () => {
    if (server.listening) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    token,
    baseURL: `http://127.0.0.1:${address.port}`,
    check() {
      assert.ok(!fault, fault)
    },
    begin(arm: Arm, outcome: string) {
      assert.ok(!armed && !measured.has(arm) && !fault, fault)
      armed = { arm, outcome, calls: 0 }
    },
    finish(arm: Arm) {
      assert.ok(!fault, fault)
      assert.ok(armed?.arm === arm && armed.calls === 1 && armed.complete, 'The pair requires one completed provider stream per arm')
      const result = armed.complete
      armed = undefined
      measured.add(arm)
      return result
    },
  }
}

function readUsage(sse: string) {
  const fields: Record<string, unknown> = {}
  let stopReason: string | undefined
  for (const line of sse.split(/\r?\n/u)) {
    if (!line.startsWith('data: {')) continue
    const value = JSON.parse(line.slice(6)) as { type: string; message?: { usage?: Record<string, unknown> };
      usage?: Record<string, unknown>; delta?: { stop_reason?: string } }
    if (value.type === 'message_start') Object.assign(fields, value.message?.usage)
    if (value.type === 'message_delta') {
      Object.assign(fields, value.usage)
      stopReason = value.delta?.stop_reason
    }
  }
  requirePair(stopReason !== 'max_tokens', 'The provider stopped at the output token limit')
  requirePair(stopReason === 'end_turn', 'The provider did not finish the turn normally')
  function tokens(value: unknown) {
    assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return value
  }
  const inputTokens = tokens(fields.input_tokens)
  const outputTokens = tokens(fields.output_tokens)
  const cacheReadTokens = tokens(fields.cache_read_input_tokens ?? 0)
  const cacheWriteTokens = tokens(fields.cache_creation_input_tokens ?? 0)
  requirePair(outputTokens > 0 && outputTokens <= outputLimit, 'Reported output usage exceeded the bound')
  const estimate = Math.ceil((inputTokens * rates.input + outputTokens * rates.output
    + cacheReadTokens * rates.cacheRead + cacheWriteTokens * rates.cacheWrite) / 1_000_000)
  requirePair(estimate <= costCeiling, 'Reported usage exceeded the cost ceiling')
  return { usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens }, estimatedCostMicrosUsd: estimate }
}
