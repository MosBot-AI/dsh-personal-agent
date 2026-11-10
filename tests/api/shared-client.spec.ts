import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { MobileApprovals } from '../../packages/personal-agent/src/api/approvals.js'
import { startMobileHttp } from '../../packages/personal-agent/src/api/mobile-http.js'
import { projectSharedTask, sharedCapabilities, sharedError } from '../../packages/personal-agent/src/api/shared-client.js'
import { ownerIdSchema, profileIdSchema, taskStatusSchema } from '../../packages/personal-agent/src/domain/model.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'

const contractRoot = new URL('../../contracts/personal-api/', import.meta.url)
const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', contractRoot), 'utf8'))
const expectedCapabilities = fixtures.valid.find((fixture: { schema: string; value: { data?: { backend?: { id: string } } } }) =>
  fixture.schema === 'Capabilities' && fixture.value.data?.backend?.id === 'dsh').value

it('matches the pinned shared discovery and unavailable-task fixtures exactly', () => {
  expect(sharedCapabilities()).toEqual(expectedCapabilities)
  expect(sharedError('capability_unavailable', 'The shared task list adapter is not implemented.', 'tasks.list'))
    .toEqual(fixtures.valid.find((fixture: { schema: string }) => fixture.schema === 'Error').value)
  expect(sharedCapabilities().data.capabilities.every(capability => !capability.available)).toBe(true)
})

it('verifies every vendored source artifact against the authority manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', contractRoot), 'utf8'))
  const source = JSON.parse(readFileSync(new URL('../../contracts/personal-api-source.json', import.meta.url), 'utf8'))
  expect(source.repository).toBe(manifest.authority)
  expect(source.commit).toBe('48a930a2c01b2add9e349cbc1f0d65278066cc1c')
  expect(source.contract_version).toBe(manifest.contract_version)
  expect(createHash('sha256').update(readFileSync(new URL('manifest.json', contractRoot))).digest('hex')).toBe(source.manifest_sha256)
  expect(manifest.authority).toBe('MosBot-AI/hermes-superagent')
  expect(manifest.contract_version).toBe('0.1.0')
  expect(Object.keys(manifest.files).sort()).toEqual(['fixtures.json', 'openapi.json', 'schema.json'])
  for (const [file, hash] of Object.entries(manifest.files)) {
    expect(createHash('sha256').update(readFileSync(new URL(file, contractRoot))).digest('hex')).toBe(hash)
  }
})

it('maps every native task status without declaring an uncertain effect completed', () => {
  for (const status of taskStatusSchema.options) {
    const projected = projectSharedTask({ id: 'task', requestedOutcome: 'Outcome', version: 2, status })
    expect(projected).toMatchObject({ id: 'task', title: 'Outcome', revision: '2' })
    expect(['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled', 'unknown']).toContain(projected.state)
  }
  expect(projectSharedTask({ id: 'task', requestedOutcome: 'Outcome', version: 1, status: 'cancelling' }))
    .toMatchObject({ state: 'waiting', wait_reason: 'cancellation_requested' })
  expect(projectSharedTask({ id: 'synthetic_task', requestedOutcome: 'Synthetic task', version: 1, status: 'reconciliation_required' }))
    .toEqual(fixtures.valid.find((fixture: { schema: string }) => fixture.schema === 'TasksPage').value.data.items[0])
})

it('rejects unrepresentable task fields without truncating identity or silently rounding revisions', () => {
  const task = { id: 'task', requestedOutcome: 'Outcome', version: 1, status: 'queued' as const }
  for (const invalid of [
    { id: '' }, { id: 'x'.repeat(257) }, { requestedOutcome: 'x'.repeat(4097) },
    { version: 0 }, { version: -1 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { version: Number.NaN }, { version: Number.POSITIVE_INFINITY },
  ]) expect(() => projectSharedTask({ ...task, ...invalid })).toThrow(RangeError)
  expect(projectSharedTask({ ...task, id: '😀'.repeat(256), requestedOutcome: '😀'.repeat(4096), version: Number.MAX_SAFE_INTEGER }))
    .toMatchObject({ id: '😀'.repeat(256), title: '😀'.repeat(4096), revision: String(Number.MAX_SAFE_INTEGER) })
})

async function httpFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dshpa-shared-api-'))
  const store = openWorkStore(root)
  const scope = { ownerId: ownerIdSchema.parse('owner'), profileId: profileIdSchema.parse('profile') }
  const devices = store.mobileDevices(scope)
  const pair = devices.begin('Test device')
  if (!pair.ok) throw new Error('Pairing failed')
  const enrolled = devices.enroll(pair.pairingCode)
  if (!enrolled.ok) throw new Error('Enrollment failed')
  const deviceCredential = enrolled.credential
  const foreignDevices = store.mobileDevices({ ...scope, profileId: profileIdSchema.parse('other-profile') })
  const foreignPair = foreignDevices.begin('Foreign device')
  if (!foreignPair.ok) throw new Error('Foreign pairing failed')
  const foreignDevice = foreignDevices.enroll(foreignPair.pairingCode)
  if (!foreignDevice.ok) throw new Error('Foreign enrollment failed')
  const probe = createServer()
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('Missing port')
  const port = address.port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  // Shared routes must not call the legacy approval interface.
  const approvals = new Proxy({} as MobileApprovals, { get() { throw new Error('Legacy approval route called') } })
  const server = startMobileHttp({ origin: 'https://agent.test', port }, devices, store.mobileFeed(scope), approvals)
  onTestFinished(async () => { await server.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  await vi.waitFor(() => expect(server.available()).toBe(true))
  function get(path: string, credential: string | undefined = deviceCredential, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: unknown; cache: string | undefined }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: {
        Host: 'agent.test', ...(credential ? { Cookie: '__Host-dshpa-mobile=' + credential } : {}), ...headers,
      } }, res => {
        let text = ''
        res.on('data', data => { text += data })
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), cache: res.headers['cache-control'] }))
      })
      req.once('error', reject); req.end()
    })
  }
  return { get, devices, pair, credential: enrolled.credential, foreignCredential: foreignDevice.credential }
}

it('serves authenticated discovery without promoting legacy features to shared availability', async () => {
  const f = await httpFixture()
  expect(await f.get('/v1/capabilities')).toEqual({ status: 200, body: expectedCapabilities, cache: 'no-store' })
  const unavailable = await f.get('/v1/tasks')
  expect(unavailable.status).toBe(409)
  expect(unavailable.body).toEqual(sharedError('capability_unavailable', 'The shared task list adapter is not implemented.', 'tasks.list'))
  for (const query of ['?limit=1', '?limit=32&cursor=opaque', '?limit=64']) {
    expect(await f.get('/v1/tasks' + query)).toMatchObject({ status: 409, body: { error: { code: 'capability_unavailable' } } })
  }
  for (const query of ['?limit=0', '?limit=65', '?limit=1.5', '?limit=1&limit=2', '?cursor=', '?cursor=a&cursor=b', '?unknown=1', '?cursor=' + 'x'.repeat(2049)]) {
    expect(await f.get('/v1/tasks' + query)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
  }
})

it('rejects anonymous, pairing-only and revoked device access to shared routes', async () => {
  const f = await httpFixture()
  for (const path of ['/v1/capabilities', '/v1/tasks']) {
    for (const credential of ['', f.pair.pairingCode, f.foreignCredential]) {
      expect(await f.get(path, credential)).toMatchObject({ status: 401, body: { error: { code: 'auth_required' } } })
    }
  }
  expect(await f.get('/v1/capabilities', f.credential, { Cookie: '__Host-dshpa-mobile=' + f.credential + '; __Host-dshpa-mobile=' + f.credential }))
    .toMatchObject({ status: 401, body: { error: { code: 'auth_required' } } })
  f.devices.revoke(f.pair.deviceId)
  expect(await f.get('/v1/capabilities')).toMatchObject({ status: 401, body: { error: { code: 'auth_required' } } })
})

it('preserves exact Host and Origin checks and rejects unknown query parameters', async () => {
  const f = await httpFixture()
  for (const headers of [{ Host: 'attacker.test' }, { Origin: 'https://attacker.test' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
    expect(await f.get('/v1/capabilities', f.credential, headers)).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
  }
  expect(await f.get('/v1/capabilities?unexpected=true')).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
})
