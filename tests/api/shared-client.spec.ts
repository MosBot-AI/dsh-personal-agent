import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { MobileApprovals } from '../../packages/personal-agent/src/api/approvals.js'
import { startMobileHttp } from '../../packages/personal-agent/src/api/mobile-http.js'
import { projectSharedTask, sharedCapabilities, sharedError } from '../../packages/personal-agent/src/api/shared-client.js'
import { attemptIdSchema, clientIdSchema, conversationSchema, deviceIdSchema, mandateRefSchema, projectSchema, taskIdSchema, utcInstantSchema, ownerIdSchema, profileIdSchema, taskStatusSchema } from '../../packages/personal-agent/src/domain/model.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const scope = { ownerId: ownerIdSchema.parse('owner'), profileId: profileIdSchema.parse('profile') }
const instant = '2026-11-10T12:00:00.000Z'
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

it('rejects unrepresentable identities and revisions and preserves a title at the contract limit', () => {
  const task = { id: 'task', requestedOutcome: 'Outcome', version: 1, status: 'queued' as const }
  for (const invalid of [
    { id: '' }, { id: 'x'.repeat(257) },
    { version: 0 }, { version: -1 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { version: Number.NaN }, { version: Number.POSITIVE_INFINITY },
  ]) expect(() => projectSharedTask({ ...task, ...invalid })).toThrow(RangeError)
  expect(projectSharedTask({ ...task, id: '😀'.repeat(256), requestedOutcome: '😀'.repeat(4096), version: Number.MAX_SAFE_INTEGER }))
    .toMatchObject({ id: '😀'.repeat(256), title: '😀'.repeat(4096), revision: String(Number.MAX_SAFE_INTEGER) })
})

function seedWork(store: WorkStore, owner = scope, label = 'primary') {
  const project = projectSchema.parse({
    ...owner, id: 'project-' + label, kind: 'project', title: 'Mobile access', purpose: 'Exercise scoped work.',
    resourceRefs: ['private-project-path'], status: 'active', successCriteria: ['Verify the task'], planRevision: 1, milestones: [],
  })
  const conversation = conversationSchema.parse({
    ...owner, id: 'thread-' + label, sessionIds: [],
    originalDestination: { sourceInstanceId: 'original-source', externalDestinationId: 'private-origin' },
  })
  store.insertProject(project)
  store.insertConversation(conversation)
  const actor = {
    ...owner, role: 'owner' as const, deviceId: deviceIdSchema.parse('local-device'),
    clientId: clientIdSchema.parse('local-web'), policyVersion: 'mobile-test',
  }
  return (name: string, visible = true, requestedOutcome = 'Outcome for ' + name) => {
    const taskId = taskIdSchema.parse('task-' + label + '-' + name)
    const result = store.applyCommand({ type: 'work.create', commandId: 'create-' + taskId,
      payload: { projectId: project.id, requestedOutcome, constraints: ['private-constraint'],
        acceptance: { criteria: ['Verify the task'], requiresArtifact: false, requiresReceipt: false } },
    }, {
      actor, at: utcInstantSchema.parse(instant), projectId: project.id, newTaskId: taskId,
      ...(visible ? { conversationId: conversation.id } : {}),
      newAttempt: {
        id: attemptIdSchema.parse('attempt-' + taskId),
        mandate: mandateRefSchema.parse({ ...owner, id: 'mandate-' + taskId, policyVersion: actor.policyVersion }),
      },
    })
    if (!result.ok) throw new Error('Task setup failed')
    return result.state.task
  }
}


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
  return { get, devices, pair, store, scope, root, credential: enrolled.credential, foreignCredential: foreignDevice.credential }
}

it('advertises only the implemented shared task capability and serves bounded pages', async () => {
  const f = await httpFixture()
  expect(await f.get('/v1/capabilities')).toEqual({ status: 200, body: sharedCapabilities(true), cache: 'no-store' })
  expect(sharedCapabilities(true).data.capabilities.filter(item => item.available).map(item => item.id)).toEqual(['tasks.list'])
  for (const query of ['', '?limit=1', '?limit=64']) {
    expect(await f.get('/v1/tasks' + query)).toMatchObject({ status: 200, body: {
      schema_version: 'personal.api.v1', data: { items: [], next_cursor: null, consistency: 'live' },
    } })
  }
  expect(await f.get('/v1/tasks?cursor=opaque')).toMatchObject({ status: 400, body: { error: { code: 'cursor_invalid' } } })
  for (const query of ['?limit=0', '?limit=65', '?limit=1.5', '?limit=1&limit=2', '?cursor=', '?cursor=a&cursor=b', '?unknown=1', '?cursor=' + 'x'.repeat(2049)]) {
    expect(await f.get('/v1/tasks' + query)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
  }
})

it('counts Unicode code points when validating a shared task cursor', async () => {
  const f = await httpFixture()
  const atLimit = 'x'.repeat(2047) + '😀'
  expect(await f.get('/v1/tasks?cursor=' + encodeURIComponent(atLimit))).toMatchObject({
    status: 400, body: { error: { code: 'cursor_invalid', message: 'Restart task pagination without a cursor.' } },
  })
  expect(await f.get('/v1/tasks?cursor=' + encodeURIComponent(atLimit + 'x'))).toMatchObject({
    status: 400, body: { error: { code: 'invalid_request' } },
  })
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

function pageOf(body: unknown) {
  return (body as { data: { items: ReturnType<typeof projectSharedTask>[]; next_cursor: string | null; consistency: string } }).data
}

it('paginates beyond the legacy 64-task snapshot without leaking other scopes or private fields', async () => {
  const f = await httpFixture()
  const create = seedWork(f.store)
  const ids = Array.from({ length: 64 }, (_, i) => create(String(i).padStart(3, '0')).id)
  expect(pageOf((await f.get('/v1/tasks?limit=64')).body).next_cursor).toBeNull()
  for (let i = 64; i < 70; i++) ids.push(create(String(i).padStart(3, '0')).id)
  create('hidden', false)
  seedWork(f.store, { ...scope, profileId: profileIdSchema.parse('other-profile') }, 'foreign')('foreign')
  seedWork(f.store, { ...scope, ownerId: ownerIdSchema.parse('other-owner') }, 'other')('foreign')
  const first = await f.get('/v1/tasks?limit=64')
  expect(first.status).toBe(200)
  const page = pageOf(first.body)
  expect(page.items.map(task => task.id)).toEqual(ids.slice(0, 64))
  expect(page.next_cursor).toBeTypeOf('string')
  expect(page.consistency).toBe('live')
  for (const task of page.items) expect(Object.keys(task).sort()).toEqual(['id', 'revision', 'state', 'title', 'wait_reason'])
  const second = await f.get('/v1/tasks?limit=64&cursor=' + page.next_cursor)
  expect(second.status).toBe(200)
  expect(pageOf(second.body).items.map(task => task.id)).toEqual(ids.slice(64))
  expect(pageOf(second.body).next_cursor).toBeNull()
  expect(JSON.stringify(first.body)).not.toMatch(/private-|projectId|ownerId|profileId/)
})

it('previews a long native outcome without losing its contents or interrupting pagination', async () => {
  const f = await httpFixture()
  const create = seedWork(f.store)
  const prefix = '中'.repeat(4094) + '😀'
  const outcome = prefix + '\nAdditional native task instructions.'
  const longTask = create('a-long', true, outcome)
  const nextTask = create('b-next')

  const first = await f.get('/v1/tasks?limit=1')
  expect(first.status).toBe(200)
  const page = pageOf(first.body)
  expect(page.items).toEqual([{
    id: longTask.id, title: prefix + '…', revision: String(longTask.version), state: 'queued', wait_reason: null,
  }])
  expect([...page.items[0]!.title]).toHaveLength(4096)
  expect(page.next_cursor).toBeTypeOf('string')

  const next = await f.get('/v1/tasks?limit=1&cursor=' + page.next_cursor)
  expect(next.status).toBe(200)
  expect(pageOf(next.body)).toMatchObject({ items: [{ id: nextTask.id, title: nextTask.requestedOutcome }], next_cursor: null })

  expect(f.store.getWork({ ...f.scope, taskId: longTask.id })?.task.requestedOutcome).toBe(outcome)
  expect(await f.get('/v1/snapshot')).toMatchObject({ status: 200, body: { ok: true, tasks: expect.arrayContaining([
    expect.objectContaining({ id: longTask.id, outcome }),
  ]) } })
})

it('binds cursors to the authenticated device and feed instance and rejects tampering', async () => {
  const f = await httpFixture()
  const create = seedWork(f.store)
  create('a'); create('b')
  const cursor = pageOf((await f.get('/v1/tasks?limit=1')).body).next_cursor!
  const otherPair = f.devices.begin('Second device')
  if (!otherPair.ok) throw new Error('Pair setup failed')
  const otherDevice = f.devices.enroll(otherPair.pairingCode)
  if (!otherDevice.ok) throw new Error('Device setup failed')
  expect(await f.get('/v1/tasks?cursor=' + cursor, otherDevice.credential))
    .toMatchObject({ status: 400, body: { error: { code: 'cursor_invalid' } } })
  for (const bad of [cursor + 'x', 'x' + cursor, cursor.replace('.', '..'), Buffer.from('[1,"task-primary-a"]').toString('base64url')]) {
    expect(await f.get('/v1/tasks?cursor=' + bad)).toMatchObject({ status: 400, body: { error: { code: 'cursor_invalid' } } })
  }
  expect(f.store.mobileFeed({ ...scope, profileId: profileIdSchema.parse('other-profile') }).sharedTasks(f.foreignCredential, 1, cursor))
    .toEqual({ ok: false, code: 'cursor_invalid' })
  expect(f.store.mobileFeed(scope).sharedTasks(f.credential, 1, cursor)).toEqual({ ok: false, code: 'cursor_invalid' })
  f.devices.revoke(f.pair.deviceId)
  expect(await f.get('/v1/tasks?cursor=' + cursor)).toMatchObject({ status: 401, body: { error: { code: 'auth_required' } } })
})

it('uses live keyset ordering instead of implying snapshot consistency', async () => {
  const f = await httpFixture()
  const create = seedWork(f.store)
  create('b'); create('d')
  const first = pageOf((await f.get('/v1/tasks?limit=1')).body)
  create('a'); create('c')
  const next = pageOf((await f.get('/v1/tasks?cursor=' + first.next_cursor)).body)
  expect(next.items.map(task => task.id)).toEqual(['task-primary-c', 'task-primary-d'])
  expect(next.consistency).toBe('live')
  expect(pageOf((await f.get('/v1/tasks')).body).items).toHaveLength(4)
})

it('fails closed with a generic 503 when a stored task cannot satisfy the shared contract', async () => {
  const f = await httpFixture()
  const broken = seedWork(f.store)('broken', true, 'private-content')
  const writer = new DatabaseSync(join(f.root, DATABASE_FILENAME))
  try {
    writer.prepare("UPDATE tasks SET record = json_set(record, '$.status', ?) WHERE id = ?")
      .run('unknown-native-status', broken.id)
  } finally { writer.close() }
  const response = await f.get('/v1/tasks')
  expect(response).toEqual({ status: 503, cache: 'no-store',
    body: sharedError('internal_unavailable', 'The shared API is temporarily unavailable.') })
  expect(JSON.stringify(response.body)).not.toMatch(/private-content|unknown-native-status|task-primary-broken/)
})
