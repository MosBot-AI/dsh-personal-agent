import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, ownerIdSchema, profileIdSchema, projectSchema,
  sourceEventSchema, taskIdSchema, utcInstantSchema, type UtcInstant,
} from '../../packages/personal-agent/src/domain/model.js'
import { ROUTINE_SOURCE, routineIdSchema, type RoutineIntent, type RoutineMapping, type RoutineRef } from '../../packages/personal-agent/src/domain/routines.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const createdAt = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const first = utcInstantSchema.parse('2026-11-07T08:01:00.000Z')
const firstDelivered = utcInstantSchema.parse('2026-11-07T08:01:00.010Z')
const second = utcInstantSchema.parse('2026-11-07T08:02:00.000Z')
const third = utcInstantSchema.parse('2026-11-07T08:03:00.000Z')
const scope = { ownerId: ownerIdSchema.parse('routine-owner'), profileId: profileIdSchema.parse('routine-profile') }
const authority = {
  clientId: clientIdSchema.parse('routine-client'), deviceId: deviceIdSchema.parse('routine-device'),
  verifiedAt: createdAt, policyVersion: 'routine-policy',
}
const actor = { role: 'owner' as const, ...scope, ...authority }
const admission = { grantsCurrent: true, budgetAvailable: true, conditionSatisfied: true }
const reminder = {
  title: 'Fixture reminder', timing: { kind: 'at', at: first }, timeZone: 'UTC',
  localTimeIntent: '08:01 UTC', dst: { gap: 'skip', overlap: 'earlier' }, misfire: 'latest',
  target: { kind: 'reminder', text: 'Inspect the durable reminder.' },
} satisfies RoutineIntent

function success<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`Expected Routine fixture acceptance: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-routine-store-'))
  let store: WorkStore | undefined
  onTestFinished(() => {
    try { store?.close() } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  store = openWorkStore(directory)
  return {
    get store() {
      if (!store) throw new Error('Missing fixture store')
      return store
    },
    reopen(sql?: string) {
      store?.close()
      store = undefined
      if (sql !== undefined) {
        const db = new DatabaseSync(join(directory, DATABASE_FILENAME))
        try { db.exec(sql) } finally { db.close() }
      }
      store = openWorkStore(directory)
      return store
    },
  }
}

function draft(store: WorkStore, id: string, intent: RoutineIntent = reminder) {
  const routineId = routineIdSchema.parse(id)
  const routine = success(store.createRoutine(scope, { ...intent, id: routineId }, createdAt)).routine
  return { routine, ref: { ...scope, routineId } }
}

function arm(store: WorkStore, ref: RoutineRef, revision = 1, nextIntendedAt: UtcInstant = first) {
  return success(store.updateRoutine(ref, { type: 'arm', expectedRevision: revision, at: createdAt, nextIntendedAt, authority })).routine
}

function reserve(store: WorkStore, ref: RoutineRef, expectedRevision: number, intendedAt: UtcInstant = first,
  nativeWakeAt: UtcInstant = intendedAt, at: UtcInstant = createdAt) {
  return success(store.reserveRoutineMapping(ref, { expectedRevision, intendedAt, nativeWakeAt, at, mailboxId: 'routine-mailbox' })).mapping
}

function bind(store: WorkStore, ref: RoutineRef, mapping: RoutineMapping, nativeId: string) {
  return success(store.updateRoutineMapping(ref, {
    mappingId: mapping.id, expectedVersion: mapping.version, state: 'bound', nativeId,
  })).mapping
}

function receipt(mapping: RoutineMapping, messageId = 'fixture-message', deliveredAt: UtcInstant = firstDelivered) {
  return {
    nativeId: mapping.nativeId, messageId, scheduledAt: mapping.nativeWakeAt, deliveredAt,
    targetSessionId: mapping.mailboxId, prompt: mapping.marker,
  }
}

function goalTask(store: WorkStore) {
  const project = projectSchema.parse({
    ...scope, id: 'routine-project', kind: 'project', title: 'Goal project', purpose: 'Wait for the exact Routine.',
    resourceRefs: [], status: 'active', successCriteria: ['Use the exact schedule.'], planRevision: 1, milestones: [],
  })
  store.insertProject(project)
  const taskId = taskIdSchema.parse('routine-goal-task')
  const attemptId = attemptIdSchema.parse('routine-goal-attempt')
  const ref = { ...scope, taskId }
  const { state: queued } = success(store.applyCommand({
    type: 'work.create', commandId: 'create-goal',
    payload: {
      projectId: project.id, requestedOutcome: 'Continue on the scheduled wake.', constraints: [],
      acceptance: { criteria: ['Continue safely.'], requiresArtifact: false, requiresReceipt: false },
    },
  }, {
    actor, at: createdAt, projectId: project.id, newTaskId: taskId,
    newAttempt: { id: attemptId, mandate: mandateRefSchema.parse({ ...scope, id: 'goal-mandate', policyVersion: authority.policyVersion }) },
  }))
  const { state: running } = success(store.applyEvent(ref, {
    type: 'start', at: createdAt, expectedVersion: queued.task.version, attemptId, generation: queued.attempt.generation, executor: 'fixture',
  }))
  const waitReference = 'routine-due'
  const { state } = success(store.applyEvent(ref, {
    type: 'wait', at: createdAt, expectedVersion: running.task.version, attemptId, generation: running.attempt.generation,
    wait: { reason: 'event', referenceId: waitReference, resumeCondition: 'Receive a verified Routine occurrence.' },
  }))
  const target = {
    kind: 'goal', taskId, projectId: project.id, attemptId, generation: state.attempt.generation,
    expectedVersion: state.task.version, waitReference,
  } as const
  return { ref, state, target }
}

describe('durable Routine store', () => {
  it('requires explicit arming and deduplicates native receipt and manual commands independently', () => {
    const { store } = fixture()
    const { ref, routine } = draft(store, 'reminder')
    expect(routine.status).toBe('draft')
    expect(store.listArmedRoutines()).toEqual([])
    expect(store.reserveRoutineMapping(ref, {
      expectedRevision: 1, intendedAt: first, nativeWakeAt: first, at: createdAt, mailboxId: 'mailbox',
    })).toEqual({ ok: false, code: 'invalid_transition' })
    const armed = arm(store, ref)
    expect(armed).toMatchObject({ revision: 2, status: 'armed', authority, nextIntendedAt: first })
    expect(store.updateRoutine(ref, { type: 'pause', expectedRevision: 1, at: createdAt }))
      .toEqual({ ok: false, code: 'version_conflict' })
    expect(store.getRoutine({ ...ref, profileId: profileIdSchema.parse('another-profile') })).toBeUndefined()
    const intended = reserve(store, ref, armed.revision)
    const uncertain = success(store.updateRoutineMapping(ref, {
      mappingId: intended.id, expectedVersion: intended.version, state: 'uncertain',
    })).mapping
    const mapped = bind(store, ref, uncertain, 'native-reminder')
    expect(mapped).toMatchObject({ marker: intended.marker, state: 'bound', nativeId: 'native-reminder', version: 3 })
    const observed = { mappingId: mapped.id, receipt: receipt(mapped), intendedAt: first, at: firstDelivered, authority }
    expect(store.completeRoutineOccurrence(ref, {
      ...observed, receipt: { ...observed.receipt, prompt: 'wrong-marker' },
    })).toEqual({ ok: false, code: 'permission_denied' })
    const applied = success(store.completeRoutineOccurrence(ref, observed))
    expect(applied).toMatchObject({ duplicate: false, occurrence: { status: 'reminded', reminderText: reminder.target.text,
      title: reminder.title, routineRevision: armed.revision, intendedAt: first, kind: 'scheduled' } })
    expect(store.getRoutineRetirement(mapped.nativeId!)).toEqual(observed.receipt)
    expect(store.completeRoutineOccurrence(ref, { ...observed, receipt: { ...observed.receipt, messageId: 'native-replay' } }))
      .toEqual({ ok: true, occurrence: applied.occurrence, duplicate: true })
    expect(store.getRoutine(ref)).toMatchObject({ status: 'ended', revision: armed.revision })
    const manualInput = { expectedRevision: armed.revision, commandId: 'run-reminder', at: firstDelivered, authority }
    const manual = success(store.runRoutineNow(ref, manualInput))
    expect(manual.occurrence.kind).toBe('manual')
    expect(manual.occurrence.id).not.toBe(applied.occurrence.id)
    expect(store.runRoutineNow(ref, { ...manualInput, at: second })).toEqual({ ...manual, duplicate: true })
    expect(store.runRoutineNow(ref, { ...manualInput, expectedRevision: armed.revision + 1 }))
      .toEqual({ ok: false, code: 'command_conflict' })
    expect(store.listRoutineOccurrences(scope)).toHaveLength(2)
  })

  it('retains the old title and skips a late receipt after explicit edit and rearm', () => {
    const { store } = fixture()
    const { ref } = draft(store, 'renamed')
    const initial = arm(store, ref)
    const old = bind(store, ref, reserve(store, ref, initial.revision), 'native-old')
    const changed = success(store.updateRoutine(ref, {
      type: 'edit', expectedRevision: initial.revision, at: createdAt,
      intent: { ...reminder, title: 'Changed title', timing: { kind: 'at', at: second } },
    })).routine
    expect(changed.status).toBe('draft')
    const active = arm(store, ref, changed.revision, second)
    const current = reserve(store, ref, active.revision, second)
    expect(store.listRoutineMappings(scope)).toHaveLength(2)
    const late = success(store.completeRoutineOccurrence(ref, {
      mappingId: old.id, receipt: receipt(old), intendedAt: first, at: firstDelivered, authority,
    })).occurrence
    expect(late).toMatchObject({ status: 'skipped', reason: 'stale_revision', title: reminder.title, routineRevision: initial.revision })
    expect(store.getRoutine(ref)).toEqual(active)
    expect(store.listRoutineMappings(scope)).toEqual([current])
  })

  it('rolls back the occurrence, exact Task wake and internal SourceEvent together on SQLite write failure', () => {
    const setup = fixture()
    const task = goalTask(setup.store)
    const { ref } = draft(setup.store, 'goal', { ...reminder, target: task.target })
    const armed = arm(setup.store, ref)
    const mapped = bind(setup.store, ref, reserve(setup.store, ref, armed.revision), 'native-goal')
    const input = { mappingId: mapped.id, receipt: receipt(mapped), intendedAt: first, at: firstDelivered,
      authority, goalAdmission: admission }
    const faulted = setup.reopen(`
      CREATE TRIGGER routine_commit_failure BEFORE INSERT ON routine_occurrences
      BEGIN SELECT RAISE(ABORT, 'fixture occurrence failure'); END;
    `)
    expect(() => faulted.completeRoutineOccurrence(ref, input)).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(faulted.getWork(task.ref)).toEqual(task.state)
    expect(faulted.getWakeSource(task.ref, task.state.task.version + 1)).toBeUndefined()
    expect(faulted.listRoutineMappings()).toEqual([mapped])
    expect(faulted.listRoutineOccurrences(scope)).toEqual([])

    const reopened = setup.reopen('DROP TRIGGER routine_commit_failure')
    const accepted = success(reopened.completeRoutineOccurrence(ref, input)).occurrence
    const queued = reopened.getWork(task.ref)
    expect(accepted).toMatchObject({ status: 'queued', taskId: task.ref.taskId, taskVersion: task.state.task.version + 1 })
    expect(queued?.task).toMatchObject({ status: 'queued', generation: task.state.task.generation })
    expect(queued?.attempt.id).toBe(task.state.attempt.id)
    const event = reopened.getWakeSource(task.ref, accepted.taskVersion!)
    expect(event).toMatchObject({ id: accepted.sourceEventId, sourceInstanceId: ROUTINE_SOURCE,
      actor: { kind: 'service', externalActorId: ref.routineId }, body: { kind: 'routine_wake', occurrenceId: accepted.id } })
    expect(reopened.completeRoutineOccurrence(ref, { ...input, receipt: receipt(mapped, 'duplicated-message') }))
      .toEqual({ ok: true, occurrence: accepted, duplicate: true })
    expect(reopened.getWork(task.ref)).toEqual(queued)
    expect(reopened.recordRoutingEvent(sourceEventSchema.parse(event), '1'.repeat(64), {
      projectId: task.target.projectId, authority,
    })).toEqual({ ok: false, code: 'invalid_input' })
  })

  it('records budget refusal without waking or occupying a Worker', () => {
    const { store } = fixture()
    const task = goalTask(store)
    const { ref } = draft(store, 'budget', { ...reminder, target: task.target })
    const active = arm(store, ref)
    const mapped = bind(store, ref, reserve(store, ref, active.revision), 'native-budget')
    const accepted = success(store.completeRoutineOccurrence(ref, {
      mappingId: mapped.id, receipt: receipt(mapped), intendedAt: first, at: firstDelivered, authority,
      goalAdmission: { ...admission, budgetAvailable: false },
    }))
    expect(accepted.occurrence).toMatchObject({ status: 'skipped', reason: 'budget_unavailable' })
    expect(store.getWork(task.ref)).toEqual(task.state)
    expect(store.workerInputs(task.ref, task.state.attempt.id)).toEqual([])
  })

  it('retimes only the unbound native wake and records superseded logical instants without claiming delivery', () => {
    const { store } = fixture()
    const { ref } = draft(store, 'misfire', { ...reminder, timing: { kind: 'cron', expression: '* * * * *' } })
    const active = arm(store, ref)
    const pending = reserve(store, ref, active.revision)
    const retimed = success(store.retimeRoutineMapping(ref, {
      mappingId: pending.id, expectedVersion: pending.version, nativeWakeAt: second,
    })).mapping
    expect(retimed).toMatchObject({ marker: pending.marker, intendedAt: first, nativeWakeAt: second, version: 2 })
    expect(store.skipRoutineMisfire(ref, { expectedRevision: active.revision, expectedIntendedAt: first, nextIntendedAt: second, at: third }))
      .toEqual({ ok: false, code: 'conflict' })
    const skipped = success(store.skipRoutineMisfire(ref, {
      expectedRevision: active.revision, expectedIntendedAt: first, nextIntendedAt: second, at: third,
      mappingId: retimed.id, expectedMappingVersion: retimed.version,
    }))
    expect(skipped.occurrence).toMatchObject({ intendedAt: first, status: 'skipped', reason: 'misfire' })
    expect(skipped.occurrence.nativeReceipt).toBeUndefined()
    expect(store.listRoutineMappings()).toEqual([])
    expect(store.getRoutine(ref)?.nextIntendedAt).toBe(second)
  })
})
