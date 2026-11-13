import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxApproval, type InboxRequest, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { chromeStartupRetryAllowanceMs, openHeadlessChrome } from './fixtures/headless-chrome.js'
import { openWebHost, prepareWebHost } from './fixtures/web-host.js'

const probe = fileURLToPath(new URL('./fixtures/mobile-flow-probe.mjs', import.meta.url))

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

async function tlsProxy(root: string, upstreamPort: number) {
  const keyPath = join(root, 'fixture-proxy-key.pem')
  const certPath = join(root, 'fixture-proxy-cert.pem')
  const configPath = join(root, 'fixture-proxy-openssl.conf')
  writeFileSync(configPath, [
    '[req]', 'distinguished_name = dn', 'prompt = no', 'x509_extensions = extensions',
    '[dn]', 'CN = 127.0.0.1', '[extensions]', 'subjectAltName = IP:127.0.0.1', '',
  ].join('\n'), { mode: 0o600 })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-config', configPath, '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 10_000 })
  const cert = readFileSync(certPath)
  let available = true
  let silenceEvents = false
  let mutedFrames = 0
  const server = createHttpsServer({ key: readFileSync(keyPath), cert }, (request, response) => {
    if (!available) { request.socket.destroy(); return }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, path: request.url,
      method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers)
      if (incoming.headers['content-type']?.startsWith('text/event-stream')) {
        response.flushHeaders()
        incoming.on('data', chunk => {
          if (silenceEvents) mutedFrames++
          else if (!response.write(chunk)) {
            incoming.pause()
            response.once('drain', () => incoming.resume())
          }
        })
        incoming.once('end', () => { if (!silenceEvents) response.end() })
      } else incoming.pipe(response)
    })
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    response.once('close', () => upstream.destroy())
    request.pipe(upstream)
  })
  onTestFinished(async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()))
    server.closeAllConnections()
    await closed
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    cert, port: address.port, origin: `https://127.0.0.1:${address.port}`,
    silenceEvents(value: boolean) { silenceEvents = value },
    mutedFrames: () => mutedFrames,
    setAvailable(value: boolean) {
      available = value
      if (!available) server.closeAllConnections()
    },
  }
}

async function openMobile(approvals = false) {
  const port = await availablePort()
  const prepared = approvals ? prepareWebHost(probe) : undefined
  if (prepared) onTestFinished(() => rmSync(prepared.root, { recursive: true, force: true }))
  const proxy = prepared && await tlsProxy(prepared.root, port)
  const origin = proxy?.origin ?? 'https://mobile.test'
  const mobileHost = new URL(origin).host
  if (prepared) writeFileSync(join(prepared.root, 'mobile-review.json'), JSON.stringify({ origin, port }), { mode: 0o600 })
  const host = await openWebHost(probe, prepared ? { prepared } : { patch: [
    '- id: dshpa', '  config:', '    inbox:',
    "      storageDirectory: !!js dshHomePath('mobile-inbox')", '      workRoot: !!js process.cwd()',
    '      mobile:', `        origin: ${origin}`, `        port: ${port}`,
  ] })
  const owner = await host.exchange()
  const inbox = async (request: InboxRequest) => {
    const response = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, owner)
    assert.ok(response.status === 200 && response.result?.ok, host.diagnostics())
    return response.result.value
  }
  type MobileRequest = { method?: string; headers?: Record<string, string>; body?: string }
  function mobile(path: string, request?: MobileRequest): Promise<Response> {
    return new Promise((resolve, reject) => {
      const transport = proxy ? httpsRequest : httpRequest
      const call = transport({
        hostname: '127.0.0.1', port: proxy?.port ?? port, path, method: request?.method ?? 'GET',
        ...(proxy ? { ca: proxy.cert } : {}),
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
  async function pairDevice(label: string) {
    const response = await inbox({ type: 'mobile_pair', label })
    assert.ok(response.ok && response.kind === 'mobile_pair')
    const paired = await mobile('/v1/pair', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ code: response.pairingCode }) })
    expect(paired.status).toBe(200)
    const cookie = paired.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie)
    expect(await paired.json()).toEqual({ ok: true })
    const devices = await inbox({ type: 'mobile_devices' })
    assert.ok(devices.ok && devices.kind === 'mobile_devices')
    const device = devices.devices.find(item => item.label === label)
    assert.ok(device?.state === 'active')
    return { cookie, deviceId: device.deviceId }
  }
  await vi.waitFor(async () => expect(await inbox({ type: 'mobile_devices' })).toMatchObject({ available: true }))
  return { host, owner, inbox, mobile, status, pairDevice, origin, proxy }
}

it('pairs through the native owner inbox and reconnects and revokes through the actual mobile HTTP listener', async () => {
  const { host, owner, inbox, mobile, status, origin } = await openMobile()
  const operator = await host.exchange(true)
  expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'mobile_pair', label: 'Phone' })).toMatchObject({ status: 401 })
  expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'mobile_pair', label: 'Phone' }, operator)).toMatchObject({ status: 403 })
  expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'mobile_pair', label: 'Phone' }, owner, 'https://elsewhere.test'))
    .toMatchObject({ status: 403 })
  const page = await mobile('/', { headers: { 'accept-language': 'zh-CN' } })
  expect(page.status).toBe(200)
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(await page.text()).toContain('dshpa 移动工作台')
  const manifest = await mobile('/mobile.webmanifest')
  expect(manifest.headers.get('content-type')).toContain('application/manifest+json')
  expect(await manifest.json()).toMatchObject({ display: 'standalone', start_url: '/', icons: [{ src: '/mobile.svg' }] })
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


it('serves shared task pages and exact reviews through local HTTPS with native device authorization', async () => {
  const { host, inbox, mobile, status, pairDevice, origin } = await openMobile(true)
  const phone = await pairDevice('Primary phone')
  const other = await pairDevice('Second phone')
  const snapshotForStream = await mobile('/v1/snapshot', { headers: { cookie: phone.cookie } })
  expect(snapshotForStream.status).toBe(200)
  const { cursor } = await snapshotForStream.json() as { cursor: string | null }
  const eventsPath = cursor ? '/v1/events?cursor=' + encodeURIComponent(cursor) : '/v1/events'
  const heartbeatFrame = ': heartbeat\n\nevent: heartbeat\ndata: {}\n\n'
  const heartbeat = await frame(await mobile(eventsPath, { headers: { cookie: phone.cookie } }), heartbeatFrame)
  expect(heartbeat).toContain(heartbeatFrame)
  expect(heartbeat).not.toContain('id:')
  const shared = async (path: string, expected: number, cookie?: string) => {
    const response = await mobile(path, cookie ? { headers: { cookie } } : undefined)
    expect(response.status).toBe(expected)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.schema_version).toBe('personal.api.v1')
    return body
  }
  expect(await shared('/v1/capabilities', 401)).toMatchObject({ error: { code: 'auth_required' } })
  const discovery = await shared('/v1/capabilities', 200, phone.cookie)
  expect(discovery.data).toMatchObject({
    contract_version: '0.1.0', backend: { id: 'dsh' },
    capabilities: expect.arrayContaining([{ id: 'tasks.list', supported: true, enabled: true, available: true,
      reason: null, remediation: null }]),
  })
  const capabilities: { id: string; available: boolean }[] = discovery.data.capabilities
  expect(capabilities.filter(capability => capability.available).map(capability => capability.id)).toEqual(['tasks.list'])

  const firstPage = (await shared('/v1/tasks?limit=1', 200, phone.cookie)).data
  expect(firstPage).toEqual({
    consistency: 'live', next_cursor: expect.stringMatching(/.+/u),
    items: [{ id: 'mobile-task-approve', title: 'Review approve', revision: expect.stringMatching(/^[1-9]\d*$/u),
      state: 'running', wait_reason: null }],
  })
  const nextPage = '/v1/tasks?limit=1&cursor=' + encodeURIComponent(firstPage.next_cursor)
  expect((await shared(nextPage, 200, phone.cookie)).data).toEqual({
    consistency: 'live', next_cursor: null,
    items: [{ id: 'mobile-task-recall', title: 'Review recall', revision: expect.stringMatching(/^[1-9]\d*$/u),
      state: 'running', wait_reason: null }],
  })
  expect(await shared(nextPage, 400, other.cookie)).toMatchObject({ error: { code: 'cursor_invalid' } })

  const list = async (cookie: string): Promise<InboxApproval[]> => {
    const response = await mobile('/v1/approvals', { headers: { cookie } })
    expect(response.status).toBe(200)
    return (await response.json()).approvals
  }
  const localReview = async (id: string) => {
    const result = await inbox({ type: 'snapshot' })
    assert.ok(result.ok && result.kind === 'snapshot')
    const approval = result.snapshot.approvals.find(entry => entry.id === id)
    assert.ok(approval)
    return approval
  }
  const fence = (approval: InboxApproval) => ({ requestId: approval.id, expectedVersion: approval.version, digest: approval.digest })
  const respond = (approval: InboxApproval, cookie: string, changes: Record<string, unknown> = {}, requestOrigin = origin) =>
    mobile('/v1/approvals/' + encodeURIComponent(approval.id) + '/responses', {
      method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json', cookie },
      body: JSON.stringify({ expectedVersion: approval.version, digest: approval.digest, decision: 'approve', ...changes }),
    })
  const first = await localReview('mobile-review-approve')
  expect(await list(phone.cookie)).toEqual([])
  await status('/v1/approvals', 401)
  expect(await inbox({ type: 'mobile_review', ...fence(first), deviceId: phone.deviceId })).toMatchObject({ ok: true })
  const assigned = await localReview(first.id)
  expect(assigned).toMatchObject({ version: first.version + 1, digest: first.digest, mobileDeviceId: phone.deviceId })
  const cards = await list(phone.cookie)
  expect(cards).toEqual([assigned])
  expect(cards[0]?.preview).toContain('Exact fixture payload approve')
  expect(await list(other.cookie)).toEqual([])
  expect(await inbox({ type: 'approval', ...fence(assigned), decision: 'approve' }))
    .toEqual({ ok: false, code: 'permission_denied' })
  const hint = await frame(await mobile('/v1/events', { headers: { cookie: phone.cookie } }), 'event: approvals')
  expect(hint).toContain('event: approvals\ndata: {}')
  expect(hint).not.toContain('Exact fixture payload')
  expect(hint).not.toContain(first.id)
  for (const [response, expected, code] of [
    [await respond(assigned, other.cookie), 404, 'not_found'],
    [await respond(assigned, phone.cookie, {}, 'https://elsewhere.test'), 403, 'forbidden_origin'],
    [await respond(first, phone.cookie), 409, 'version_conflict'],
    [await respond(assigned, phone.cookie, { digest: '0'.repeat(64) }), 409, 'action_changed'],
  ] as const) {
    expect(response.status).toBe(expected)
    expect(await response.json()).toMatchObject({ ok: false, code })
  }
  const answers = await Promise.all([respond(assigned, phone.cookie), respond(assigned, phone.cookie)])
  expect(answers.map(response => response.status).sort()).toEqual([200, 409])
  expect(await answers.find(response => response.ok)?.json()).toEqual({ ok: true, status: 'approved' })
  expect(await answers.find(response => !response.ok)?.json()).toEqual({ ok: false, code: 'already_decided' })
  expect(await list(phone.cookie)).toEqual([])

  const second = await localReview('mobile-review-recall')
  expect(await inbox({ type: 'mobile_review', ...fence(second), deviceId: phone.deviceId })).toMatchObject({ ok: true })
  const delegated = await localReview(second.id)
  expect(await inbox({ type: 'mobile_revoke', deviceId: phone.deviceId })).toMatchObject({ ok: true })
  expect(await shared(nextPage, 401, phone.cookie)).toMatchObject({ error: { code: 'auth_required' } })
  const revoked = await respond(delegated, phone.cookie)
  expect(revoked.status).toBe(401)
  await revoked.body?.cancel()
  expect(await inbox({ type: 'mobile_review', ...fence(delegated), deviceId: null })).toMatchObject({ ok: true })
  const recalled = await localReview(second.id)
  expect(recalled.version).toBe(delegated.version + 1)
  expect(recalled.mobileDeviceId).toBeUndefined()
  expect(await inbox({ type: 'approval', ...fence(recalled), decision: 'deny' })).toMatchObject({ ok: true })
  const database = new DatabaseSync(join(host.root, 'home', 'mobile-approval-inbox', DATABASE_FILENAME), { readOnly: true })
  try {
    const grants = database.prepare('SELECT record FROM action_grants').all()
    expect(grants).toHaveLength(1)
    expect(JSON.parse(String(grants[0]?.record))).toMatchObject({ approvingPrincipal: { deviceId: phone.deviceId },
      approvalEvidence: { requestId: first.id }, action: { kind: first.kind, recipient: first.recipient, resourceRef: first.resourceRef } })
    const conversation = database.prepare('SELECT record FROM conversations WHERE id = ?').get('mobile-review-conversation')
    expect(JSON.parse(String(conversation?.record))).toMatchObject({ originalDestination: {
      sourceInstanceId: 'fixture-original-source', externalDestinationId: 'fixture-original-thread',
    } })
    expect(database.prepare('SELECT count(*) AS count FROM action_dispatches').get()?.count).toBe(0)
  } finally { database.close() }
}, 25_000)


const chromePath = process.env.DSHPA_CHROME_PATH
it.skipIf(!chromePath)('pairs, approves, reconnects and revokes in a real Chrome browser with a mobile viewport', async () => {
  const { host, inbox, origin, proxy } = await openMobile(true)
  assert.ok(proxy && chromePath)
  const chrome = await openHeadlessChrome(chromePath, join(host.root, 'chrome-profile'), proxy.cert)
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  await chrome.send('Network.enable')
  await chrome.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US' } })
  const navigation = await chrome.send<{ errorText?: string }>('Page.navigate', { url: origin + '/' })
  expect(navigation.errorText).toBeUndefined()
  await chrome.waitFor("document.querySelector('#pair')?.hidden === false")
  const pairing = await inbox({ type: 'mobile_pair', label: 'Headless Chrome' })
  assert.ok(pairing.ok && pairing.kind === 'mobile_pair')
  await chrome.evaluate(`document.querySelector('#code').value = ${JSON.stringify(pairing.pairingCode)};
    document.querySelector('#pair').requestSubmit()`)
  await chrome.waitFor("document.querySelector('#work')?.hidden === false")
  const cookies = await chrome.send<{ cookies: { name: string; secure: boolean; httpOnly: boolean; sameSite: string; path: string }[] }>(
    'Network.getCookies', { urls: [origin] })
  const { name, secure, httpOnly, sameSite, path } = cookies.cookies.find(cookie => cookie.name === '__Host-dshpa-mobile') ?? {}
  expect({ name, secure, httpOnly, sameSite, path }).toEqual({
    name: '__Host-dshpa-mobile', secure: true, httpOnly: true, sameSite: 'Strict', path: '/',
  })
  expect(await chrome.evaluate<boolean>("document.cookie.includes('__Host-dshpa-mobile')")).toBe(false)
  expect(await chrome.evaluate<boolean>("innerWidth === 390 && document.documentElement.scrollWidth === innerWidth")).toBe(true)
  const manifest = await chrome.send<{ url: string; errors: unknown[] }>('Page.getAppManifest')
  expect(manifest).toMatchObject({ url: origin + '/mobile.webmanifest', errors: [] })
  const eligibility = await chrome.send<{ installabilityErrors: { errorId: string }[] }>('Page.getInstallabilityErrors')
  expect(eligibility.installabilityErrors).toEqual([])
  await chrome.send('Page.reload')
  await chrome.waitFor("document.querySelector('#work')?.hidden === false && document.querySelector('#pair')?.hidden === true")

  const local = await inbox({ type: 'snapshot' })
  assert.ok(local.ok && local.kind === 'snapshot')
  const review = local.snapshot.approvals.find(item => item.id === 'mobile-review-approve')
  const phone = local.snapshot.mobileReviewers?.find(item => item.label === 'Headless Chrome')
  assert.ok(review && phone)
  expect(await inbox({ type: 'mobile_review', requestId: review.id, expectedVersion: review.version, digest: review.digest,
    deviceId: phone.deviceId })).toMatchObject({ ok: true })
  await chrome.waitFor("document.querySelector('#review-items pre')?.textContent.includes('Exact fixture payload approve')")
  await chrome.evaluate("document.querySelector('#review-items .review-actions button').click()")
  await chrome.waitFor("document.querySelector('#review-status')?.textContent === 'Review response recorded.'")
  const decided = await inbox({ type: 'snapshot' })
  assert.ok(decided.ok && decided.kind === 'snapshot')
  expect(decided.snapshot.approvals.some(item => item.id === review.id)).toBe(false)
  const outstanding = decided.snapshot.approvals.find(item => item.id === 'mobile-review-recall')
  assert.ok(outstanding)
  expect(await inbox({ type: 'mobile_review', requestId: outstanding.id, expectedVersion: outstanding.version,
    digest: outstanding.digest, deviceId: phone.deviceId })).toMatchObject({ ok: true })
  await chrome.waitFor("document.querySelector('#review-items pre')?.textContent.includes('Exact fixture payload recall')")

  await chrome.evaluate(`globalThis.visibilitySamples = [];
    document.addEventListener('visibilitychange', () => globalThis.visibilitySamples.push({
      state: document.visibilityState,
      tasks: document.querySelector('#tasks').children.length,
      reviews: document.querySelector('#review-items').children.length,
    }))`)
  const returnToMobileTab = await chrome.switchToAnotherTab()
  await chrome.waitFor("document.visibilityState === 'hidden'")
  expect(await inbox({ type: 'create_task', commandId: 'create-while-browser-hidden', projectId: 'mobile-review-project',
    sessionId: 'mobile-fixture-chat', outcome: 'Task created while Chrome was hidden' })).toMatchObject({ ok: true })
  await returnToMobileTab()
  await chrome.waitFor("globalThis.visibilitySamples.some(sample => sample.state === 'visible')")
  expect(await chrome.evaluate('globalThis.visibilitySamples')).toEqual([
    { state: 'hidden', tasks: 0, reviews: 0 },
    { state: 'visible', tasks: 0, reviews: 0 },
  ])
  await chrome.waitFor("document.querySelector('#tasks')?.textContent.includes('Task created while Chrome was hidden') && document.querySelector('#review-items pre')?.textContent.includes('Exact fixture payload recall')")

  const silencedAt = performance.now()
  proxy.silenceEvents(true)
  expect(await inbox({ type: 'create_task', commandId: 'create-during-silent-stream', projectId: 'mobile-review-project',
    sessionId: 'mobile-fixture-chat', outcome: 'Task created during silent stream' })).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(proxy.mutedFrames()).toBeGreaterThan(0), { timeout: 12_000 })
  await vi.waitFor(async () => {
    expect(await chrome.evaluate(`document.querySelector('#status').textContent === 'Reconnecting…'
      && document.querySelector('#tasks').children.length === 0
      && document.querySelector('#review-items').children.length === 0`)).toBe(true)
  }, { interval: 100, timeout: 35_000 })
  expect(performance.now() - silencedAt).toBeGreaterThan(15_000)
  proxy.silenceEvents(false)
  await chrome.waitFor("document.querySelector('#tasks')?.textContent.includes('Task created during silent stream') && document.querySelector('#review-items pre')?.textContent.includes('Exact fixture payload recall')")

  proxy.setAvailable(false)
  await chrome.waitFor("document.querySelector('#work')?.hidden === true && document.querySelector('#tasks')?.children.length === 0 && document.querySelector('#review-items')?.children.length === 0")
  expect(await inbox({ type: 'create_task', commandId: 'create-during-browser-disconnect', projectId: 'mobile-review-project',
    sessionId: 'mobile-fixture-chat', outcome: 'Review after Chrome reconnect' })).toMatchObject({ ok: true })
  proxy.setAvailable(true)
  await chrome.waitFor("document.querySelector('#work')?.hidden === false && document.querySelector('#tasks')?.textContent.includes('Review after Chrome reconnect') && document.querySelector('#review-items pre')?.textContent.includes('Exact fixture payload recall')")
  expect(await inbox({ type: 'mobile_revoke', deviceId: phone.deviceId })).toMatchObject({ ok: true })
  await chrome.waitFor("document.querySelector('#pair')?.hidden === false && document.querySelector('#work')?.hidden === true && document.querySelector('#review-items')?.children.length === 0")
}, 80_000 + chromeStartupRetryAllowanceMs)

it.skipIf(!chromePath)('rejects an expired pairing code and clears an expired device in a real browser', async () => {
  const { host, inbox, origin, proxy } = await openMobile(true)
  assert.ok(proxy && chromePath)
  const chrome = await openHeadlessChrome(chromePath, join(host.root, 'chrome-expiry'), proxy.cert)
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await chrome.send('Page.navigate', { url: origin + '/' })
  await chrome.waitFor("document.querySelector('#pair')?.hidden === false")
  const mutateExpiry = (state: string) => {
    const db = new DatabaseSync(join(host.root, 'home', 'mobile-approval-inbox', DATABASE_FILENAME))
    try {
      db.prepare('UPDATE mobile_devices SET issued_at = ?, expires_at = ? WHERE state = ?')
        .run(new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 1_000).toISOString(), state)
    } finally { db.close() }
  }
  const expired = await inbox({ type: 'mobile_pair', label: 'Expired browser invitation' })
  assert.ok(expired.ok && expired.kind === 'mobile_pair')
  mutateExpiry('pending')
  await chrome.evaluate(`document.querySelector('#code').value = ${JSON.stringify(expired.pairingCode)}; document.querySelector('#pair').requestSubmit()`)
  await chrome.waitFor("document.querySelector('#status')?.textContent === 'Pairing failed. Check that the code is valid.'")
  expect(await chrome.evaluate("document.querySelector('#pair').hidden")).toBe(false)
  const valid = await inbox({ type: 'mobile_pair', label: 'Expiring browser device' })
  assert.ok(valid.ok && valid.kind === 'mobile_pair')
  await chrome.evaluate(`document.querySelector('#code').value = ${JSON.stringify(valid.pairingCode)}; document.querySelector('#pair').requestSubmit()`)
  await chrome.waitFor("document.querySelector('#work')?.hidden === false")
  mutateExpiry('active')
  await chrome.waitFor("document.querySelector('#pair')?.hidden === false && document.querySelector('#work')?.hidden === true && document.querySelector('#tasks')?.children.length === 0 && document.querySelector('#review-items')?.children.length === 0")
  expect(await chrome.evaluate("fetch('/v1/snapshot').then(response => response.status)")).toBe(401)
}, 30_000 + chromeStartupRetryAllowanceMs)

it.skipIf(!chromePath)('fences a displayed approval that expires and recalls a review in a real browser', async () => {
  const { host, inbox, origin, proxy } = await openMobile(true)
  assert.ok(proxy && chromePath)
  const chrome = await openHeadlessChrome(chromePath, join(host.root, 'chrome-review-expiry'), proxy.cert)
  await chrome.send('Page.navigate', { url: origin + '/' })
  await chrome.waitFor("document.querySelector('#pair')?.hidden === false")
  const pair = await inbox({ type: 'mobile_pair', label: 'Approval expiry phone' })
  assert.ok(pair.ok && pair.kind === 'mobile_pair')
  await chrome.evaluate(`document.querySelector('#code').value = ${JSON.stringify(pair.pairingCode)}; document.querySelector('#pair').requestSubmit()`)
  await chrome.waitFor("document.querySelector('#work')?.hidden === false")
  const snapshot = await inbox({ type: 'snapshot' })
  assert.ok(snapshot.ok && snapshot.kind === 'snapshot')
  const phone = snapshot.snapshot.mobileReviewers?.find(device => device.label === 'Approval expiry phone')
  const first = snapshot.snapshot.approvals.find(approval => approval.id === 'mobile-review-approve')
  assert.ok(phone && first)
  expect(await inbox({ type: 'mobile_review', requestId: first.id, expectedVersion: first.version, digest: first.digest, deviceId: phone.deviceId })).toMatchObject({ ok: true })
  await chrome.waitFor("document.querySelector('#review-items pre')?.textContent.includes('Exact fixture payload approve')")
  const path = join(host.root, 'home', 'mobile-approval-inbox', DATABASE_FILENAME)
  const db = new DatabaseSync(path)
  try { db.prepare("UPDATE action_approvals SET record = json_set(record, '$.expiresAt', ?) WHERE request_id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), first.id) } finally { db.close() }
  await chrome.evaluate("document.querySelector('#review-items .review-actions button')?.click()")
  await chrome.waitFor("document.querySelector('#review-items').children.length === 0")
  const reader = new DatabaseSync(path, { readOnly: true })
  try {
    expect(reader.prepare('SELECT status FROM action_approvals WHERE request_id = ?').get(first.id)?.status).toBe('expired')
    expect(reader.prepare('SELECT count(*) AS count FROM action_grants').get()?.count).toBe(0)
  } finally { reader.close() }
  const next = await inbox({ type: 'snapshot' })
  assert.ok(next.ok && next.kind === 'snapshot')
  const recall = next.snapshot.approvals.find(approval => approval.id === 'mobile-review-recall')
  assert.ok(recall)
  expect(await inbox({ type: 'mobile_review', requestId: recall.id, expectedVersion: recall.version, digest: recall.digest, deviceId: phone.deviceId })).toMatchObject({ ok: true })
  await chrome.waitFor("document.querySelector('#review-items pre')?.textContent.includes('Exact fixture payload recall')")
  const delegated = await inbox({ type: 'snapshot' })
  assert.ok(delegated.ok && delegated.kind === 'snapshot')
  const current = delegated.snapshot.approvals.find(approval => approval.id === recall.id)
  assert.ok(current)
  expect(await inbox({ type: 'mobile_review', requestId: current.id, expectedVersion: current.version, digest: current.digest, deviceId: null })).toMatchObject({ ok: true })
  await chrome.waitFor("document.querySelector('#review-items').children.length === 0")
}, 30_000 + chromeStartupRetryAllowanceMs)
