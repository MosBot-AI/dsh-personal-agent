import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mediaServiceConfigSchema } from '../../packages/personal-agent/src/media/jobs.js'
import { createGpuQueue } from '../../packages/personal-agent/src/runtime/gpu-queue.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'
import { accepted, comfyFixture, imageSpec, mediaRequest, videoSpec } from './fixture.js'
import { verifyComfyRecovery } from './fixtures/media-recovery.js'
import { createAttempt } from './work-fixture.js'

it('recovers the simulated prompt and fixture PNG digest after a dropped response and caller restart', async () => {
  const fixture = await comfyFixture()
  const directory = join(fixture.directory, 'work')
  let store = openWorkStore(directory)
  const access = createAttempt(store, 'first')
  const next = { ...mediaRequest(), access: createAttempt(store, 'second'), operationId: 'next' }
  const request = { ...mediaRequest(), access }
  const mounted = await fixture.register()
  let registry = mounted.registry
  const pin = mounted.pin
  const authority = { current: (scope: typeof request.access) => scope.ownerId === access.ownerId, artifactAllowed: () => false }
  const config = () => mediaServiceConfigSchema.parse({ providers: { image: pin }, maxQueued: 2, maxPerAttempt: 1 })
  let jobs = store.createMediaJobs(registry, config(), authority)
  onTestFinished(async () => { await jobs.close(); await registry.close(); store.close() })

  fixture.faults.loseResponse = true
  let observedOnWire: Record<string, unknown> | undefined
  fixture.watchSubmit(() => {
    const reader = new DatabaseSync(join(directory, DATABASE_FILENAME), { readOnly: true })
    try { observedOnWire = reader.prepare("SELECT state, digest, prepared FROM media_jobs WHERE operation_id = 'render-1'").get() }
    finally { reader.close() }
  })
  expect(accepted(jobs.enqueue(request)).state).toBe('queued')
  expect(accepted(jobs.enqueue(next)).state).toBe('queued')
  expect(jobs.enqueue({ ...request, operationId: 'third' })).toEqual({ ok: false, code: 'busy' })
  await Promise.all([jobs.step(), jobs.step()])
  const uncertain = accepted(jobs.inspect({ access, operationId: request.operationId }))
  expect(uncertain.state).toBe('unknown')
  const originalId = fixture.submissions[0]?.prompt_id
  expect(originalId).toBeTruthy()
  expect(uncertain.handle?.handleId).toBe(originalId)
  expect(observedOnWire).toMatchObject({ state: 'submitting', digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
  const committed = JSON.parse(String(observedOnWire?.prepared))
  const body = fixture.submissions[0]!
  expect(committed).toMatchObject({ handle: { handleId: originalId },
    workflowDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    seed: (body.prompt as Record<string, { inputs: { seed: number } }>)['2']!.inputs.seed })

  await jobs.close()
  await registry.close()
  store.close()
  store = openWorkStore(directory)
  // An alternate configured revision must not take ownership of the admitted job.
  const replacement = await fixture.register(2)
  const original = await fixture.register(1)
  registry = original.registry
  const configured = mediaServiceConfigSchema.parse({ ...config(), providers: { image: replacement.pin } })
  await replacement.registry.close()
  jobs = store.createMediaJobs(registry, configured, authority)

  fixture.faults.missing = true
  await jobs.step()
  await jobs.step()
  expect(accepted(jobs.enqueue(request)).state).toBe('unknown')
  expect(jobs.enqueue({ ...request, prompt: 'Different request' })).toEqual({ ok: false, code: 'conflict' })
  expect(fixture.submissions).toHaveLength(1)
  expect(accepted(jobs.inspect({ access: next.access, operationId: next.operationId })).state).toBe('queued')

  fixture.faults.missing = false
  await jobs.step()
  expect(accepted(jobs.enqueue(request)).state).toBe('rendering')
  const bytes = fixture.complete(originalId!, imageSpec)
  await jobs.step()
  await jobs.step()
  const result = accepted(jobs.inspect({ access, operationId: request.operationId }))
  expect(result).toMatchObject({ state: 'succeeded', handle: { handleId: originalId, provider: { configRevision: 1 } },
    outputs: [{ mediaType: 'image/png', width: 16, height: 16, sizeBytes: bytes.length,
      contentHash: createHash('sha256').update(bytes).digest('hex') }] })
  expect(fixture.submissions.map(submission => submission.prompt_id)).toEqual([originalId])
  expect(accepted(jobs.cancel({ access: next.access, operationId: next.operationId })).state).toBe('cancelled')
  expect(fixture.cancelled).toEqual([])
})

it('reconciles the committed sending marker after the submitting process is killed before receipt', async () => {
  const fixture = await comfyFixture()
  const directory = join(fixture.directory, 'work')
  const store = openWorkStore(directory)
  const { registry, pin } = await fixture.register()
  const request = { ...mediaRequest(), access: createAttempt(store, 'crash') }
  const ref = { access: request.access, operationId: request.operationId }
  const jobs = store.createMediaJobs(registry, mediaServiceConfigSchema.parse({ providers: { image: pin } }),
    { current: () => true, artifactAllowed: () => false })
  try {
    expect(accepted(jobs.enqueue(request)).state).toBe('queued')
  } finally {
    await jobs.close()
    await registry.close()
    store.close()
  }

  const probe = fileURLToPath(new URL('./fixtures/media-caller.mjs', import.meta.url))
  const input = join(fixture.directory, 'caller.json')
  writeFileSync(input, JSON.stringify({ directory, config: fixture.config, ref }), { mode: 0o600 })
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
  const admitted = Promise.withResolvers<string>()
  fixture.faults.holdResponse = true
  fixture.watchSubmit(submission => admitted.resolve(submission.prompt_id))

  const sender = spawn(process.execPath, [probe, input, '1'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  sender.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const senderClosed = once(sender, 'close')
  onTestFinished(async () => {
    if (sender.exitCode === null && sender.signalCode === null) sender.kill('SIGKILL')
    await senderClosed
  })
  const id = await Promise.race([admitted.promise, senderClosed.then(([code, signal]) => {
    throw new Error(`Caller exited before the backend accepted the prompt (${code ?? signal}). ${stderr}`)
  })])
  expect(sender.kill('SIGKILL')).toBe(true)
  expect(await senderClosed).toEqual([null, 'SIGKILL'])

  const reader = new DatabaseSync(join(directory, DATABASE_FILENAME), { readOnly: true })
  try {
    const row = reader.prepare('SELECT state, prepared FROM media_jobs').get()
    expect(row?.state).toBe('submitting')
    expect(JSON.parse(String(row?.prepared)).handle.handleId).toBe(id)
  } finally { reader.close() }

  const bytes = fixture.complete(id, imageSpec)
  const { stdout } = await promisify(execFile)(process.execPath, [probe, input, '2'], { env, timeout: 10_000 })
  expect(JSON.parse(stdout)).toMatchObject({ ok: true, value: { state: 'succeeded', handle: { handleId: id },
    outputs: [{ mediaType: 'image/png', contentHash: createHash('sha256').update(bytes).digest('hex') }] } })
  expect(fixture.submissions.map(submission => submission.prompt_id)).toEqual([id])
}, 15_000)

it('keeps a rate-limited preparation queued and cancels the waiting job without a backend mutation', async () => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  const store = openWorkStore(join(fixture.directory, 'work'))
  const access = createAttempt(store, 'wait')
  const jobs = store.createMediaJobs(registry, mediaServiceConfigSchema.parse({ providers: { image: pin } }),
    { current: () => true, artifactAllowed: () => false })
  onTestFinished(async () => { await jobs.close(); await registry.close(); store.close() })
  const request = { ...mediaRequest(), access }
  fixture.faults.rateLimit = true
  expect(jobs.enqueue(request)).toMatchObject({ ok: true })
  await jobs.step()
  expect(accepted(jobs.inspect({ access, operationId: request.operationId }))).toMatchObject({ state: 'queued', reason: 'rate_limited' })
  expect(accepted(jobs.cancel({ access, operationId: request.operationId })).state).toBe('cancelled')
  expect(fixture.submissions).toEqual([])
  expect(fixture.cancelled).toEqual([])
})

it('waits for a GPU operation that starts during media preparation before submitting', async () => {
  const fixture = await comfyFixture()
  const preparing = Promise.withResolvers<void>()
  const releasePreparation = Promise.withResolvers<void>()
  const { registry, pin } = await fixture.register(1, {}, provider => {
    const durableSubmission = provider.durableSubmission!
    return {
      ...provider,
      durableSubmission: {
        ...durableSubmission,
        async prepare(request, signal) {
          preparing.resolve()
          await releasePreparation.promise
          return durableSubmission.prepare(request, signal)
        },
      },
    }
  })
  const store = openWorkStore(join(fixture.directory, 'work'))
  const access = createAttempt(store, 'media-preparing')
  const gpuAccess = createAttempt(store, 'gpu-during-preparation')
  const request = { ...mediaRequest(), access }
  const ref = { access, operationId: request.operationId }
  const gpu = createGpuQueue({}, () => !store.mediaLeaseHeld())
  const gpuStarted = Promise.withResolvers<void>()
  const releaseGpu = Promise.withResolvers<void>()
  const jobs = store.createMediaJobs(registry, mediaServiceConfigSchema.parse({ providers: { image: pin } }),
    { current: () => true, artifactAllowed: () => false, canLease: () => gpu.snapshot(access).active === 0 })
  onTestFinished(async () => {
    releasePreparation.resolve()
    releaseGpu.resolve()
    await jobs.close()
    await gpu.close()
    await registry.close()
    store.close()
  })

  expect(accepted(jobs.enqueue(request)).state).toBe('queued')
  const sending = jobs.step()
  await preparing.promise
  const admission = gpu.enqueue(gpuAccess, () => true, async () => {
    gpuStarted.resolve()
    await releaseGpu.promise
    return 'complete'
  })
  if (!admission.ok) throw new Error('Expected GPU admission, got ' + admission.code)
  await gpuStarted.promise
  releasePreparation.resolve()
  await sending

  expect(gpu.snapshot(access).active).toBe(1)
  expect(fixture.submissions).toEqual([])
  expect(accepted(jobs.inspect(ref))).toMatchObject({ state: 'queued', handle: undefined })
  expect(store.mediaLeaseHeld()).toBe(false)

  releaseGpu.resolve()
  expect(await admission.completion).toEqual({ ok: true, value: 'complete' })
  await vi.waitFor(() => expect(gpu.snapshot(access).active).toBe(0))
  await jobs.step()
  expect(fixture.submissions).toHaveLength(1)
  expect(accepted(jobs.inspect(ref))).toMatchObject({ state: 'rendering',
    handle: { handleId: fixture.submissions[0]!.prompt_id } })
  expect(store.mediaLeaseHeld()).toBe(true)
})

it('releases the media lease when a finished prompt has a missing output', async () => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  const store = openWorkStore(join(fixture.directory, 'work'))
  const first = { ...mediaRequest(), access: createAttempt(store, 'missing-output') }
  const next = { ...mediaRequest(), access: createAttempt(store, 'next-output') }
  const jobs = store.createMediaJobs(registry, mediaServiceConfigSchema.parse({ providers: { image: pin } }),
    { current: () => true, artifactAllowed: () => false })
  onTestFinished(async () => { await jobs.close(); await registry.close(); store.close() })

  const ref = { access: first.access, operationId: first.operationId }
  expect(accepted(jobs.enqueue(first)).state).toBe('queued')
  expect(accepted(jobs.enqueue(next)).state).toBe('queued')
  await jobs.step()
  const firstId = accepted(jobs.inspect(ref)).handle!.handleId
  fixture.complete(firstId, imageSpec)
  await jobs.step()

  fixture.faults.viewStatus = 503
  await jobs.step()
  expect(accepted(jobs.inspect(ref))).toMatchObject({ state: 'collecting', reason: 'provider_unavailable' })
  expect(store.mediaLeaseHeld()).toBe(true)
  expect(fixture.submissions.map(submission => submission.prompt_id)).toEqual([firstId])

  fixture.faults.viewStatus = 404
  await jobs.step()
  expect(accepted(jobs.inspect(ref))).toMatchObject({ state: 'failed', reason: 'invalid_result' })
  expect(store.mediaLeaseHeld()).toBe(false)
  expect(accepted(jobs.enqueue(first)).state).toBe('failed')

  await jobs.step()
  const nextStatus = accepted(jobs.inspect({ access: next.access, operationId: next.operationId }))
  expect(nextStatus.state).toBe('rendering')
  expect(nextStatus.handle?.handleId).not.toBe(firstId)
  expect(fixture.submissions.map(submission => submission.prompt_id)).toEqual([firstId, nextStatus.handle?.handleId])
})

it.each([imageSpec, videoSpec])('checks the acceptance relay against a simulated $modality upstream', async spec => {
  const upstream = await comfyFixture()
  upstream.watchSubmit(({ prompt_id }) => upstream.complete(prompt_id, spec))
  const evidence = await verifyComfyRecovery({
    ...upstream.config, workflows: upstream.config.workflows.filter(workflow => workflow.spec.modality === spec.modality),
  })
  expect(evidence.submissions).toBe(1)
  expect(upstream.submissions.map(request => request.prompt_id)).toEqual([evidence.promptId])
  expect(evidence.outputs).toHaveLength(1)
})


it('retries an interrupted output body without releasing the lease or rendering again', async () => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  const directory = join(fixture.directory, 'work')
  let store = openWorkStore(directory)
  const request = { ...mediaRequest(), access: createAttempt(store, 'interrupted-output') }
  const config = mediaServiceConfigSchema.parse({ providers: { image: pin } })
  const authority = { current: () => true, artifactAllowed: () => false }
  let jobs = store.createMediaJobs(registry, config, authority)
  onTestFinished(async () => { await jobs.close(); await registry.close(); store.close() })
  const ref = { access: request.access, operationId: request.operationId }
  accepted(jobs.enqueue(request))
  await jobs.step()
  const id = accepted(jobs.inspect(ref)).handle!.handleId
  const bytes = fixture.complete(id, imageSpec)
  await jobs.step()
  fixture.faults.interruptView = true
  await jobs.step()
  expect(accepted(jobs.inspect(ref))).toMatchObject({ state: 'collecting', reason: 'provider_unavailable' })
  expect(store.mediaLeaseHeld()).toBe(true)

  await jobs.close()
  store.close()
  store = openWorkStore(directory)
  jobs = store.createMediaJobs(registry, config, authority)
  expect(store.mediaLeaseHeld()).toBe(true)
  fixture.faults.interruptView = false
  await jobs.step()
  expect(accepted(jobs.inspect(ref))).toMatchObject({ state: 'succeeded',
    outputs: [{ contentHash: createHash('sha256').update(bytes).digest('hex') }] })
  expect(store.mediaLeaseHeld()).toBe(false)
  expect(fixture.submissions.map(submission => submission.prompt_id)).toEqual([id])
})


it('keeps an unproven cancelled render leased after a lost cancel reply and a cold reopen', async () => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  const directory = join(fixture.directory, 'work')
  let store = openWorkStore(directory)
  const request = { ...mediaRequest(), access: createAttempt(store, 'cancel-receipt') }
  const next = { ...mediaRequest(), operationId: 'next', access: createAttempt(store, 'after-cancel-receipt') }
  const ref = { access: request.access, operationId: request.operationId }
  const config = mediaServiceConfigSchema.parse({ providers: { image: pin } })
  const authority = { current: () => true, artifactAllowed: () => false }
  let jobs = store.createMediaJobs(registry, config, authority)
  onTestFinished(async () => { await jobs.close(); await registry.close(); store.close() })
  accepted(jobs.enqueue(request))
  accepted(jobs.enqueue(next))
  await jobs.step()
  const id = accepted(jobs.inspect(ref)).handle!.handleId
  fixture.faults.loseCancelResponse = true
  accepted(jobs.cancel(ref))
  await jobs.step()
  expect(accepted(jobs.inspect(ref)).state).toBe('unknown')
  expect(store.mediaLeaseHeld()).toBe(true)
  await jobs.close()
  store.close()
  store = openWorkStore(directory)
  jobs = store.createMediaJobs(registry, config, authority)
  await jobs.step()
  expect(accepted(jobs.inspect(ref)).state).toBe('unknown')
  expect(store.mediaLeaseHeld()).toBe(true)
  expect(accepted(jobs.inspect({ access: next.access, operationId: next.operationId })).state).toBe('queued')
  expect(fixture.submissions.map(submission => submission.prompt_id)).toEqual([id])
  expect(fixture.cancelled).toEqual([id])
})

it.each(['rendering', 'collecting'] as const)('recovers a completed render from %s while the unrelated queue is oversized', async state => {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  const store = openWorkStore(join(fixture.directory, 'work'))
  const request = { ...mediaRequest(), access: createAttempt(store, 'queue-overflow') }
  const ref = { access: request.access, operationId: request.operationId }
  const config = mediaServiceConfigSchema.parse({ providers: { image: pin } })
  const jobs = store.createMediaJobs(registry, config, { current: () => true, artifactAllowed: () => false })
  onTestFinished(async () => { await jobs.close(); await registry.close(); store.close() })

  accepted(jobs.enqueue(request))
  await jobs.step()
  const id = accepted(jobs.inspect(ref)).handle!.handleId
  const bytes = fixture.complete(id, imageSpec)
  if (state === 'collecting') await jobs.step()
  expect(accepted(jobs.inspect(ref))).toMatchObject({ state, handle: { handleId: id } })
  expect(store.mediaLeaseHeld()).toBe(true)
  const unrelated = fixture.crowdQueue()

  if (state === 'rendering') {
    await jobs.step()
    expect(accepted(jobs.inspect(ref))).toMatchObject({ state: 'collecting', handle: { handleId: id } })
    expect(store.mediaLeaseHeld()).toBe(true)
  }
  await jobs.step()
  expect(accepted(jobs.inspect(ref))).toMatchObject({
    state: 'succeeded', handle: { handleId: id },
    outputs: [{ contentHash: createHash('sha256').update(bytes).digest('hex') }],
  })
  expect(store.mediaLeaseHeld()).toBe(false)
  expect(fixture.submissions.map(submission => submission.prompt_id)).toEqual([id])
  expect(fixture.cancelled).toEqual([])
  expect([...fixture.pending.keys()]).toEqual(unrelated)
})
