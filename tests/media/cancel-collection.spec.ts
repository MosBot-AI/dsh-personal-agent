import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { MediaProvider } from '../../packages/plugin-api/src/media.js'
import { mediaServiceConfigSchema } from '../../packages/personal-agent/src/media/jobs.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'
import { accepted, comfyFixture, imageSpec, mediaRequest } from './fixture.js'
import { createAttempt } from './work-fixture.js'

async function collectingFixture(timeoutMs?: number, decorate?: (provider: MediaProvider) => MediaProvider) {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register(1, { timeoutMs }, decorate)
  const directory = join(fixture.directory, 'work')
  let store = openWorkStore(directory)
  const request = { ...mediaRequest(), access: createAttempt(store, 'cancel-collection') }
  const ref = { access: request.access, operationId: request.operationId }
  const config = mediaServiceConfigSchema.parse({ providers: { image: pin } })
  const authority = { current: () => true, artifactAllowed: () => false }
  let jobs = store.createMediaJobs(registry, config, authority)
  onTestFinished(async () => { await jobs.close(); await registry.close(); store.close() })
  accepted(jobs.enqueue(request))
  await jobs.step()
  const handle = accepted(jobs.inspect(ref)).handle!
  const bytes = fixture.complete(handle.handleId, imageSpec)
  await jobs.step()
  expect(accepted(jobs.inspect(ref)).state).toBe('collecting')
  return {
    fixture, bytes, ref, handle,
    get jobs() { return jobs }, get store() { return store },
    async reopen() {
      await jobs.close()
      store.close()
      store = openWorkStore(directory)
      jobs = store.createMediaJobs(registry, config, authority)
    },
  }
}

it.each([false, true])('cancels before collecting output and preserves that decision across restart (%s)', async reopen => {
  const f = await collectingFixture()
  let downloads = 0
  f.fixture.watchView(() => downloads++)
  expect(accepted(f.jobs.cancel(f.ref)).state).toBe('collecting')
  expect(f.store.mediaLeaseHeld()).toBe(true)
  if (reopen) await f.reopen()
  await f.jobs.step()
  expect(accepted(f.jobs.inspect(f.ref))).toMatchObject({ state: 'cancelled', outputs: undefined })
  expect(downloads).toBe(0)
  expect(f.store.mediaLeaseHeld()).toBe(false)
  expect(f.fixture.submissions).toHaveLength(1)
})

it('aborts an in-flight output read and retains the lease until the collector settles', async () => {
  const f = await collectingFixture()
  const reading = Promise.withResolvers<void>()
  f.fixture.watchView(() => reading.resolve())
  f.fixture.faults.stallView = true
  const running = f.jobs.step()
  await reading.promise
  accepted(f.jobs.cancel(f.ref))
  expect(f.store.mediaLeaseHeld()).toBe(true)
  await running
  expect(accepted(f.jobs.inspect(f.ref))).toMatchObject({ state: 'cancelled', outputs: undefined })
  expect(f.store.mediaLeaseHeld()).toBe(false)
  expect(f.fixture.submissions).toHaveLength(1)
})

it('retries a real response-body timeout after restart without submitting another render', async () => {
  const f = await collectingFixture(500)
  f.fixture.faults.stallView = true
  await f.jobs.step()
  expect(accepted(f.jobs.inspect(f.ref))).toMatchObject({ state: 'collecting', reason: 'provider_unavailable' })
  expect(f.store.mediaLeaseHeld()).toBe(true)
  await f.reopen()
  f.fixture.faults.stallView = false
  await f.jobs.step()
  expect(accepted(f.jobs.inspect(f.ref))).toMatchObject({ state: 'succeeded',
    outputs: [{ contentHash: createHash('sha256').update(f.bytes).digest('hex') }] })
  expect(f.fixture.submissions.map(submission => submission.prompt_id)).toEqual([f.handle.handleId])
  expect(f.store.mediaLeaseHeld()).toBe(false)
})

it('fences a late successful collector that ignores cancellation without releasing its lease early', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let activeSignal: AbortSignal | undefined
  const f = await collectingFixture(undefined, provider => ({
    ...provider,
    async collect(request, signal) {
      activeSignal = signal
      entered.resolve()
      await release.promise
      // Deliberately behave like a provider that cannot stop its physical work.
      return provider.collect(request, new AbortController().signal)
    },
  }))
  const collecting = f.jobs.step()
  await entered.promise
  try {
    accepted(f.jobs.cancel(f.ref))
    expect(activeSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(f.store.mediaLeaseHeld()).toBe(true)
    expect(accepted(f.jobs.inspect(f.ref)).state).toBe('collecting')
  } finally { release.resolve() }
  await collecting
  expect(accepted(f.jobs.inspect(f.ref))).toMatchObject({ state: 'cancelled', outputs: undefined })
  expect(f.store.mediaLeaseHeld()).toBe(false)
})
