import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
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
} from '../../packages/personal-agent/src/domain/model.js'
import type { WorkState } from '../../packages/personal-agent/src/domain/transitions.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'

type Store = ReturnType<typeof openWorkStore>
type ApplyResult = ReturnType<Store['applyCommand']>

const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const ownerId = ownerIdSchema.parse('owner')
const profileId = profileIdSchema.parse('profile')
const actor = {
  role: 'owner',
  ownerId,
  profileId,
  clientId: clientIdSchema.parse('client'),
  deviceId: deviceIdSchema.parse('device'),
  policyVersion: 'policy-1',
} as const
const project = projectSchema.parse({
  id: 'project',
  ownerId,
  profileId,
  kind: 'project',
  title: 'Storage contract fixture',
  purpose: 'Verify durable work intake.',
  resourceRefs: [],
  status: 'active',
  successCriteria: ['Transactions preserve all work records.'],
  planRevision: 1,
  milestones: [],
})
const conversation = conversationSchema.parse({
  id: 'conversation',
  ownerId,
  profileId,
  sessionIds: [],
  originalDestination: { sourceInstanceId: 'fixture-source', externalDestinationId: 'fixture-thread' },
})

function openFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-store-atomicity-'))
  let store: Store | undefined
  onTestFinished(() => {
    try {
      store?.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  store = openWorkStore(directory)
  store.insertProject(project)
  store.insertConversation(conversation)
  return {
    directory,
    store,
    reopen(beforeOpen?: () => void) {
      store?.close()
      store = undefined
      beforeOpen?.()
      store = openWorkStore(directory)
      return store
    },
  }
}

function allocation(label: string, scope = actor) {
  return {
    id: attemptIdSchema.parse(`attempt-${label}`),
    mandate: mandateRefSchema.parse({
      id: `mandate-${label}`,
      ownerId: scope.ownerId,
      profileId: scope.profileId,
      policyVersion: scope.policyVersion,
    }),
  }
}

function intake(label: string, route = { actor, project, conversation }) {
  const taskId = taskIdSchema.parse(`task-${label}`)
  return {
    ref: { ownerId: route.actor.ownerId, profileId: route.actor.profileId, taskId },
    context: {
      actor: route.actor,
      at,
      projectId: route.project.id,
      conversationId: route.conversation.id,
      newTaskId: taskId,
      newAttempt: allocation(label, route.actor),
    },
    command: {
      type: 'work.create',
      commandId: `create-${label}`,
      conversationId: route.conversation.id,
      payload: {
        projectId: route.project.id,
        requestedOutcome: 'Record one accepted unit of work.',
        constraints: [],
        acceptance: { criteria: ['Provide evidence.'], requiresArtifact: false, requiresReceipt: false },
      },
    },
  }
}

function source(id: string, externalEventId = id, externalRevision = 'v1') {
  return sourceEventSchema.parse({
    id,
    ownerId,
    profileId,
    sourceInstanceId: conversation.originalDestination.sourceInstanceId,
    externalEventId,
    externalRevision,
    actor: { kind: 'person', externalActorId: 'fixture-actor' },
    body: { text: 'Fixture intake.' },
    occurredAt: at,
    receivedAt: at,
    threadId: conversation.originalDestination.externalDestinationId,
    provenance: { description: 'Fixture source.' },
  })
}

function effect(input: ReturnType<typeof intake>, operationId: string, generation = 1) {
  return effectSchema.parse({
    operationId,
    taskId: input.ref.taskId,
    attemptId: input.context.newAttempt.id,
    generation,
    intent: 'Prepare a fixture effect for separate authorization.',
    payloadDigest: 'a'.repeat(64),
    status: 'prepared',
  })
}

function delivery(id: string, dedupeKey = id) {
  return deliverySchema.parse({
    id,
    ownerId,
    profileId,
    destination: conversation.originalDestination,
    payload: { text: 'Fixture delivery.', artifactIds: [] },
    dedupeKey,
    retries: 0,
    status: 'pending',
  })
}

function committed(result: ApplyResult) {
  if (!result.ok) throw new Error(`Expected a committed change, received ${result.code}`)
  expect(result.replayed).toBe(false)
  if (result.sequence === undefined) throw new Error('Expected a work event sequence')
  return { ...result, sequence: result.sequence }
}

function fence(state: WorkState) {
  return {
    expectedVersion: state.task.version,
    at,
    attemptId: state.attempt.id,
    generation: state.attempt.generation,
  }
}

function injectFixtureSql(directory: string, sql: string): void {
  const db = new DatabaseSync(join(directory, DATABASE_FILENAME))
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

describe('SQLite work atomicity', () => {
  it('commits the task, source provenance, prepared effect and outbox together', () => {
    const { store, directory } = openFixture()
    const input = intake('atomic')
    const sourceEvent = source('source-atomic')
    const prepared = effect(input, 'operation-atomic')
    const pending = delivery('delivery-atomic')
    const accepted = committed(store.applyCommand(input.command, input.context, {
      sourceEvent,
      effects: [prepared],
      deliveries: [pending],
    }))

    expect(accepted.state.task).toMatchObject({
      id: input.ref.taskId,
      version: 1,
      status: 'queued',
      provenance: { sourceEventIds: [sourceEvent.id] },
    })
    expect(store.getWork(input.ref)).toEqual(accepted.state)
    expect(store.getAttempt(input.ref, input.context.newAttempt.id)).toEqual(accepted.state.attempt)
    expect(store.getEffect(input.ref, prepared.operationId)).toEqual(prepared)
    expect(store.getDelivery(input.ref, pending.id)).toEqual(pending)
    store.close()

    const readback = new DatabaseSync(join(directory, DATABASE_FILENAME), { readOnly: true })
    try {
      expect(readback.prepare(`
        SELECT w.task_id, s.external_event_id, s.external_revision
        FROM work_events w JOIN source_events s ON s.id = w.source_event_id
        WHERE w.sequence = ?
      `).get(accepted.sequence)).toEqual({
        task_id: input.ref.taskId,
        external_event_id: sourceEvent.externalEventId,
        external_revision: sourceEvent.externalRevision,
      })
    } finally {
      readback.close()
    }
  })

  it('replays a canonical command before stale revision checks and rejects a changed request', () => {
    const { store } = openFixture()
    const input = intake('replay')
    const queued = committed(store.applyCommand(input.command, input.context)).state
    const running = committed(store.applyEvent(input.ref, {
      type: 'start', executor: 'native-dsh', ...fence(queued),
    })).state
    const pause = {
      type: 'work.pause',
      commandId: 'pause-replay',
      taskId: input.ref.taskId,
      expectedVersion: running.task.version,
      payload: {},
    }
    const paused = committed(store.applyCommand(pause, input.context))
    const cancelling = committed(store.applyCommand({
      ...pause,
      type: 'work.cancel',
      commandId: 'cancel-replay',
      expectedVersion: paused.state.task.version,
    }, input.context))

    expect(store.applyCommand({
      payload: {},
      expectedVersion: pause.expectedVersion,
      taskId: pause.taskId,
      commandId: pause.commandId,
      type: pause.type,
    }, input.context)).toEqual({ ...paused, replayed: true })
    expect(store.applyCommand({ ...pause, expectedVersion: cancelling.state.task.version }, input.context))
      .toMatchObject({ ok: false, code: 'command_conflict' })
    expect(store.applyCommand({ ...pause, commandId: 'stale-pause' }, input.context))
      .toMatchObject({ ok: false, code: 'version_conflict' })
    expect(store.getWork(input.ref)).toEqual(cancelling.state)
  })

  it('enforces trusted project and conversation routing on fresh commands and replays', () => {
    const { store } = openFixture()
    const input = intake('route')
    const otherProject = projectSchema.parse({ ...project, id: 'project-other' })
    const otherConversation = conversationSchema.parse({ ...conversation, id: 'conversation-other' })
    store.insertProject(otherProject)
    store.insertConversation(otherConversation)

    expect(store.applyCommand(input.command, { ...input.context, projectId: otherProject.id }))
      .toMatchObject({ ok: false, code: 'not_found' })
    expect(store.applyCommand(input.command, { ...input.context, conversationId: otherConversation.id }))
      .toMatchObject({ ok: false, code: 'not_found' })
    const created = committed(store.applyCommand(input.command, input.context)).state
    expect(store.applyCommand(input.command, { ...input.context, projectId: otherProject.id }))
      .toMatchObject({ ok: false, code: 'command_conflict' })
    expect(store.getWork({ ...input.ref, profileId: profileIdSchema.parse('profile-other') }))
      .toBeUndefined()

    const cancel = {
      type: 'work.cancel',
      commandId: 'cancel-route',
      taskId: input.ref.taskId,
      expectedVersion: created.task.version,
      payload: {},
    }
    expect(store.applyCommand(cancel, { ...input.context, projectId: otherProject.id }))
      .toMatchObject({ ok: false, code: 'not_found' })
    expect(store.applyCommand(cancel, { ...input.context, conversationId: otherConversation.id }))
      .toMatchObject({ ok: false, code: 'not_found' })
    expect(store.getWork(input.ref)).toEqual(created)
  })

  it('deduplicates source instance, external event and revision across command IDs', () => {
    const { store } = openFixture()
    const first = intake('source-first')
    const second = intake('source-second')
    const sourceEvent = source('source-first', 'external-event')
    const original = committed(store.applyCommand(first.command, first.context, { sourceEvent }))

    expect(store.applyCommand(first.command, first.context, { sourceEvent }))
      .toEqual({ ...original, replayed: true })
    expect(store.applyCommand(second.command, second.context, {
      sourceEvent: source('source-redelivery', 'external-event'),
    })).toMatchObject({ ok: false, code: 'source_duplicate' })
    expect(store.getWork(second.ref)).toBeUndefined()
    const revised = source('source-redelivery', 'external-event', 'v2')
    const accepted = committed(store.applyCommand(second.command, second.context, { sourceEvent: revised }))
    expect(accepted.state.task.provenance.sourceEventIds).toEqual([revised.id])
  })

  it.each(['effect', 'outbox'] as const)('rolls back intake when a later %s key conflicts', conflict => {
    const { store } = openFixture()
    const original = intake('original')
    const originalEffect = effect(original, 'operation-original')
    const originalDelivery = delivery('delivery-original', 'dedupe-original')
    const first = committed(store.applyCommand(original.command, original.context, {
      effects: [originalEffect],
      deliveries: [originalDelivery],
    }))

    const input = intake('rollback')
    const sourceEvent = source('source-rollback')
    const prepared = effect(input, 'operation-rollback')
    const pending = delivery('delivery-rollback')
    const intents = {
      sourceEvent,
      effects: [prepared],
      deliveries: [pending],
    }
    const failingIntents = conflict === 'effect'
      ? { ...intents, effects: [prepared, effect(input, originalEffect.operationId)] }
      : { ...intents, deliveries: [pending, delivery('delivery-duplicate', originalDelivery.dedupeKey)] }

    expect(store.applyCommand(input.command, input.context, failingIntents))
      .toMatchObject({ ok: false, code: 'conflict' })
    expect(store.getWork(input.ref)).toBeUndefined()
    expect(store.getAttempt(input.ref, input.context.newAttempt.id)).toBeUndefined()
    expect(store.getEffect(input.ref, prepared.operationId)).toBeUndefined()
    expect(store.getDelivery(input.ref, pending.id)).toBeUndefined()
    expect(store.getWork(original.ref)).toEqual(first.state)
    expect(store.getEffect(original.ref, originalEffect.operationId)).toEqual(originalEffect)
    expect(store.getDelivery(original.ref, originalDelivery.id)).toEqual(originalDelivery)

    // Reuse every new key to detect any leaked command, input, task, attempt or intent.
    const accepted = committed(store.applyCommand(input.command, input.context, intents))
    expect(accepted.sequence).toBe(first.sequence + 1)
    expect(accepted.state.task.provenance.sourceEventIds).toEqual([sourceEvent.id])
    expect(store.getEffect(input.ref, prepared.operationId)).toEqual(prepared)
    expect(store.getDelivery(input.ref, pending.id)).toEqual(pending)
  })

  it('rolls back a command and all its writes when a deferred foreign key fails at commit', () => {
    const fixture = openFixture()
    const input = intake('foreign-key')
    const sourceEvent = source('source-foreign-key')
    const prepared = effect(input, 'operation-foreign-key')
    const pending = delivery('delivery-foreign-key')
    const intents = { sourceEvent, effects: [prepared], deliveries: [pending] }
    // The trigger inserts an orphan only within the store's transaction.
    // A deferred FK forces failure at COMMIT after the other writes ran.
    const store = fixture.reopen(() => injectFixtureSql(fixture.directory, `
      CREATE TABLE fixture_fk (task_id TEXT NOT NULL
        REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
      CREATE TRIGGER fixture_fk_failure AFTER INSERT ON outbox
        WHEN new.id = 'delivery-foreign-key'
        BEGIN INSERT INTO fixture_fk VALUES ('fixture-missing-task'); END;
    `))
    expect(store.applyCommand(input.command, input.context, intents))
      .toMatchObject({ ok: false, code: 'conflict' })
    expect(store.getWork(input.ref)).toBeUndefined()

    const reopened = fixture.reopen(() =>
      injectFixtureSql(fixture.directory, 'DROP TRIGGER fixture_fk_failure; DROP TABLE fixture_fk'))
    const accepted = committed(reopened.applyCommand(input.command, input.context, intents))
    expect(accepted.sequence).toBe(1)
    expect(reopened.getEffect(input.ref, prepared.operationId)).toEqual(prepared)
    expect(reopened.getDelivery(input.ref, pending.id)).toEqual(pending)
  })

  it('rolls back when encoded records exceed the transaction budget', () => {
    const { store } = openFixture()
    const input = intake('oversized')
    const sourceEvent = source('source-oversized')
    const oversized = {
      ...input.command,
      payload: { ...input.command.payload, requestedOutcome: 'x'.repeat(600_000) },
    }
    // The command fits in the input limit. Its Task and replay receipt would
    // exceed the shared write budget after encoding both records.
    expect(store.applyCommand(oversized, input.context, { sourceEvent }))
      .toMatchObject({ ok: false, code: 'invalid_input' })
    expect(store.getWork(input.ref)).toBeUndefined()

    const accepted = committed(store.applyCommand(input.command, input.context, { sourceEvent }))
    expect(accepted.sequence).toBe(1)
    expect(accepted.state.task.provenance.sourceEventIds).toEqual([sourceEvent.id])
  })

  it('shares the intent count limit across effects and deliveries', () => {
    const { store } = openFixture()
    const input = intake('intent-count')
    const prepared = effect(input, 'operation-count')
    const deliveries = Array.from({ length: 64 }, (_, index) => delivery(`delivery-count-${index}`))
    expect(store.applyCommand(input.command, input.context, { effects: [prepared], deliveries }))
      .toMatchObject({ ok: false, code: 'invalid_input' })
    expect(store.getWork(input.ref)).toBeUndefined()

    const acceptedDeliveries = deliveries.slice(0, 63)
    const accepted = committed(store.applyCommand(input.command, input.context, {
      effects: [prepared], deliveries: acceptedDeliveries,
    }))
    expect(accepted.sequence).toBe(1)
    expect(store.getEffect(input.ref, prepared.operationId)).toEqual(prepared)
    const last = delivery('delivery-count-62')
    expect(store.getDelivery(input.ref, last.id)).toEqual(last)
  })

  it('rejects stale attempt results and prepared intents after the task generation is retired', () => {
    const { store } = openFixture()
    const input = intake('stale')
    const queued = committed(store.applyCommand(input.command, input.context)).state
    const running = committed(store.applyEvent(input.ref, {
      type: 'start', executor: 'native-dsh', ...fence(queued),
    })).state
    const stale = effect(input, 'stale-effect', running.attempt.generation + 1)
    const ready = { type: 'ready', ...fence(running), artifactIds: [] }
    expect(store.applyEvent(input.ref, ready, { effects: [stale] }))
      .toMatchObject({ ok: false, code: 'stale_attempt' })
    expect(store.getWork(input.ref)).toEqual(running)
    expect(store.getEffect(input.ref, stale.operationId)).toBeUndefined()

    const cancelling = committed(store.applyCommand({
      type: 'work.cancel', commandId: 'cancel-stale', taskId: input.ref.taskId,
      expectedVersion: running.task.version, payload: {},
    }, input.context)).state
    expect(store.applyEvent(input.ref, ready)).toMatchObject({ ok: false, code: 'version_conflict' })
    expect(store.applyEvent(input.ref, { ...ready, expectedVersion: cancelling.task.version }))
      .toMatchObject({ ok: false, code: 'stale_attempt' })
    expect(store.getWork(input.ref)).toEqual(cancelling)
  })

  it('retains old attempts and replays accepted commands after closing and reopening SQLite', () => {
    const fixture = openFixture()
    const { store } = fixture
    const input = intake('restart')
    const queued = committed(store.applyCommand(input.command, input.context)).state
    const running = committed(store.applyEvent(input.ref, {
      type: 'start', executor: 'native-dsh', ...fence(queued),
    })).state
    const failed = committed(store.applyEvent(input.ref, {
      type: 'fail', ...fence(running), runtimeQuiescent: true, uncertainEffects: false,
      reason: 'Fixture terminal failure.',
    })).state
    const retry = {
      type: 'work.retry', commandId: 'retry-restart', taskId: input.ref.taskId,
      expectedVersion: failed.task.version, payload: {},
    }
    const accepted = committed(store.applyCommand(retry, {
      ...input.context, newAttempt: allocation('restart-retry'),
    }))
    expect(accepted.previousAttempt).toEqual(failed.attempt)

    const reopened = fixture.reopen()
    expect(reopened.getWork(input.ref)).toEqual(accepted.state)
    expect(reopened.getAttempt(input.ref, failed.attempt.id)).toEqual(failed.attempt)
    expect(reopened.getAttempt(input.ref, accepted.state.attempt.id)).toEqual(accepted.state.attempt)
    expect(reopened.applyCommand(retry, {
      actor, at, projectId: project.id, conversationId: conversation.id,
    })).toEqual({ ...accepted, replayed: true })
    expect(reopened.getWork(input.ref)).toEqual(accepted.state)
  })

  it.each(['owner', 'profile'] as const)('quarantines a cached result copied from a different %s', scope => {
    const fixture = openFixture()
    const { store } = fixture
    const input = intake('cached')
    committed(store.applyCommand(input.command, input.context))

    const otherScope = scope === 'owner'
      ? { ownerId: ownerIdSchema.parse('owner-other'), profileId }
      : { ownerId, profileId: profileIdSchema.parse('profile-other') }
    const otherProject = projectSchema.parse({ ...project, ...otherScope, id: 'project-other' })
    const otherConversation = conversationSchema.parse({ ...conversation, ...otherScope, id: 'conversation-other' })
    store.insertProject(otherProject)
    store.insertConversation(otherConversation)
    const other = intake('other-scope', {
      actor: { ...actor, ...otherScope },
      project: otherProject,
      conversation: otherConversation,
    })
    committed(store.applyCommand(other.command, other.context))

    // The outer SQL keys remain valid. Only the shape-valid cached payload is misbound.
    const reopened = fixture.reopen(() => injectFixtureSql(fixture.directory, `
      UPDATE commands
      SET result = json_set(
        (SELECT result FROM commands WHERE command_id = 'create-other-scope'),
        '$.state.task.id', task_id, '$.state.attempt.taskId', task_id
      )
      WHERE command_id = 'create-cached';
    `))
    expect(() => reopened.applyCommand(input.command, input.context))
      .toThrow(expect.objectContaining({ code: 'corrupt' }))
    expect(() => openWorkStore(fixture.directory)).toThrow(expect.objectContaining({ code: 'corrupt' }))
  })

  it('quarantines a historical attempt with a mismatched mandate scope', () => {
    const fixture = openFixture()
    const { store } = fixture
    const input = intake('history-scope')
    const queued = committed(store.applyCommand(input.command, input.context)).state
    const cancelled = committed(store.applyCommand({
      type: 'work.cancel', commandId: 'cancel-history-scope', taskId: input.ref.taskId,
      expectedVersion: queued.task.version, payload: {},
    }, input.context)).state
    const reopenedTask = committed(store.applyCommand({
      type: 'work.reopen', commandId: 'reopen-history-scope', taskId: input.ref.taskId,
      expectedVersion: cancelled.task.version, payload: {},
    }, { ...input.context, newAttempt: allocation('history-new') })).state

    const reopened = fixture.reopen(() => injectFixtureSql(fixture.directory, `
      UPDATE attempts SET record = json_set(record, '$.mandate.profileId', 'profile-other')
      WHERE id = 'attempt-history-scope';
    `))
    expect(reopened.getWork(input.ref)).toEqual(reopenedTask)
    expect(() => reopened.getAttempt(input.ref, cancelled.attempt.id))
      .toThrow(expect.objectContaining({ code: 'corrupt' }))
  })
})
