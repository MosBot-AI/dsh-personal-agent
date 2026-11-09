import { createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mediaServiceConfigSchema } from '../../packages/personal-agent/src/media/jobs.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'
import { comfyFixture, imageSpec, mediaRequest } from '../media/fixture.js'
import { createAttempt } from '../media/work-fixture.js'
import { openWebHost, prepareWebHost } from './fixtures/web-host.js'

const probe = fileURLToPath(new URL('./fixtures/media-host-probe.mjs', import.meta.url))
const bundle = fileURLToPath(new URL('../../packages/media-comfyui/', import.meta.url))

it('loads the native media bundle and recovers its job after a host restart against a simulated ComfyUI', async () => {
  const fixture = await comfyFixture()
  fixture.faults.loseResponse = true
  fixture.faults.missing = true
  const pin = { kind: 'media', pluginId: '@mosbot-ai/dshpa-media-comfyui', pluginVersion: '0.1.0',
    instanceId: 'native-media-fixture', configRevision: 1 }
  const prepared = prepareWebHost(probe, [
    '- id: dshpa',
    '  config:',
    '    inbox:',
    "      storageDirectory: !!js dshHomePath('media-state')",
    '      workRoot: !!js process.cwd()',
    '      resident: {}',
    `      media: ${JSON.stringify({ providers: { image: pin }, pollMs: 1_000 })}`,
    '- id: dshpa-media-comfyui',
    `  config: ${JSON.stringify({ ...fixture.config, instanceId: pin.instanceId, configRevision: pin.configRevision })}`,
  ], [bundle])
  let host: Awaited<ReturnType<typeof openWebHost>> | undefined
  onTestFinished(async () => {
    try { await host?.close() } finally { rmSync(prepared.root, { recursive: true, force: true }) }
  })

  const storage = join(prepared.dshHome, 'media-state')
  const seed = openWorkStore(storage)
  try {
    const access = createAttempt(seed, 'native-media')
    writeFileSync(join(storage, 'local-inbox-identity.json'), JSON.stringify({ ownerId: access.ownerId, profileId: access.profileId,
      deviceId: 'native-media-device', verifiedAt: new Date().toISOString() }), { mode: 0o600 })
    writeFileSync(join(prepared.root, 'media-request.json'), JSON.stringify({ ...mediaRequest(), access }), { mode: 0o600 })
  } finally { seed.close() }

  function record() {
    const db = new DatabaseSync(join(storage, DATABASE_FILENAME), { readOnly: true })
    try { return db.prepare('SELECT state, prepared, outputs FROM media_jobs').get() }
    finally { db.close() }
  }

  async function waitForResident(host: Awaited<ReturnType<typeof openWebHost>>) {
    return vi.waitFor(async () => {
      const response = await host.get('/dshpa/ready')
      expect(response.status).toBe(200)
      const ready = await response.json() as { ready: boolean; instance: string }
      expect(ready).toMatchObject({ ready: true, instance: expect.any(String) })
      return ready.instance
    }, { timeout: 10_000 })
  }

  host = await openWebHost(probe, { prepared })
  const firstInstance = await waitForResident(host)
  await vi.waitFor(() => expect(record()?.state).toBe('unknown'), { timeout: 10_000 })
  expect(fixture.submissions).toHaveLength(1)
  const originalId = fixture.submissions[0]!.prompt_id
  expect(JSON.parse(String(record()?.prepared))).toMatchObject({ handle: { handleId: originalId, provider: pin } })
  await host.close()

  const bytes = fixture.complete(originalId, imageSpec)
  fixture.faults.missing = false
  host = await openWebHost(probe, { prepared })
  expect(await waitForResident(host)).not.toBe(firstInstance)
  await vi.waitFor(() => expect(record()?.state).toBe('succeeded'), { timeout: 10_000 })
  expect(JSON.parse(String(record()?.outputs))).toMatchObject([{ mediaType: 'image/png',
    sizeBytes: bytes.length, contentHash: createHash('sha256').update(bytes).digest('hex') }])
  expect(fixture.submissions.map(request => request.prompt_id)).toEqual([originalId])
}, 60_000)

it.each(['submitting', 'unknown', 'rendering', 'collecting', 'queued'])('honors a persisted media lease state %s with media disabled in the next host', async state => {
  const held = state !== 'queued'
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  const leaseProbe = fileURLToPath(new URL('./fixtures/media-lease-probe.mjs', import.meta.url))
  const prepared = prepareWebHost(leaseProbe, [
    '- id: dshpa', '  config:', '    inbox:',
    "      storageDirectory: !!js dshHomePath('media-state')",
    '      workRoot: !!js process.cwd()',
  ])
  let host: Awaited<ReturnType<typeof openWebHost>> | undefined
  onTestFinished(async () => {
    try { await host?.close(); await registry.close() }
    finally { rmSync(prepared.root, { recursive: true, force: true }) }
  })
  const storage = join(prepared.dshHome, 'media-state')
  const store = openWorkStore(storage)
  const access = createAttempt(store, 'media-lease')
  const jobs = store.createMediaJobs(registry, mediaServiceConfigSchema.parse({ providers: { image: pin } }),
    { current: () => true, artifactAllowed: () => false })
  try {
    expect(jobs.enqueue({ ...mediaRequest(), access }).ok).toBe(true)
    if (held) {
      await jobs.step()
      const db = new DatabaseSync(join(storage, DATABASE_FILENAME))
      try { db.prepare('UPDATE media_jobs SET state = ?').run(state) } finally { db.close() }
    }
    expect(store.mediaLeaseHeld()).toBe(held)
    writeFileSync(join(storage, 'local-inbox-identity.json'), JSON.stringify({ ownerId: access.ownerId, profileId: access.profileId,
      deviceId: 'native-media-device', verifiedAt: new Date().toISOString() }), { mode: 0o600 })
    writeFileSync(join(prepared.root, 'media-lease.json'), JSON.stringify({ access, held }), { mode: 0o600 })
  } finally { await jobs.close(); store.close() }
  // The restarted native host deliberately has neither media config nor a media provider.
  // A queued job is the positive control: only a persisted physical lease blocks GPU work.
  host = await openWebHost(leaseProbe, { prepared })
}, 30_000)
