import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished } from 'vitest'
import {
  attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, ownerIdSchema, profileIdSchema,
  projectSchema, taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { mediaServiceConfigSchema } from '../../packages/personal-agent/src/media/jobs.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'
import { accepted, comfyFixture, imageSpec, mediaRequest } from './fixture.js'

function createAttempt(store: WorkStore, label: string) {
  const fixture = mediaRequest()
  const scope = { ownerId: ownerIdSchema.parse(fixture.access.ownerId), profileId: profileIdSchema.parse(fixture.access.profileId) }
  const actor = { ...scope, role: 'owner' as const, clientId: clientIdSchema.parse('local'),
    deviceId: deviceIdSchema.parse('local'), policyVersion: 'media-test' }
  const project = projectSchema.parse({ ...scope, id: 'project-' + label, kind: 'project', title: 'Media fixture',
    purpose: 'Exercise media recovery', resourceRefs: [], status: 'active', successCriteria: ['Read back output'], planRevision: 1, milestones: [] })
  store.insertProject(project)
  const taskId = taskIdSchema.parse('task-' + label)
  const result = store.applyCommand({ type: 'work.create', commandId: 'create-' + label,
    payload: { projectId: project.id, requestedOutcome: 'Render media', constraints: [],
      acceptance: { criteria: ['Verify output'], requiresArtifact: false, requiresReceipt: false } } },
  {
    actor, at: utcInstantSchema.parse('2026-11-08T08:00:00.000Z'), projectId: project.id, newTaskId: taskId,
    newAttempt: { id: attemptIdSchema.parse('attempt-' + label),
      mandate: mandateRefSchema.parse({ ...scope, id: 'mandate-' + label, policyVersion: actor.policyVersion }) },
  })
  if (!result.ok) throw new Error(result.code)
  return { ...scope, taskId, attemptId: result.state.attempt.id, generation: result.state.attempt.generation }
}

it('recovers the original prompt and artifact digest after a lost submit response and caller restart', async () => {
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
