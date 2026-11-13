import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { requestIdSchema, sha256DigestSchema, versionSchema } from '../domain/model.js'
import type { MobileApprovals } from './approvals.js'
import { mobileIcon, mobileManifest, mobilePage, mobileScript, mobileStyles } from '../client/mobile-page.js'
import type { MobileDeviceLedger } from './devices.js'
import type { MobileFeed } from './events.js'
import { sharedCapabilities, sharedError } from './shared-client.js'

const cookieName = '__Host-dshpa-mobile'
const cookieAttributes = 'Path=/; Secure; HttpOnly; SameSite=Strict'
const pairSchema = z.strictObject({ code: z.string().regex(/^[a-zA-Z0-9_-]{43}$/u) })
const responseSchema = z.strictObject({
  expectedVersion: versionSchema, digest: sha256DigestSchema, decision: z.enum(['approve', 'deny']),
})
const bodyLimit = 2_048
const pollMs = 1_000
const maximumStreams = 24
const assets = new Map<string, readonly [string, string]>([
  ['/mobile.js', ['text/javascript', mobileScript]],
  ['/mobile.css', ['text/css', mobileStyles]],
  ['/mobile.webmanifest', ['application/manifest+json', mobileManifest]],
  ['/mobile.svg', ['image/svg+xml', mobileIcon]],
])

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

async function readJson<S extends z.ZodType>(request: IncomingMessage, schema: S):
Promise<{ input: z.output<S> } | { error: 400 | 413 | 415 }> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return { error: 415 }
  }
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
    const parsed = schema.safeParse(JSON.parse(input))
    return parsed.success ? { input: parsed.data } : { error: 400 }
  } catch {
    return { error: 400 } as const
  }
}

function secureHeaders(response: ServerResponse) {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; manifest-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

function json(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

const failure = (response: ServerResponse, status: number, code: string) => json(response, status, { ok: false, code })

/** A narrow loopback upstream for the operator's HTTPS reverse proxy. */
export function startMobileHttp(config: MobileHttpConfig, devices: MobileDeviceLedger, feed: MobileFeed, approvals: MobileApprovals) {
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
    let approvalRevision: string | undefined
    const write = (text: string) => {
      if (!response.writableEnded && !response.write(text)) response.end()
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
        } else if (ticks % 10 === 0) write(': heartbeat\n\n')
        if (ticks++ % 4 === 0 && !response.writableEnded) {
          const revision = approvals.revision(credential)
          if (!revision.ok) { response.end('event: session-ended\ndata: {}\n\n'); return }
          if (revision.value !== approvalRevision) {
            approvalRevision = revision.value
            write('event: approvals\ndata: {}\n\n')
          }
        }
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
    const sharedRoute = request.url?.split('?')[0] === '/v1/capabilities' || request.url?.split('?')[0] === '/v1/tasks'
    const site = request.headers['sec-fetch-site']
    if (request.headers.host !== origin.host || (request.headers.origin !== undefined && request.headers.origin !== origin.origin)
      || (site !== undefined && site !== 'same-origin' && site !== 'none')
      || (method === 'POST' && request.headers.origin !== origin.origin)) {
      return sharedRoute ? json(response, 403, sharedError('forbidden', 'The request origin is not allowed.'))
        : failure(response, 403, 'forbidden_origin')
    }
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) return failure(response, 400, 'invalid_path')
    const url = new URL(request.url, origin)
    if (method === 'GET' && !url.search) {
      const asset = url.pathname === '/'
        ? ['text/html', mobilePage(/^zh(?:[-,;]|$)/i.test(request.headers['accept-language'] ?? ''))]
        : assets.get(url.pathname)
      if (asset) {
        response.writeHead(200, { 'Content-Type': asset[0] + '; charset=utf-8' })
        response.end(asset[1])
        return
      }
    }
    if (method === 'POST' && url.pathname === '/v1/pair' && !url.search) {
      const now = Date.now()
      if (now - pairWindow >= 10_000) { pairWindow = now; pairCount = 0 }
      if (++pairCount > 12) return failure(response, 429, 'pairing_rate_limited')
      const body = await readJson(request, pairSchema)
      if ('error' in body) {
        if (body.error === 413) response.setHeader('Connection', 'close')
        return failure(response, body.error, 'invalid_pairing_request')
      }
      if (response.destroyed || !request.complete) return
      const result = devices.enroll(body.input.code)
      if (!result.ok) return failure(response, 401, result.code)
      response.setHeader('Set-Cookie', `${cookieName}=${result.credential}; ${cookieAttributes}; Expires=${new Date(result.device.expiresAt).toUTCString()}`)
      return json(response, 200, { ok: true })
    }
    const credential = credentialOf(request)
    if (sharedRoute) {
      if (!devices.authenticate(credential)) return json(response, 401, sharedError('auth_required', 'Device authentication is required.'))
      if (method !== 'GET') return json(response, 400, sharedError('invalid_request', 'This route requires GET.'))
      if (url.pathname === '/v1/capabilities') {
        if (url.search) return json(response, 400, sharedError('invalid_request', 'Discovery does not accept query parameters.'))
        return json(response, 200, sharedCapabilities(true))
      }
      const limit = url.searchParams.get('limit')
      const cursor = url.searchParams.get('cursor')
      if ([...url.searchParams.keys()].some(key => key !== 'limit' && key !== 'cursor')
        || url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('cursor').length > 1
        || (limit !== null && (!/^[1-9]\d?$/u.test(limit) || Number(limit) > 64))
        || (cursor !== null && (cursor === '' || [...cursor].length > 2048))) {
        return json(response, 400, sharedError('invalid_request', 'Invalid task list query.'))
      }
      const result = feed.sharedTasks(credential, limit === null ? 32 : Number(limit), cursor)
      if (!result.ok) {
        const code = result.code === 'unauthorized' ? 'auth_required' : result.code
        return json(response, code === 'auth_required' ? 401 : 400,
          sharedError(code, code === 'cursor_invalid' ? 'Restart task pagination without a cursor.' : 'Invalid task list request.'))
      }
      return json(response, 200, result.page)
    }
    if (method === 'GET' && url.pathname === '/v1/snapshot' && !url.search) {
      const snapshot = feed.snapshot(credential)
      return json(response, snapshot.ok ? 200 : 401, snapshot)
    }
    if (method === 'GET' && url.pathname === '/v1/approvals' && !url.search) {
      const result = approvals.list(credential)
      return json(response, result.ok ? 200 : 401, result)
    }
    const approvalPath = /^\/v1\/approvals\/([^/]+)\/responses$/u.exec(url.pathname)
    if (method === 'POST' && approvalPath && !url.search) {
      if (!devices.authenticate(credential)) return failure(response, 401, 'unauthorized')
      let requestId
      try { requestId = requestIdSchema.parse(decodeURIComponent(approvalPath[1]!)) }
      catch { return failure(response, 400, 'invalid_input') }
      const body = await readJson(request, responseSchema)
      if ('error' in body) {
        if (body.error === 413) response.setHeader('Connection', 'close')
        return failure(response, body.error, 'invalid_input')
      }
      if (response.destroyed || !request.complete) return
      const result = approvals.respond(credential, { requestId, ...body.input })
      const status = result.ok ? 200 : result.code === 'unauthorized' ? 401 : result.code === 'not_found' ? 404 : 409
      return json(response, status, result)
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
      else if (request.url?.split('?')[0] === '/v1/capabilities' || request.url?.split('?')[0] === '/v1/tasks') {
        json(response, 503, sharedError('internal_unavailable', 'The shared API is temporarily unavailable.'))
      } else failure(response, 503, 'mobile_unavailable')
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
