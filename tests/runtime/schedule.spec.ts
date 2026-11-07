import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, ownerIdSchema, profileIdSchema,
  projectSchema, taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { routineAuthoritySchema, routineIdSchema, type GoalAdmission, type RoutineIntent, type RoutineRef } from '../../packages/personal-agent/src/domain/routines.js'
import { createWorkerExecutor } from '../../packages/personal-agent/src/runtime/executor.js'
import { NativeWakeElapsed, type NativeScheduleEntry, type NativeSchedulePort, type NativeScheduleReceipt } from '../../packages/personal-agent/src/runtime/native-schedule.js'
import type { NativeWorkerRuntime } from '../../packages/personal-agent/src/runtime/native-worker.js'
import { createScheduleAdapter } from '../../packages/personal-agent/src/runtime/schedule-adapter.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const initial = '2026-11-07T08:00:00.000Z'
const initialWake = '2026-11-07T08:01:00.000Z'
const scope = { ownerId: ownerIdSchema.parse('schedule-owner'), profileId: profileIdSchema.parse('schedule-profile') }
const authority = routineAuthoritySchema.parse({ clientId: 'schedule-client', deviceId: 'schedule-device',
  verifiedAt: '2026-01-01T00:00:00.000Z', policyVersion: 'schedule-policy' })
const actor = { ...scope, role: 'owner', clientId: clientIdSchema.parse(authority.clientId),
  deviceId: deviceIdSchema.parse(authority.deviceId), policyVersion: authority.policyVersion } as const
const targetSessionId = 'private-schedule-fixture'
const dst = { gap: 'skip', overlap: 'earlier' } as const

function instant(value: string) { return utcInstantSchema.parse(value) }

function succeed<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`Routine fixture failed: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

function fixture(options: { start?: string; goalAdmission?: (taskId: string) => GoalAdmission } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-routine-'))
  let store: WorkStore | undefined
  let adapter: ReturnType<typeof createScheduleAdapter> | undefined
  let clock = instant(options.start ?? initial)
  let enrolled = true
  let retirementEnabled = true
  let createMode: 'normal' | 'lost' | 'duplicate' | 'elapsed' = 'normal'
  let onCatalog: (() => void) | undefined
  let nativeSequence = 0
  const entries = new Map<string, NativeScheduleEntry>()
  const receipts = new Map<string, readonly NativeScheduleReceipt[]>()
  const creates: { marker: string; wakeAt: string }[] = []
  const retirements: string[] = []
  const cancellations: string[] = []
  const listeners = new Set<() => void>()
  const event = () => { for (const listener of listeners) listener() }

  function port(): NativeSchedulePort {
    return {
      targetSessionId,
      async catalog() {
        const snapshot = [...entries.values()]
        onCatalog?.()
        return snapshot
      },
      async create(request) {
        creates.push(request)
        expect(store?.listRoutineMappings()).toContainEqual(expect.objectContaining({
          marker: request.marker, nativeWakeAt: request.wakeAt, state: 'intent',
        }))
        if (createMode === 'elapsed') {
          createMode = 'normal'
          clock = instant(new Date(Date.parse(request.wakeAt) + 1).toISOString())
          throw new NativeWakeElapsed('Fixture sink opened after the proposed wake')
        }
        const entry: NativeScheduleEntry = { id: `native-${++nativeSequence}`, ...request, status: 'active', targetSessionId }
        entries.set(entry.id, entry)
        if (createMode === 'duplicate') {
          const duplicate = { ...entry, id: `native-${++nativeSequence}` }
          entries.set(duplicate.id, duplicate)
        }
        if (createMode !== 'normal') throw new Error('Fixture lost native acknowledgement')
        return entry
      },
      async history(id) { return receipts.get(id) ?? [] },
      async cancel(entry) {
        if (entries.get(entry.id) !== entry || entry.status === 'ended' || entry.invalid) return false
        entries.delete(entry.id)
        cancellations.push(entry.id)
        return true
      },
      async retire(receipt) {
        const entry = entries.get(receipt.nativeId)
        expect(entry?.status).toBe('ended')
        expect(receipts.get(receipt.nativeId)).toContainEqual(receipt)
        expect(store?.getRoutineRetirement(receipt.nativeId)).toMatchObject({ messageId: receipt.messageId })
        if (!retirementEnabled) return false
        entries.delete(receipt.nativeId)
        receipts.delete(receipt.nativeId)
        retirements.push(receipt.nativeId)
        return true
      },
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      async dispose() {},
    }
  }

  function open() {
    const current = openWorkStore(directory)
    store = current
    adapter = createScheduleAdapter({ store: current, native: port(), now: () => clock,
      currentAuthority: owner => enrolled && owner.ownerId === scope.ownerId && owner.profileId === scope.profileId ? authority : undefined,
      authorizeGoalWake: (_routine, state) => options.goalAdmission?.(state.task.id),
    })
    return { store: current, adapter }
  }

  const initialState = open()
  onTestFinished(async () => {
    try { await adapter?.close() } finally { store?.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  return {
    ...initialState,
    directory, entries, receipts, creates, retirements, cancellations, event,
    at(value: string) { clock = instant(value) },
    enroll(value: boolean) { enrolled = value },
    retire(value: boolean) { retirementEnabled = value },
    afterCatalog(action?: () => void) { onCatalog = action },
    failCreate(mode: typeof createMode) { createMode = mode },
    end(id: string, changes: Partial<NativeScheduleReceipt> = {}) {
      const entry = entries.get(id)
      if (!entry) throw new Error('Fixture native entry is absent')
      entries.set(id, { ...entry, status: 'ended' })
      const receipt: NativeScheduleReceipt = { nativeId: id, marker: entry.marker, prompt: entry.marker, wakeAt: entry.wakeAt,
        deliveredAt: clock, targetSessionId: entry.targetSessionId, messageId: `receipt-${id}`, ...changes }
      receipts.set(id, [receipt])
      return receipt
    },
    async reopen() { await adapter?.close(); store?.close(); return open() },
  }
}

function reminder(overrides: Partial<RoutineIntent> = {}): RoutineIntent {
  return { title: 'Fixture reminder', timing: { kind: 'at', at: instant(initialWake) }, timeZone: 'UTC',
    localTimeIntent: '08:01 UTC', dst, misfire: 'latest', target: { kind: 'reminder', text: 'Inspect the fixture result.' }, ...overrides }
}

function draft(f: ReturnType<typeof fixture>, label: string, intent = reminder()) {
  const routineId = routineIdSchema.parse(label)
  const ref = { ...scope, routineId }
  const routine = succeed(f.adapter.create(scope, { id: routineId, ...intent })).routine
  expect(routine.status).toBe('draft')
  return { ref, routine }
}

function arm(f: ReturnType<typeof fixture>, value: ReturnType<typeof draft>) {
  return succeed(f.adapter.update(value.ref, { type: 'arm', expectedRevision: value.routine.revision }, authority)).routine
}

function occurrences(store: WorkStore, ref: RoutineRef) {
  return store.listRoutineOccurrences({ ownerId: ref.ownerId, profileId: ref.profileId })
    .filter(row => row.routineId === ref.routineId)
}

describe('durable routine orchestration', () => {
  it('keeps drafts inert, gives Run Now its own key, and admits an exact ended native receipt once', async () => {
    const f = fixture()
    const work = draft(f, 'manual-and-native')
    await f.adapter.reconcile()
    expect(f.creates).toHaveLength(0)
    expect(f.adapter.runNow(work.ref, { expectedRevision: work.routine.revision, commandId: 'draft-run' }, authority))
      .toMatchObject({ ok: false, code: 'invalid_transition' })
    const armed = arm(f, work)
    const run = { expectedRevision: armed.revision, commandId: 'manual-1' }
    const manual = succeed(f.adapter.runNow(work.ref, run, authority)).occurrence
    expect(manual).toMatchObject({ kind: 'manual', status: 'reminded', reminderText: 'Inspect the fixture result.' })
    expect(manual.nativeReceipt).toBeUndefined()
    expect(succeed(f.adapter.runNow(work.ref, run, authority))).toMatchObject({ duplicate: true, occurrence: { id: manual.id } })
    expect(succeed(f.adapter.runNow(work.ref, { ...run, commandId: 'manual-2' }, authority)).occurrence.id).not.toBe(manual.id)
    expect(f.store.getRoutine(work.ref)?.status).toBe('armed')
    expect(f.creates).toHaveLength(0)

    await f.adapter.reconcile()
    expect(f.creates).toHaveLength(1)
    const [mapping] = f.store.listRoutineMappings()
    expect(mapping).toMatchObject({ state: 'bound', intendedAt: initialWake, nativeWakeAt: initialWake, routineRevision: armed.revision })
    expect(mapping?.nativeId).toBeDefined()
    f.at(initialWake)
    const nativeId = mapping!.nativeId!
    const real = f.end(nativeId, { targetSessionId: 'unrelated-session' })
    const refused = await f.adapter.reconcile()
    expect(refused.problems).toContainEqual({ mappingId: mapping!.id, code: 'native_receipt_mismatch' })
    expect(occurrences(f.store, work.ref).filter(row => row.kind === 'scheduled')).toHaveLength(0)
    f.receipts.set(nativeId, [{ ...real, targetSessionId }])
    await f.adapter.reconcile()
    await f.adapter.reconcile()
    const scheduled = occurrences(f.store, work.ref).filter(row => row.kind === 'scheduled')
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]).toMatchObject({ status: 'reminded', intendedAt: initialWake,
      nativeReceipt: { nativeId, messageId: real.messageId, targetSessionId } })
    expect(f.creates).toHaveLength(1)
    expect(f.retirements).toEqual([nativeId])
    expect(f.store.getRoutine(work.ref)?.status).toBe('ended')
  })

  it('coalesces overdue Cron to the latest logical occurrence or skips it without backlog', async () => {
    const f = fixture()
    const cron = { kind: 'cron', expression: '* * * * *' } as const
    const latest = draft(f, 'latest', reminder({ timing: cron, misfire: 'latest' }))
    const skip = draft(f, 'skip', reminder({ timing: cron, misfire: 'skip' }))
    expect(arm(f, latest).nextIntendedAt).toBe(initialWake)
    expect(arm(f, skip).nextIntendedAt).toBe(initialWake)
    f.at('2026-11-07T08:04:30.000Z')
    await f.adapter.reconcile()
    expect(f.creates).toHaveLength(2)
    const mappings = f.store.listRoutineMappings()
    expect(mappings.find(mapping => mapping.routineId === latest.ref.routineId)).toMatchObject({
      intendedAt: '2026-11-07T08:04:00.000Z', nativeWakeAt: '2026-11-07T08:04:31.000Z',
    })
    expect(mappings.find(mapping => mapping.routineId === skip.ref.routineId)).toMatchObject({
      intendedAt: '2026-11-07T08:05:00.000Z', nativeWakeAt: '2026-11-07T08:05:00.000Z',
    })
    expect(occurrences(f.store, skip.ref)).toContainEqual(expect.objectContaining({ status: 'skipped', reason: 'misfire' }))
    const late = mappings.find(mapping => mapping.routineId === latest.ref.routineId)!
    f.at('2026-11-07T08:04:31.000Z')
    f.end(late.nativeId!)
    await f.adapter.reconcile()
    expect(occurrences(f.store, latest.ref)).toContainEqual(expect.objectContaining({
      status: 'reminded', intendedAt: '2026-11-07T08:04:00.000Z',
      nativeReceipt: expect.objectContaining({ scheduledAt: '2026-11-07T08:04:31.000Z' }),
    }))
    expect(f.creates).toHaveLength(3)
  })

  it('settles an old ended wake and gives the latest logical Cron slot a fresh exact receipt', async () => {
    const f = fixture()
    const work = draft(f, 'late-bound', reminder({ timing: { kind: 'cron', expression: '* * * * *' } }))
    arm(f, work)
    await f.adapter.reconcile()
    const [old] = f.store.listRoutineMappings()
    f.at(initialWake)
    const oldReceipt = f.end(old!.nativeId!)
    f.at('2026-11-07T08:04:30.000Z')
    await f.adapter.reconcile()
    expect(occurrences(f.store, work.ref)).toEqual([expect.objectContaining({ status: 'skipped', reason: 'misfire',
      intendedAt: initialWake, nativeReceipt: expect.objectContaining({ messageId: oldReceipt.messageId }) })])
    const [latest] = f.store.listRoutineMappings()
    expect(latest).toMatchObject({ intendedAt: '2026-11-07T08:04:00.000Z', nativeWakeAt: '2026-11-07T08:04:31.000Z' })
    f.at(latest!.nativeWakeAt)
    const latestReceipt = f.end(latest!.nativeId!)
    await f.adapter.reconcile()
    expect(occurrences(f.store, work.ref)).toContainEqual(expect.objectContaining({ status: 'reminded',
      intendedAt: latest!.intendedAt, nativeReceipt: expect.objectContaining({ messageId: latestReceipt.messageId }) }))
  })

  it('coalesces duplicate native notices and schedules a fresh scan when the final pass goes dirty', async () => {
    const f = fixture()
    const work = draft(f, 'duplicate-notices')
    arm(f, work)
    await f.adapter.reconcile()
    const [mapping] = f.store.listRoutineMappings()
    f.at(initialWake)
    let catalogs = 0
    f.afterCatalog(() => {
      if (++catalogs === 2) {
        f.end(mapping!.nativeId!)
        f.afterCatalog()
      }
      for (let n = 0; n < 100; n++) f.event()
    })
    expect((await f.adapter.reconcile()).completed).toBe(0)
    await vi.waitFor(() => expect(occurrences(f.store, work.ref)).toHaveLength(1))
    expect(occurrences(f.store, work.ref)[0]).toMatchObject({ status: 'reminded', kind: 'scheduled' })
    expect(f.creates).toHaveLength(1)
  })

  it('honors enrollment changes before manual run and before applying an exact native receipt', async () => {
    const f = fixture()
    const work = draft(f, 'revoked-before-wake')
    const armed = arm(f, work)
    await f.adapter.reconcile()
    const [mapping] = f.store.listRoutineMappings()
    f.enroll(false)
    expect(f.adapter.runNow(work.ref, { expectedRevision: armed.revision, commandId: 'revoked' }, authority))
      .toMatchObject({ ok: false, code: 'permission_denied' })
    f.at(initialWake)
    const receipt = f.end(mapping!.nativeId!)
    await f.adapter.reconcile()
    expect(occurrences(f.store, work.ref)).toEqual([expect.objectContaining({ status: 'skipped', reason: 'authority_changed',
      nativeReceipt: expect.objectContaining({ messageId: receipt.messageId }) })])
  })

  it.each([
    ['gap', '2026-03-08T05:00:00.000Z', '30 2 * * *', '2026-03-09T06:30:00.000Z'],
    ['overlap', '2026-11-01T04:00:00.000Z', '30 1 * * *', '2026-11-01T05:30:00.000Z'],
  ] as const)('uses pinned Cron %s behavior and keeps the original local intent', async (kind, start, expression, expected) => {
    const f = fixture({ start })
    const localTimeIntent = `New York ${kind} fixture`
    const work = draft(f, kind, reminder({ timing: { kind: 'cron', expression }, timeZone: 'America/New_York', localTimeIntent }))
    expect(arm(f, work)).toMatchObject({ nextIntendedAt: expected, localTimeIntent, dst, timeZone: 'America/New_York' })
    await f.adapter.reconcile()
    expect(f.creates).toEqual([expect.objectContaining({ wakeAt: expected })])
  })

  it('adopts a lost native acknowledgement, and fails closed on ambiguous and missing bindings', async () => {
    const f = fixture()
    const work = draft(f, 'lost')
    f.failCreate('lost')
    arm(f, work)
    expect((await f.adapter.reconcile()).problems).toContainEqual(expect.objectContaining({ code: 'native_create_unknown' }))
    expect(f.store.listRoutineMappings()[0]?.state).toBe('uncertain')
    expect(f.creates).toHaveLength(1)
    const reopened = await f.reopen()
    expect((await reopened.adapter.reconcile()).adopted).toBe(1)
    const [adopted] = reopened.store.listRoutineMappings()
    expect(adopted).toMatchObject({ state: 'bound', nativeId: 'native-1' })
    f.entries.delete('native-1')
    expect((await reopened.adapter.reconcile()).problems).toContainEqual(expect.objectContaining({ code: 'missing_native' }))
    expect(reopened.store.listRoutineMappings()[0]?.state).toBe('uncertain')
    expect(f.creates).toHaveLength(1)

    const active = { ...f, ...reopened }
    const ambiguous = draft(active, 'ambiguous')
    f.failCreate('duplicate')
    arm(active, ambiguous)
    await active.adapter.reconcile()
    expect((await active.adapter.reconcile()).problems).toContainEqual(expect.objectContaining({ code: 'ambiguous_native' }))
    expect(f.creates).toHaveLength(2)
    expect(occurrences(active.store, ambiguous.ref)).toEqual([])
  })

  it('records an old native wake without blocking a new revision or reopening the old one', async () => {
    const f = fixture()
    const work = draft(f, 'paused')
    const armed = arm(f, work)
    await f.adapter.reconcile()
    const [mapping] = f.store.listRoutineMappings()
    const paused = succeed(f.adapter.update(work.ref, { type: 'pause', expectedRevision: armed.revision })).routine
    expect(paused.status).toBe('paused')
    const edited = succeed(f.adapter.update(work.ref, { type: 'edit', expectedRevision: paused.revision,
      intent: reminder({ timing: { kind: 'at', at: instant('2026-11-07T08:02:00.000Z') } }) })).routine
    const next = arm(f, { ref: work.ref, routine: edited })
    f.at(initialWake)
    f.end(mapping!.nativeId!)
    await f.adapter.reconcile()
    expect(occurrences(f.store, work.ref)).toEqual([expect.objectContaining({
      routineRevision: armed.revision, status: 'skipped', reason: 'stale_revision',
      nativeReceipt: expect.objectContaining({ nativeId: mapping!.nativeId }),
    })])
    expect(f.store.getRoutine(work.ref)).toMatchObject({ status: 'armed', revision: next.revision })
    expect(f.creates).toHaveLength(2)
    expect(f.retirements).toEqual([mapping!.nativeId!])
  })

  it('cancels exact obsolete timers and retains changed native rows without blocking rearm', async () => {
    const f = fixture()
    const work = draft(f, 'obsolete-active')
    const armed = arm(f, work)
    await f.adapter.reconcile()
    const [first] = f.store.listRoutineMappings()
    const paused = succeed(f.adapter.update(work.ref, { type: 'pause', expectedRevision: armed.revision })).routine
    await f.adapter.reconcile()
    expect(f.cancellations).toEqual([first!.nativeId])
    expect(f.store.listRoutineMappings()).toEqual([])

    const secondArm = arm(f, { ref: work.ref, routine: paused })
    await f.adapter.reconcile()
    const [second] = f.store.listRoutineMappings()
    const changed = { ...f.entries.get(second!.nativeId!)!, targetSessionId: 'foreign-target', invalid: true as const }
    f.entries.set(changed.id, changed)
    const secondPause = succeed(f.adapter.update(work.ref, { type: 'pause', expectedRevision: secondArm.revision })).routine
    const thirdArm = arm(f, { ref: work.ref, routine: secondPause })
    expect((await f.adapter.reconcile()).problems).toContainEqual({ mappingId: second!.id, code: 'changed_native' })
    expect(f.entries.get(changed.id)).toBe(changed)
    expect(f.cancellations).toEqual([first!.nativeId])
    expect(f.store.listRoutineMappings()).toEqual([expect.objectContaining({ routineRevision: thirdArm.revision, state: 'bound' })])
  })

  it('keeps near-boundary logical time exact and resumes exact retirement after a reopen', async () => {
    const f = fixture()
    const intendedAt = '2026-11-07T08:00:00.500Z'
    const nativeWakeAt = '2026-11-07T08:00:01.000Z'
    const work = draft(f, 'lead', reminder({ timing: { kind: 'at', at: instant(intendedAt) } }))
    arm(f, work)
    await f.adapter.reconcile()
    const [mapping] = f.store.listRoutineMappings()
    expect(mapping).toMatchObject({ intendedAt, nativeWakeAt, state: 'bound' })
    f.at(nativeWakeAt)
    const receipt = f.end(mapping!.nativeId!)
    f.retire(false)
    await f.adapter.reconcile()
    expect(f.entries.has(receipt.nativeId)).toBe(true)
    expect(occurrences(f.store, work.ref)).toEqual([expect.objectContaining({ status: 'reminded', intendedAt,
      nativeReceipt: expect.objectContaining({ messageId: receipt.messageId, scheduledAt: nativeWakeAt }) })])
    const reopened = await f.reopen()
    f.retire(true)
    expect((await reopened.adapter.reconcile()).retired).toBe(1)
    expect(f.entries.has(receipt.nativeId)).toBe(false)
    expect(reopened.store.getRoutineRetirement(receipt.nativeId)?.messageId).toBe(receipt.messageId)
    expect(occurrences(reopened.store, work.ref)).toHaveLength(1)
  })

  it('retimes a known-unsent wake after cold sink startup consumed the lead', async () => {
    const f = fixture()
    const intendedAt = '2026-11-07T08:00:00.500Z'
    const work = draft(f, 'cold-sink', reminder({ timing: { kind: 'at', at: instant(intendedAt) } }))
    f.failCreate('elapsed')
    arm(f, work)
    const scan = await f.adapter.reconcile()
    expect(scan).toMatchObject({ created: 1, problems: [] })
    expect(f.creates).toEqual([
      { marker: f.creates[0]!.marker, wakeAt: '2026-11-07T08:00:01.000Z' },
      { marker: f.creates[0]!.marker, wakeAt: '2026-11-07T08:00:02.001Z' },
    ])
    expect(f.store.listRoutineMappings()).toEqual([expect.objectContaining({ intendedAt, state: 'bound', nativeId: 'native-1',
      nativeWakeAt: '2026-11-07T08:00:02.001Z' })])
    expect(f.entries.size).toBe(1)
  })

  it('wakes only an exact released goal, reserves no Worker, and keeps an over-budget goal waiting', async () => {
    const f = fixture({ goalAdmission: taskId => ({ grantsCurrent: true, budgetAvailable: taskId === 'ready-goal', conditionSatisfied: true }) })
    const projectId = 'goal-project'
    const cwd = realpathSync(join(f.directory))
    mkdirSync(join(cwd, 'work'), { mode: 0o700 })
    f.store.insertProject(projectSchema.parse({ ...scope, id: projectId, kind: 'goal', title: 'Goal fixture',
      purpose: 'Queue exact goal continuation.', resourceRefs: [], status: 'active', successCriteria: ['Inspect evidence.'],
      planRevision: 1, milestones: [] }))
    const waitReference = 'scheduled-owner-goal'
    let opens = 0
    const runtime: NativeWorkerRuntime = { async open() {
      opens++
      let report: string | undefined
      return {
        async followup(input) {
          expect(input.acknowledge()).toBe(true)
          report = JSON.stringify({ kind: 'waiting', cursor: input.cursor, summary: 'Fixture parked.',
            wait: { reason: 'event', referenceId: waitReference, resumeCondition: 'Await the exact occurrence.' } })
        },
        async steer() { throw new Error('Fixture does not steer') }, async flush() {}, async whenIdle() {},
        readReport: () => report, async stop() { return true },
      }
    } }
    const executor = createWorkerExecutor({ store: f.store, runtime, now: () => instant(initial),
      presets: [{ id: 'fixture', rootDirectory: cwd, provider: 'fixture', model: 'fixture', dataScope: [] }] })
    try {
      const armedGoals = []
      for (const name of ['ready-goal', 'budget-goal']) {
        const taskId = taskIdSchema.parse(name)
        const ref = { ...scope, taskId }
        const state = succeed(f.store.applyCommand({ type: 'work.create', commandId: `create-${name}`,
          payload: { projectId, requestedOutcome: 'Wait for the routine.', constraints: [],
            acceptance: { criteria: ['Inspect evidence.'], requiresArtifact: false, requiresReceipt: false } },
        }, { actor, at: instant(initial), projectId: projectSchema.shape.id.parse(projectId), newTaskId: taskId,
          newAttempt: { id: attemptIdSchema.parse(`attempt-${name}`), mandate: mandateRefSchema.parse({
            ...scope, id: `mandate-${name}`, policyVersion: actor.policyVersion,
          }) },
        })).state
        succeed(await executor.launch(ref, { expectedVersion: state.task.version, presetId: 'fixture', cwd: 'work', dataScope: [],
          input: { cursor: `start-${name}`, text: 'Park until the routine arrives.' } }))
        await vi.waitFor(() => {
          expect(f.store.getWork(ref)?.attempt.worker?.releasedAt).toBeDefined()
          expect(executor.snapshot().active).toBe(0)
        })
        const waiting = f.store.getWork(ref)!
        const work = draft(f, `routine-${name}`, reminder({ target: { kind: 'goal', taskId,
          projectId: waiting.task.projectId, attemptId: waiting.attempt.id, generation: waiting.attempt.generation,
          expectedVersion: waiting.task.version, waitReference,
        } }))
        arm(f, work)
        armedGoals.push({ ...work, taskRef: ref, waiting })
      }
      await f.adapter.reconcile()
      f.at(initialWake)
      for (const mapping of f.store.listRoutineMappings()) f.end(mapping.nativeId!)
      await f.adapter.reconcile()
      const [ready, denied] = armedGoals
      expect(f.store.getWork(ready!.taskRef)?.task).toMatchObject({ status: 'queued', generation: ready!.waiting.task.generation })
      expect(occurrences(f.store, ready!.ref)).toEqual([expect.objectContaining({ status: 'queued', taskId: ready!.taskRef.taskId })])
      expect(f.store.getWork(denied!.taskRef)).toEqual(denied!.waiting)
      expect(occurrences(f.store, denied!.ref)).toEqual([expect.objectContaining({ status: 'skipped', reason: 'budget_unavailable' })])
      expect(opens).toBe(2)
      expect(executor.snapshot().active).toBe(0)
    } finally { await executor.close() }
  })
})
