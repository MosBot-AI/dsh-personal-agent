import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxRequest, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { openWebHost } from './fixtures/web-host.js'

const probe = fileURLToPath(new URL('./fixtures/mobile-flow-probe.mjs', import.meta.url))
const origin = 'https://mobile.test'
const mobileHost = new URL(origin).host

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  assert.ok(address && typeof address !== 'string')
  return address.port
}

async function frame(response: Response, match: string) {
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body?.getReader()
  assert.ok(reader)
  let text = ''
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) throw new Error('Stream ended before expected event: ' + match)
      text += decoder.decode(result.value, { stream: true })
      if (text.includes(match)) return text
      if (text.length > 65_536) throw new Error('Expected one bounded test event')
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

it('pairs through the native owner inbox and reconnects and revokes through the actual mobile HTTP listener', async () => {
  const port = await availablePort()
  const host = await openWebHost(probe, { patch: [
    '- id: dshpa', '  config:', '    inbox:',
    "      storageDirectory: !!js dshHomePath('mobile-inbox')", '      workRoot: !!js process.cwd()',
    '      mobile:', `        origin: ${origin}`, `        port: ${port}`,
  ] })
  const owner = await host.exchange()
  const operator = await host.exchange(true)
  const inbox = async (request: InboxRequest) => {
    const response = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, owner)
    assert.ok(response.status === 200 && response.result?.ok, host.diagnostics())
    return response.result.value
  }
  type MobileRequest = { method?: string; headers?: Record<string, string>; body?: string }
  function mobile(path: string, request?: MobileRequest): Promise<Response> {
    return new Promise((resolve, reject) => {
      const call = httpRequest({
        hostname: '127.0.0.1', port, path, method: request?.method ?? 'GET',
        headers: { host: mobileHost, ...request?.headers }, signal: AbortSignal.timeout(8_000),
      }, incoming => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(incoming.headers)) {
          for (const part of Array.isArray(value) ? value : [value]) {
            if (part !== undefined) headers.append(key, part)
          }
        }
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status: incoming.statusCode, headers }))
      })
      call.once('error', reject)
      call.end(request?.body)
    })
  }
  async function status(path: string, expected: number, request?: MobileRequest) {
    const response = await mobile(path, request)
    expect(response.status).toBe(expected)
    await response.body?.cancel()
  }

  expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'mobile_pair', label: 'Phone' })).toMatchObject({ status: 401 })
  expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'mobile_pair', label: 'Phone' }, operator)).toMatchObject({ status: 403 })
  expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'mobile_pair', label: 'Phone' }, owner, 'https://elsewhere.test'))
    .toMatchObject({ status: 403 })
  await vi.waitFor(async () => expect(await inbox({ type: 'mobile_devices' })).toMatchObject({ available: true }))

  const page = await mobile('/', { headers: { 'accept-language': 'zh-CN' } })
  expect(page.status).toBe(200)
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(await page.text()).toContain('dshpa 移动工作台')
  const script = await mobile('/mobile.js')
  expect(script.status).toBe(200)
  const scriptText = await script.text()
  expect(() => new Script(scriptText)).not.toThrow()

  const result = await inbox({ type: 'mobile_pair', label: 'Fixture phone' })
  assert.ok(result.ok && result.kind === 'mobile_pair')
  expect(result.origin).toBe(origin)
  const pair = { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: result.pairingCode }) }
  await status('/v1/snapshot', 401)
  await status('/v1/pair', 403, { ...pair, headers: { ...pair.headers, origin: 'https://elsewhere.test' } })
  await status('/v1/pair', 403, { ...pair, headers: { ...pair.headers, host: 'elsewhere.test' } })
  await status('/v1/pair', 403, { ...pair, headers: { ...pair.headers, 'sec-fetch-site': 'same-site' } })
  await status('/v1/pair', 400, { ...pair, body: JSON.stringify({ code: result.pairingCode, deviceId: 'forged' }) })
  const paired = await mobile('/v1/pair', pair)
  expect(paired.status).toBe(200)
  const cookieHeader = paired.headers.get('set-cookie')
  assert.ok(cookieHeader)
  expect(cookieHeader).toMatch(/^__Host-dshpa-mobile=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict;/u)
  const cookie = cookieHeader.split(';')[0]!
  expect(await paired.json()).toEqual({ ok: true })
  await status('/v1/pair', 401, pair)
  await status('/api/dshpa/inbox', 404, { headers: { cookie } })
  expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'snapshot' }, cookie)).toMatchObject({ status: 401 })
  expect(await (await mobile('/v1/snapshot', { headers: { cookie } })).json()).toEqual({ ok: true, cursor: null, tasks: [] })

  const initialStream = await mobile('/v1/events', { headers: { cookie } })
  const project = await inbox({ type: 'create_project', commandId: 'mobile-project', title: 'Fixture project', purpose: 'Test the mobile view' })
  assert.ok(project.ok && project.kind === 'updated' && project.projectId)
  const create = (suffix: string) => inbox({ type: 'create_task', projectId: project.projectId!, sessionId: 'mobile-fixture-chat',
    commandId: 'mobile-create-' + suffix, outcome: 'Review ' + suffix })
  const first = await create('one')
  assert.ok(first.ok && first.kind === 'updated' && first.taskId)
  expect(await frame(initialStream, 'event: work')).toContain(first.taskId)

  const snapshot = await (await mobile('/v1/snapshot', { headers: { cookie } })).json()
  const localSnapshot = await inbox({ type: 'snapshot' })
  assert.ok(localSnapshot.ok && localSnapshot.kind === 'snapshot')
  const localTask = localSnapshot.snapshot.tasks.find(task => task.id === first.taskId)
  assert.ok(localTask)
  expect(snapshot.tasks).toEqual([{ id: first.taskId, projectId: project.projectId, outcome: localTask.outcome,
    version: localTask.version, status: localTask.status }])
  expect(JSON.stringify(snapshot)).not.toContain('mobile-fixture-chat')
  const second = await create('two')
  assert.ok(second.ok && second.kind === 'updated' && second.taskId)
  const replay = await mobile('/v1/events', { headers: { cookie, 'last-event-id': snapshot.cursor } })
  expect(await frame(replay, 'event: work')).toContain(second.taskId)
  expect(await frame(await mobile('/v1/events?cursor=bad', { headers: { cookie } }), 'snapshot-required')).toContain('event: snapshot-required')

  const devices = await inbox({ type: 'mobile_devices' })
  assert.ok(devices.ok && devices.kind === 'mobile_devices')
  const device = devices.devices.find(item => item.label === 'Fixture phone')
  assert.ok(device)
  const subscribed = await mobile('/v1/events?cursor=' + encodeURIComponent(snapshot.cursor), { headers: { cookie } })
  expect(await inbox({ type: 'mobile_revoke', deviceId: device.deviceId })).toMatchObject({ ok: true })
  expect(await frame(subscribed, 'session-ended')).toContain('event: session-ended')
  await status('/v1/snapshot', 401, { headers: { cookie } })
}, 25_000)
