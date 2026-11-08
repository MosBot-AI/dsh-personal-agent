import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { mobilePage, mobileScript, mobileStyles } from '../client/mobile-page.js'
import type { MobileDeviceLedger } from './devices.js'
import type { MobileFeed } from './events.js'

const cookieName = '__Host-dshpa-mobile'
const cookieAttributes = 'Path=/; Secure; HttpOnly; SameSite=Strict'
const pairSchema = z.strictObject({ code: z.string().regex(/^[a-zA-Z0-9_-]{43}$/u) })
const bodyLimit = 2_048
const pollMs = 1_000
const maximumStreams = 24

export const mobileHttpConfigSchema = z.strictObject({
  origin: z.string().max(512).refine(value => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value
    } catch { return false }
  }, 'Expected a canonical HTTPS origin'),
  port: z.int().min(1024).max(65535),
})
type MobileHttpConfig = z.output<typeof mobileHttpConfigSchema>

function credentialOf(request: IncomingMessage): string | undefined {
  const values = (request.headers.cookie ?? '').split(';')
    .map(value => value.trim()).filter(value => value.startsWith(cookieName + '='))
  return values.length === 1 ? values[0]!.slice(cookieName.length + 1) : undefined
}

async function readPairing(request: IncomingMessage): Promise<{ code: string } | { error: 400 | 413 }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) return { error: 400 } as const
    size += chunk.length
    if (size > bodyLimit) return { error: 413 } as const
    chunks.push(chunk)
  }
  try {
    const input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
    const parsed = pairSchema.safeParse(JSON.parse(input))
    return parsed.success ? { code: parsed.data.code } : { error: 400 } as const
  } catch {
    return { error: 400 } as const
  }
}

function secureHeaders(response: ServerResponse) {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

function json(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

const failure = (response: ServerResponse, status: number, code: string) => json(response, status, { ok: false, code })

/** A narrow loopback upstream for the operator's HTTPS reverse proxy. */
export function startMobileHttp(config: MobileHttpConfig, devices: MobileDeviceLedger, feed: MobileFeed) {
  const origin = new URL(config.origin)
  const active = new Map<string, number>()
  let streamCount = 0
  let pairWindow = 0
  let pairCount = 0
  let closing: Promise<void> | undefined

  function stream(response: ServerResponse, id: string, credential: string | undefined, cursor: string | null) {
    if (streamCount >= maximumStreams || (active.get(id) ?? 0) >= 2) return failure(response, 429, 'stream_capacity')
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    streamCount++
    active.set(id, (active.get(id) ?? 0) + 1)
    let position = cursor
    let ticks = 0
    const write = (text: string) => {
      if (!response.write(text)) response.end()
    }
    const poll = () => {
      try {
        const replay = feed.replay(credential, position)
        if (!replay.ok) {
          const event = replay.code === 'unauthorized' ? 'session-ended' : 'snapshot-required'
          response.end('event: ' + event + '\ndata: {}\n\n')
          return
        }
        position = replay.cursor
        if (replay.events.length) {
          write(replay.events.map(event => 'id: ' + event.cursor + '\nevent: work\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
        } else if (++ticks % 10 === 0) write(': heartbeat\n\n')
      } catch {
        response.end()
      }
    }
    const timer = setInterval(poll, pollMs)
    response.once('close', () => {
      clearInterval(timer)
      streamCount--
      const remaining = (active.get(id) ?? 1) - 1
      if (remaining) active.set(id, remaining)
      else active.delete(id)
    })
    poll()
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    secureHeaders(response)
    const method = request.method
    const site = request.headers['sec-fetch-site']
    if (request.headers.host !== origin.host || (request.headers.origin !== undefined && request.headers.origin !== origin.origin)
      || (site !== undefined && site !== 'same-origin' && site !== 'none')
      || (method === 'POST' && request.headers.origin !== origin.origin)) return failure(response, 403, 'forbidden_origin')
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) return failure(response, 400, 'invalid_path')
    const url = new URL(request.url, origin)
    if (method === 'GET' && !url.search && (url.pathname === '/' || url.pathname === '/mobile.js' || url.pathname === '/mobile.css')) {
      const asset = url.pathname === '/mobile.js' ? ['text/javascript', mobileScript] : url.pathname === '/mobile.css'
        ? ['text/css', mobileStyles] : ['text/html', mobilePage(/^zh(?:[-,;]|$)/i.test(request.headers['accept-language'] ?? ''))]
      response.writeHead(200, { 'Content-Type': asset[0] + '; charset=utf-8' })
      response.end(asset[1])
      return
    }
    if (method === 'POST' && url.pathname === '/v1/pair' && !url.search) {
      const now = Date.now()
      if (now - pairWindow >= 10_000) { pairWindow = now; pairCount = 0 }
      if (++pairCount > 12) return failure(response, 429, 'pairing_rate_limited')
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return failure(response, 415, 'json_required')
      }
      const body = await readPairing(request)
      if ('error' in body) {
        if (body.error === 413) response.setHeader('Connection', 'close')
        return failure(response, body.error, 'invalid_pairing_request')
      }
      if (response.destroyed || !request.complete) return
      const result = devices.enroll(body.code)
      if (!result.ok) return failure(response, 401, result.code)
      response.setHeader('Set-Cookie', `${cookieName}=${result.credential}; ${cookieAttributes}; Expires=${new Date(result.device.expiresAt).toUTCString()}`)
      return json(response, 200, { ok: true })
    }
    const credential = credentialOf(request)
    if (method === 'GET' && url.pathname === '/v1/snapshot' && !url.search) {
      const snapshot = feed.snapshot(credential)
      return json(response, snapshot.ok ? 200 : 401, snapshot)
    }
    if (method === 'GET' && url.pathname === '/v1/events') {
      const device = devices.authenticate(credential)
      if (!device) return failure(response, 401, 'unauthorized')
      if (url.searchParams.getAll('cursor').length > 1 || [...url.searchParams.keys()].some(key => key !== 'cursor')) {
        return failure(response, 400, 'invalid_cursor')
      }
      const cursor = request.headers['last-event-id']
      if (Array.isArray(cursor)) return failure(response, 400, 'invalid_cursor')
      return stream(response, device.deviceId, credential, cursor ?? url.searchParams.get('cursor'))
    }
    return failure(response, 404, 'not_found')
  }

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 8_000 }, (request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) response.end()
      else failure(response, 503, 'mobile_unavailable')
    })
  })
  server.maxConnections = 128
  const ready = new Promise<void>(resolve => {
    server.once('error', () => resolve())
    server.listen(config.port, '127.0.0.1', resolve)
  })

  return Object.freeze({
    available: () => server.listening && closing === undefined,
    close() {
      return closing ??= ready.then(() => new Promise<void>(resolve => {
        if (!server.listening) { resolve(); return }
        server.close(() => resolve())
        server.closeAllConnections()
      }))
    },
  })
}
