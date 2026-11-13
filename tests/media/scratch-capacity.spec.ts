import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mediaServiceConfigSchema } from '../../packages/personal-agent/src/media/jobs.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'
import { accepted, comfyFixture, imageSpec, mediaRequest } from './fixture.js'
import { createAttempt } from './work-fixture.js'

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, mkdtemp: vi.fn(fs.mkdtemp), rm: vi.fn(fs.rm), writeFile: vi.fn(fs.writeFile) }
})

it.each([
  ['mkdtemp', 'ENOSPC'],
  ['mkdtemp', 'EDQUOT'],
  ['writeFile', 'ENOSPC'],
  ['writeFile', 'EDQUOT'],
] as const)('recovers the original completed render after %s reports %s', async (operation, code) => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  const directory = join(fixture.directory, 'work')
  let store = openWorkStore(directory)
  const request = { ...mediaRequest(), access: createAttempt(store, 'scratch-capacity') }
  const ref = { access: request.access, operationId: request.operationId }
  const config = mediaServiceConfigSchema.parse({ providers: { image: pin } })
  const authority = { current: () => true, artifactAllowed: () => false }
  let jobs = store.createMediaJobs(registry, config, authority)
  onTestFinished(async () => { await jobs.close(); await registry.close(); store.close() })

  accepted(jobs.enqueue(request))
  await jobs.step()
  const id = accepted(jobs.inspect(ref)).handle!.handleId
  const bytes = fixture.complete(id, imageSpec)
  await jobs.step()

  const exhausted = async () => { throw Object.assign(new Error('Fixture scratch capacity exhausted'), { code }) }
  if (operation === 'mkdtemp') {
    await vi.mocked(mkdtemp).withImplementation(exhausted, () => jobs.step())
  } else {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const writePartial = async (file: Parameters<typeof writeFile>[0]) => {
      await fs.writeFile(file, bytes.subarray(0, 8), { mode: 0o600 })
      return exhausted()
    }
    vi.mocked(rm).mockClear()
    await vi.mocked(rm).withImplementation(async (path, options) => {
      await fs.rm(path, options)
      throw Object.assign(new Error('Fixture cleanup error'), { code: 'EIO' })
    }, () => vi.mocked(writeFile).withImplementation(writePartial, () => jobs.step()))
    expect(rm).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('dshpa-media-'), { recursive: true, force: true })
  }
  expect(accepted(jobs.inspect(ref))).toMatchObject({ state: 'collecting', reason: 'busy', handle: { handleId: id } })
  expect(store.mediaLeaseHeld()).toBe(true)
  expect(fixture.submissions.map(submission => submission.prompt_id)).toEqual([id])

  await jobs.close()
  store.close()
  store = openWorkStore(directory)
  jobs = store.createMediaJobs(registry, config, authority)
  expect(accepted(jobs.inspect(ref))).toMatchObject({ state: 'collecting', reason: 'busy', handle: { handleId: id } })
  expect(store.mediaLeaseHeld()).toBe(true)

  await jobs.step()
  expect(accepted(jobs.inspect(ref))).toMatchObject({
    state: 'succeeded', handle: { handleId: id },
    outputs: [{ contentHash: createHash('sha256').update(bytes).digest('hex') }],
  })
  expect(store.mediaLeaseHeld()).toBe(false)
  expect(fixture.submissions.map(submission => submission.prompt_id)).toEqual([id])
})

it('returns cancellation when collection is aborted during scratch cleanup', async () => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  onTestFinished(() => registry.close())
  const request = mediaRequest()
  const prepared = accepted(await registry.invoke(pin, (provider, signal) => provider.durableSubmission!.prepare(request, signal)))
  const handle = accepted(await registry.invoke(pin, (provider, signal) => provider.durableSubmission!.submit(request, prepared, signal)))
  fixture.complete(handle.handleId, imageSpec)

  const abort = new AbortController()
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  await vi.mocked(rm).withImplementation(async (path, options) => {
    await fs.rm(path, options)
    abort.abort()
  }, async () => {
    expect(await registry.invoke(pin, (provider, signal) =>
      provider.collect({ access: request.access, handle }, signal), abort.signal)).toEqual({ ok: false, code: 'cancelled' })
  })
})
