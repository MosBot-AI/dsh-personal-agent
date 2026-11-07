import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  artifactIdSchema,
  attemptIdSchema,
  clientIdSchema,
  conversationSchema,
  deliverySchema,
  deviceIdSchema,
  effectSchema,
  mandateRefSchema,
  ownerIdSchema,
  profileIdSchema,
  projectSchema,
  sourceEventSchema,
  taskIdSchema,
  utcInstantSchema,
  type ArtifactId,
  type Delivery,
} from '../../packages/personal-agent/src/domain/model.js'
import type { WorkState } from '../../packages/personal-agent/src/domain/transitions.js'
import { DATABASE_FILENAME, QUARANTINE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore, type StoredWorkResult, type WorkRef } from '../../packages/personal-agent/src/storage/store.js'

const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const scope = { ownerId: ownerIdSchema.parse('owner'), profileId: profileIdSchema.parse('profile') }
const actor = {
  ...scope,
  role: 'owner',
  clientId: clientIdSchema.parse('client'),
  deviceId: deviceIdSchema.parse('device'),
  policyVersion: 'policy-1',
} as const
const criterion = 'Open the sealed result and verify its contents.'
const project = projectSchema.parse({
  ...scope,
  id: 'artifact-project', kind: 'project', title: 'Artifact verification', purpose: 'Check sealed result evidence.',
  resourceRefs: [], status: 'active', successCriteria: [criterion], planRevision: 1, milestones: [],
})
const conversation = conversationSchema.parse({
  ...scope,
  id: 'artifact-conversation', sessionIds: [],
  originalDestination: { sourceInstanceId: 'fixture-source', externalDestinationId: 'fixture-thread' },
})
const commandContext = { actor, at, projectId: project.id, conversationId: conversation.id }

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-artifact-integration-'))
  let store = openWorkStore(directory)
  onTestFinished(() => {
    try {
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  store.insertProject(project)
  store.insertConversation(conversation)
  return {
    directory,
    get store() { return store },
    reopen(change?: (db: DatabaseSync) => void) {
      store.close()
      if (change) {
        const db = new DatabaseSync(join(directory, DATABASE_FILENAME))
        try {
          change(db)
        } finally {
          db.close()
        }
      }
      store = openWorkStore(directory)
    },
  }
}

type Fixture = ReturnType<typeof fixture>

function succeed(result: StoredWorkResult): WorkState {
  if (!result.ok) throw new Error(`Expected a work transition, received ${result.code}`)
  return result.state
}

function fence(state: WorkState) {
  return { at, expectedVersion: state.task.version, attemptId: state.attempt.id, generation: state.attempt.generation }
}

function allocation(label: string) {
  return {
    id: attemptIdSchema.parse(`attempt-${label}`),
    mandate: mandateRefSchema.parse({ ...scope, id: `mandate-${label}`, policyVersion: actor.policyVersion }),
  }
}

function start(store: Fixture['store'], ref: WorkRef, queued: WorkState, label: string, nativeWorker = false): WorkState {
  const cursor = `input-${label}`
  return succeed(store.applyEvent(ref, {
    type: 'start', ...fence(queued), executor: nativeWorker ? 'native-dsh' : 'fixture-executor',
    ...(nativeWorker ? {
      sessionId: `session-${label}`,
      worker: { presetId: 'fixture', cwd: tmpdir(), provider: 'fixture', model: 'fixture', inputCursor: cursor, inputHistory: [cursor] },
    } : {}),
  }))
}

function seed(f: Fixture, label: string, { requiresReceipt = false, deliveries = [], nativeWorker = false }: {
  requiresReceipt?: boolean; deliveries?: Delivery[]; nativeWorker?: boolean
} = {}) {
  const taskId = taskIdSchema.parse(`task-${label}`)
  const newAttempt = allocation(label)
  const ref = { ...scope, taskId }
  const sourceEvent = sourceEventSchema.parse({
    ...scope,
    id: `source-${label}`, sourceInstanceId: conversation.originalDestination.sourceInstanceId,
    externalEventId: `event-${label}`, externalRevision: 'v1',
    actor: { kind: 'person', externalActorId: 'fixture-author' }, body: { text: 'Fixture source evidence.' },
    occurredAt: at, receivedAt: at, provenance: { description: 'Local artifact fixture.' },
  })
  const effect = effectSchema.parse({
    operationId: `effect-${label}`, taskId, attemptId: newAttempt.id, generation: 1,
    intent: 'Prepare exact fixture evidence.', payloadDigest: 'a'.repeat(64), status: 'prepared',
  })
  const queued = succeed(f.store.applyCommand({
    type: 'work.create', commandId: `create-${label}`, conversationId: conversation.id,
    payload: {
      projectId: project.id, requestedOutcome: 'Produce the sealed result.', constraints: [],
      acceptance: { criteria: [criterion], requiresArtifact: true, requiresReceipt },
    },
  }, { ...commandContext, newTaskId: taskId, newAttempt }, { sourceEvent, effects: [effect], deliveries }))
  return { ref, state: start(f.store, ref, queued, label, nativeWorker), effect, sourceId: sourceEvent.id }
}

function artifactInput(state: WorkState, id: string, text = 'Sealed fixture result.') {
  return {
    id,
    attemptId: state.attempt.id,
    generation: state.attempt.generation,
    expectedVersion: state.task.version,
    mediaType: 'text/plain',
    sourceEventIds: state.task.provenance.sourceEventIds,
    visibility: 'private',
    bytes: new TextEncoder().encode(text),
  }
}

function ready(f: Fixture, ref: WorkRef, state: WorkState, artifactIds: readonly ArtifactId[]) {
  return succeed(f.store.applyEvent(ref, { type: 'ready', ...fence(state), artifactIds }))
}

function checked(state: WorkState, evidence = 'Opened and inspected the sealed bytes.') {
  return state.task.acceptance.criteria.map(value => ({ criterion: value, satisfied: true, evidence }))
}

function pendingDelivery(id: string, artifactIds: readonly ArtifactId[], dedupeKey = id) {
  return deliverySchema.parse({
    ...scope, id, dedupeKey, destination: conversation.originalDestination,
    payload: { text: 'Verified local fixture result.', artifactIds }, retries: 0, status: 'pending',
  })
}

describe('sealed artifacts and verified work', () => {
  it('seals bounded UTF-8/JSON bytes in immutable linear versions with scoped readback', () => {
    const f = fixture()
    const first = seed(f, 'versions')
    const other = seed(f, 'other')
    const initial = artifactInput(first.state, 'artifact-v1', '已验收的产物')
    const sealed = f.store.artifacts.seal(first.ref, initial)
    expect(sealed).toMatchObject({
      taskId: first.ref.taskId, generation: first.state.attempt.generation, version: 1,
      artifact: {
        ownerId: scope.ownerId, profileId: scope.profileId, attemptId: first.state.attempt.id,
        contentHash: createHash('sha256').update(initial.bytes).digest('hex'),
        provenance: { sourceEventIds: [first.sourceId] }, visibility: 'private', storageRef: 'sqlite:artifact:artifact-v1',
      },
    })
    initial.bytes.fill(0)
    sealed.bytes.fill(0)
    expect(new TextDecoder().decode(f.store.artifacts.read(first.ref, sealed.artifact.id)?.bytes)).toBe('已验收的产物')
    expect(f.store.artifacts.read(other.ref, sealed.artifact.id)).toBeUndefined()
    expect(f.store.artifacts.read({ ...first.ref, ownerId: ownerIdSchema.parse('another-owner') }, sealed.artifact.id)).toBeUndefined()
    expect(f.store.artifacts.read({ ...first.ref, profileId: profileIdSchema.parse('another-profile') }, sealed.artifact.id)).toBeUndefined()

    const revision = {
      ...artifactInput(first.state, 'artifact-v2', '{"result":"verified"}'),
      previousId: sealed.artifact.id,
      mediaType: 'application/json',
    }
    const next = f.store.artifacts.seal(first.ref, revision)
    expect(next).toMatchObject({ version: 2, previousId: sealed.artifact.id })
    expect(() => f.store.artifacts.seal(first.ref, { ...revision, id: 'forked-artifact' }))
      .toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.artifacts.seal(other.ref, { ...artifactInput(other.state, 'foreign-version'), previousId: sealed.artifact.id }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' }))
    for (const input of [
      { ...artifactInput(first.state, 'bad-utf8'), bytes: Uint8Array.of(0xc3, 0x28) },
      { ...artifactInput(first.state, 'bad-json', '{'), mediaType: 'application/json' },
      { ...artifactInput(first.state, 'too-large'), bytes: new Uint8Array(256 * 1024 + 1) },
      { ...artifactInput(first.state, 'unknown-source'), sourceEventIds: ['missing-source'] },
    ]) {
      expect(() => f.store.artifacts.seal(first.ref, input)).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    }
    expect(() => f.store.artifacts.seal(first.ref, { ...artifactInput(first.state, 'stale-version'), expectedVersion: 1 }))
      .toThrow(expect.objectContaining({ code: 'version_conflict' }))
    expect(() => f.store.artifacts.seal(first.ref, { ...artifactInput(first.state, 'stale-generation'), generation: 2 }))
      .toThrow(expect.objectContaining({ code: 'stale_attempt' }))
    f.reopen()
    expect(new TextDecoder().decode(f.store.artifacts.read(first.ref, next.artifact.id)?.bytes)).toBe('{"result":"verified"}')
  })

  it('requires sealed artifacts from the current attempt and rejects verification without native release proof', async () => {
    const f = fixture()
    const first = seed(f, 'retry')
    const previous = f.store.artifacts.seal(first.ref, artifactInput(first.state, 'previous-attempt-artifact'))
    const failed = succeed(f.store.applyEvent(first.ref, {
      type: 'fail', ...fence(first.state), runtimeQuiescent: true, uncertainEffects: false, reason: 'Fixture attempt failed.',
    }))
    const retried = succeed(f.store.applyCommand({
      type: 'work.retry', commandId: 'retry-artifact', taskId: first.ref.taskId,
      expectedVersion: failed.task.version, payload: {},
    }, { ...commandContext, newAttempt: allocation('retry-next') }))
    const running = start(f.store, first.ref, retried, 'retry-next')
    expect(f.store.artifacts.read(first.ref, previous.artifact.id)?.artifact.attemptId).toBe(first.state.attempt.id)
    for (const artifactIds of [[], [artifactIdSchema.parse('missing')], [previous.artifact.id]]) {
      expect(f.store.applyEvent(first.ref, { type: 'ready', ...fence(running), artifactIds }))
        .toEqual({ ok: false, code: 'acceptance_unsatisfied' })
    }
    const artifact = f.store.artifacts.seal(first.ref, {
      ...artifactInput(running, 'retry-result', '{"accepted":true}'), mediaType: 'application/json', previousId: previous.artifact.id,
    })
    const verifying = ready(f, first.ref, running, [artifact.artifact.id])
    expect(f.store.applyEvent(first.ref, {
      type: 'verify', ...fence(verifying), evidence: { criteriaSatisfied: true, artifactIds: [artifact.artifact.id] },
    })).toEqual({ ok: false, code: 'permission_denied' })

    const native = seed(f, 'not-released', { nativeWorker: true })
    const nativeArtifact = f.store.artifacts.seal(native.ref, artifactInput(native.state, 'unreleased-result'))
    const nativeVerifying = ready(f, native.ref, native.state, [nativeArtifact.artifact.id])
    expect(f.store.applyEvent(native.ref, { type: 'release_worker', ...fence(nativeVerifying) }))
      .toEqual({ ok: false, code: 'permission_denied' })
    expect(f.store.confirmWorkerRelease({ ref: native.ref, ...fence(nativeVerifying) }))
      .toEqual({ ok: false, code: 'permission_denied' })
    let checks = 0
    const verifier = f.store.createVerifier({ now: () => at, check({ state, artifacts }) {
      checks++
      expect(artifacts).toHaveLength(1)
      const exact = artifacts[0]!
      expect(exact.artifact.attemptId).toBe(running.attempt.id)
      expect(JSON.parse(new TextDecoder().decode(exact.bytes))).toEqual({ accepted: true })
      return checked(state)
    } })
    expect(await verifier.verify(native.ref, { expectedVersion: nativeVerifying.task.version }))
      .toEqual({ ok: false, code: 'invalid_transition' })
    expect(checks).toBe(0)
    const wrongCriteria = f.store.createVerifier({ now: () => at, check: () => [
      { criterion: 'A different claim', satisfied: true, evidence: 'Unrelated observation' },
    ] })
    expect(await wrongCriteria.verify(first.ref, { expectedVersion: verifying.task.version }))
      .toEqual({ ok: false, code: 'acceptance_unsatisfied' })
    const completed = succeed(await verifier.verify(first.ref, { expectedVersion: verifying.task.version }))
    expect(checks).toBe(1)
    expect(completed.task.status).toBe('completed')
    expect(f.store.getVerification(first.ref, completed.task.version)).toMatchObject({
      attemptId: running.attempt.id,
      criteria: checked(verifying),
      artifacts: [{ id: artifact.artifact.id, version: 2, digest: artifact.artifact.contentHash }],
    })
  })

  it('detects changed persisted bytes before calling the verifier', async () => {
    const f = fixture()
    const work = seed(f, 'tampered')
    const artifact = f.store.artifacts.seal(work.ref, artifactInput(work.state, 'artifact-tampered'))
    const verifying = ready(f, work.ref, work.state, [artifact.artifact.id])
    f.reopen(db => db.prepare('UPDATE artifacts SET content = ? WHERE id = ?')
      .run(new TextEncoder().encode('Tampered fixture bytes.'), artifact.artifact.id))
    let checkedBytes = false
    const verifier = f.store.createVerifier({ now: () => at, check({ state }) {
      checkedBytes = true
      return checked(state)
    } })
    await expect(verifier.verify(work.ref, { expectedVersion: verifying.task.version }))
      .rejects.toMatchObject({ code: 'corrupt' })
    expect(checkedBytes).toBe(false)
    expect(existsSync(join(f.directory, QUARANTINE_FILENAME))).toBe(true)
  })

  it('rechecks task revision after an asynchronous criteria check', async () => {
    const f = fixture()
    const work = seed(f, 'stale')
    const artifact = f.store.artifacts.seal(work.ref, artifactInput(work.state, 'artifact-stale'))
    const verifying = ready(f, work.ref, work.state, [artifact.artifact.id])
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const verifier = f.store.createVerifier({ now: () => at, async check({ state }) {
      entered.resolve()
      await resume.promise
      return checked(state)
    } })
    const pending = verifier.verify(work.ref, { expectedVersion: verifying.task.version })
    await entered.promise
    try {
      succeed(f.store.applyCommand({
        type: 'work.pause', commandId: 'pause-during-verify', taskId: work.ref.taskId,
        expectedVersion: verifying.task.version, payload: {},
      }, commandContext))
    } finally {
      resume.resolve()
    }
    expect(await pending).toEqual({ ok: false, code: 'version_conflict' })
    expect(f.store.getWork(work.ref)?.task.status).toBe('paused')
    expect(f.store.getVerification(work.ref, verifying.task.version + 1)).toBeUndefined()
  })

  it('commits verification and original-destination deliveries atomically and preserves them on reopen', async () => {
    const f = fixture()
    const priorDelivery = pendingDelivery('prior', [], 'occupied-key')
    const prior = seed(f, 'prior', { deliveries: [priorDelivery] })
    const work = seed(f, 'delivery')
    const artifact = f.store.artifacts.seal(work.ref, artifactInput(work.state, 'artifact-delivered'))
    const unverified = f.store.artifacts.seal(work.ref, artifactInput(work.state, 'artifact-unverified'))
    const verifying = ready(f, work.ref, work.state, [artifact.artifact.id])
    const verifier = f.store.createVerifier({ now: () => at, check: ({ state }) => checked(state) })
    const final = pendingDelivery('final', [artifact.artifact.id])
    const duplicate = pendingDelivery('duplicate', [artifact.artifact.id], priorDelivery.dedupeKey)
    const verify = (deliveries: readonly Delivery[]) => verifier.verify(work.ref, { expectedVersion: verifying.task.version, deliveries })

    expect(await verify([{
      ...final, destination: { ...final.destination, externalDestinationId: 'wrong-thread' },
    }])).toEqual({ ok: false, code: 'permission_denied' })
    expect(await verify([pendingDelivery('unverified', [unverified.artifact.id])]))
      .toEqual({ ok: false, code: 'permission_denied' })
    expect(await verify([final, duplicate])).toEqual({ ok: false, code: 'conflict' })
    expect(f.store.getWork(work.ref)).toEqual(verifying)
    expect(f.store.getVerification(work.ref, verifying.task.version + 1)).toBeUndefined()
    expect(f.store.getDelivery(work.ref, final.id)).toBeUndefined()
    expect(f.store.getDelivery(work.ref, duplicate.id)).toBeUndefined()
    expect(f.store.getDelivery(prior.ref, priorDelivery.id)).toEqual(priorDelivery)

    const completed = succeed(await verify([final]))
    f.reopen(db => {
      expect(() => db.prepare(`
        UPDATE outbox SET record = json_set(record, '$.destination.externalDestinationId', 'changed')
        WHERE id = ?
      `).run(final.id)).toThrow(/Outbox intent is immutable/)
      expect(() => db.prepare(`
        UPDATE outbox SET record = json_set(record, '$.payload.text', 'changed') WHERE id = ?
      `).run(final.id)).toThrow(/Outbox intent is immutable/)
    })
    expect(f.store.getWork(work.ref)).toEqual(completed)
    expect(f.store.getVerification(work.ref, completed.task.version)).toMatchObject({
      taskId: work.ref.taskId, version: completed.task.version, verifiedAt: at,
      artifacts: [{ id: artifact.artifact.id, version: 1, digest: artifact.artifact.contentHash }],
    })
    expect(f.store.getVerification(prior.ref, completed.task.version)).toBeUndefined()
    expect(f.store.getVerification({ ...work.ref, ownerId: ownerIdSchema.parse('another-owner') }, completed.task.version))
      .toBeUndefined()
    expect(f.store.getDelivery(work.ref, final.id)).toEqual(final)
    expect(f.store.getDelivery(prior.ref, final.id)).toBeUndefined()
  })

  it('accepts only a confirmed effect receipt from the exact producing attempt', async () => {
    const f = fixture()
    const work = seed(f, 'receipt', { requiresReceipt: true })
    const failed = succeed(f.store.applyEvent(work.ref, {
      type: 'fail', ...fence(work.state), runtimeQuiescent: true, uncertainEffects: false, reason: 'Earlier attempt failed.',
    }))
    const retried = succeed(f.store.applyCommand({
      type: 'work.retry', commandId: 'retry-receipt', taskId: work.ref.taskId,
      expectedVersion: failed.task.version, payload: {},
    }, { ...commandContext, newAttempt: allocation('receipt-current') }))
    const currentEffect = effectSchema.parse({
      ...work.effect, operationId: 'current-effect', attemptId: retried.attempt.id, generation: retried.attempt.generation,
    })
    const running = succeed(f.store.applyEvent(work.ref, { type: 'start', ...fence(retried), executor: 'fixture-executor' }, {
      effects: [currentEffect],
    }))
    const artifact = f.store.artifacts.seal(work.ref, artifactInput(running, 'receipt-artifact'))
    const verifying = ready(f, work.ref, running, [artifact.artifact.id])
    const makeVerifier = () => f.store.createVerifier({ now: () => at, check: ({ state }) => checked(state) })
    const request = { expectedVersion: verifying.task.version, effectOperationId: currentEffect.operationId }
    expect(await makeVerifier().verify(work.ref, request)).toEqual({ ok: false, code: 'acceptance_unsatisfied' })

    const receipt = { providerReceiptId: 'fixture-provider-receipt', recordedAt: at }
    f.reopen(db => {
      // Simulate a trusted provider readback. This test never sends an effect.
      const update = db.prepare('UPDATE effects SET record = ? WHERE operation_id = ?')
      for (const effect of [work.effect, currentEffect]) {
        const confirmed = effectSchema.parse({ ...effect, status: 'confirmed', grantId: 'fixture-grant', receipt })
        update.run(JSON.stringify(confirmed), effect.operationId)
      }
    })
    expect(f.store.getEffect(work.ref, work.effect.operationId)?.status).toBe('confirmed')
    expect(await makeVerifier().verify(work.ref, { ...request, effectOperationId: work.effect.operationId }))
      .toEqual({ ok: false, code: 'acceptance_unsatisfied' })
    const completed = succeed(await makeVerifier().verify(work.ref, request))
    expect(completed.attempt.outcome?.receiptId).toBe(receipt.providerReceiptId)
    expect(f.store.getVerification(work.ref, completed.task.version)?.effectReceipt)
      .toEqual({ operationId: currentEffect.operationId, ...receipt })
  })
})
