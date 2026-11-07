import { Cron } from '@deepseek-ai/dsh-util-time'
import { utcInstantSchema, type UtcInstant } from '../domain/model.js'
import { createRoutineSchema, routineIntentSchema } from '../domain/routines.js'
import type { GoalAdmission, Routine, RoutineAuthority, RoutineIntent, RoutineMapping, RoutineRef } from '../domain/routines.js'
import type { WorkState } from '../domain/transitions.js'
import type { WorkStore } from '../storage/store.js'
import { NativeWakeElapsed, type NativeScheduleEntry, type NativeSchedulePort, type NativeScheduleReceipt } from './native-schedule.js'

type Store = Pick<WorkStore, 'canDispatch' | 'getWork' | 'createRoutine' | 'updateRoutine' | 'getRoutine'
  | 'listArmedRoutines' | 'listRoutineMappings' | 'reserveRoutineMapping' | 'retimeRoutineMapping'
  | 'updateRoutineMapping' | 'skipRoutineMisfire' | 'completeRoutineOccurrence' | 'runRoutineNow' | 'getRoutineRetirement'>
type Scope = Pick<RoutineRef, 'ownerId' | 'profileId'>
type Update = { type: 'arm' | 'pause' | 'edit'; expectedRevision: number; intent?: unknown }
type ProblemCode = 'ambiguous_native' | 'missing_native' | 'changed_native' | 'native_paused'
  | 'native_create_unknown' | 'native_receipt_unavailable' | 'native_receipt_mismatch'
type TerminalReason = 'cancelled' | 'abandoned_intent' | 'missing_native' | 'changed_native' | 'ambiguous_native' | 'native_receipt_mismatch'

export interface ScheduleAdapterOptions {
  readonly store: Store
  readonly native: NativeSchedulePort
  readonly now?: () => UtcInstant
  readonly currentAuthority: (scope: Scope) => RoutineAuthority | undefined
  /** Trusted grants and budget preflight. No model call or worker launch. */
  readonly authorizeGoalWake?: (routine: Routine, state: WorkState, at: UtcInstant) => GoalAdmission | undefined
}

export interface ScheduleScanResult {
  readonly created: number
  readonly adopted: number
  readonly completed: number
  readonly skipped: number
  readonly retired: number
  readonly problems: readonly { readonly mappingId: string; readonly code: ProblemCode }[]
}

type Scan = { created: number; adopted: number; completed: number; skipped: number; retired: number;
  problems: { mappingId: string; code: ProblemCode }[] }

const MIN_WAKE_LEAD_MS = 1_000
const DELIVERY_GRACE_MS = 60_000
const MAX_SCAN_PASSES = 2
const MAX_CATALOG = 10_000
const MAX_RETIRE_PER_PASS = 32

const fail = <Code extends string>(code: Code) => ({ ok: false, code } as const)
const instant = (value: string) => utcInstantSchema.parse(value)
const blank = (): Scan => ({ created: 0, adopted: 0, completed: 0, skipped: 0, retired: 0, problems: [] })

function sameAuthority(left: RoutineAuthority | undefined, right: RoutineAuthority | undefined): boolean {
  return left !== undefined && right !== undefined && left.clientId === right.clientId && left.deviceId === right.deviceId
    && left.verifiedAt === right.verifiedAt && left.policyVersion === right.policyVersion
}

function refFor(routine: Routine): RoutineRef {
  return { ownerId: routine.ownerId, profileId: routine.profileId, routineId: routine.id }
}

function refForMapping(mapping: RoutineMapping): RoutineRef {
  return { ownerId: mapping.ownerId, profileId: mapping.profileId, routineId: mapping.routineId }
}

function canonicalIntent<T extends RoutineIntent>(input: T): T | undefined {
  if (input.timing.kind === 'at') return input
  const parsed = Cron.parse(input.timing.expression, input.timeZone)
  if (parsed.kind !== 'accepted') return undefined
  return { ...input, timing: { kind: 'cron', expression: parsed.rule.expression }, timeZone: parsed.rule.timeZone }
}

function cronFor(routine: Routine) {
  if (routine.timing.kind !== 'cron') return undefined
  const parsed = Cron.parse(routine.timing.expression, routine.timeZone)
  if (parsed.kind !== 'accepted') throw new Error('Stored routine recurrence could not be interpreted')
  return parsed.rule
}

function nextOnArm(routine: Routine, at: UtcInstant): UtcInstant | undefined {
  if (routine.timing.kind === 'at') return routine.timing.at > at ? routine.timing.at : undefined
  const next = cronFor(routine)?.next(Date.parse(at))
  return next === undefined ? undefined : instant(next)
}

function due(routine: Routine, floor: UtcInstant, at: UtcInstant): { latest: UtcInstant; future?: UtcInstant } {
  if (floor > at) return { latest: floor }
  const resolved = cronFor(routine)?.resolve(floor, Date.parse(at))
  return resolved === undefined ? { latest: floor } : {
    latest: instant(resolved.occurrenceAt),
    ...(resolved.nextScheduledAt === undefined ? {} : { future: instant(resolved.nextScheduledAt) }),
  }
}

function physicalWake(intendedAt: UtcInstant, at: UtcInstant): UtcInstant {
  return instant(new Date(Math.max(Date.parse(intendedAt), Date.parse(at) + MIN_WAKE_LEAD_MS)).toISOString())
}

function exactEntry(entry: NativeScheduleEntry, mapping: RoutineMapping, targetSessionId: string): boolean {
  return !entry.invalid && entry.marker === mapping.marker && entry.wakeAt === mapping.nativeWakeAt
    && entry.targetSessionId === targetSessionId && entry.targetSessionId === mapping.mailboxId
    && (mapping.nativeId === undefined || entry.id === mapping.nativeId)
}

function exactReceipt(receipt: NativeScheduleReceipt, mapping: RoutineMapping, nativeId: string): boolean {
  return receipt.nativeId === nativeId && receipt.marker === mapping.marker && receipt.prompt === mapping.marker
    && receipt.wakeAt === mapping.nativeWakeAt && receipt.targetSessionId === mapping.mailboxId
    && receipt.deliveredAt >= receipt.wakeAt && receipt.messageId.length > 0
}

/** One durable logical occurrence, one exact native wake, and no model-driven schedule creation. */
export function createScheduleAdapter(options: ScheduleAdapterOptions) {
  const { store, native } = options
  const now = options.now ?? (() => instant(new Date().toISOString()))
  let closed = false
  let dirty = false
  let retryElapsed = false
  let scheduled: NodeJS.Immediate | undefined
  let running: Promise<ScheduleScanResult> | undefined
  let disposing: Promise<void> | undefined

  function authority(scope: Scope): RoutineAuthority | undefined {
    try { return options.currentAuthority({ ownerId: scope.ownerId, profileId: scope.profileId }) } catch { return undefined }
  }

  function canWork(): boolean {
    return !closed && store.canDispatch()
  }

  function goalAdmission(routine: Routine, at: UtcInstant): GoalAdmission | undefined {
    if (routine.target.kind !== 'goal' || !options.authorizeGoalWake) return undefined
    const state = store.getWork({ ownerId: routine.ownerId, profileId: routine.profileId, taskId: routine.target.taskId })
    if (!state) return undefined
    try { return options.authorizeGoalWake(routine, state, at) } catch { return undefined }
  }

  function schedule(): void {
    if (closed) return
    if (running) { dirty = true; return }
    if (scheduled) return
    scheduled = setImmediate(() => {
      scheduled = undefined
      void reconcile().catch(() => { /* Durable mapping intent survives the failed scan. */ })
    })
  }

  function problem(scan: Scan, mapping: RoutineMapping, code: ProblemCode): void {
    if (!scan.problems.some(item => item.mappingId === mapping.id && item.code === code)) {
      scan.problems.push({ mappingId: mapping.id, code })
    }
  }

  function uncertain(scan: Scan, mapping: RoutineMapping, code: ProblemCode): void {
    problem(scan, mapping, code)
    if (!closed && mapping.state !== 'uncertain') {
      store.updateRoutineMapping(refForMapping(mapping), { mappingId: mapping.id, expectedVersion: mapping.version, state: 'uncertain' })
    }
  }

  function isObsolete(mapping: RoutineMapping): boolean {
    const routine = store.getRoutine(refForMapping(mapping))
    return routine?.status !== 'armed' || routine.revision !== mapping.routineRevision
  }

  function finishObsolete(mapping: RoutineMapping, terminalReason: TerminalReason): void {
    if (!canWork() || !isObsolete(mapping)) return
    store.updateRoutineMapping(refForMapping(mapping), {
      mappingId: mapping.id, expectedVersion: mapping.version, state: 'terminal', terminalReason,
    })
  }

  function unavailable(scan: Scan, mapping: RoutineMapping, code: Extract<TerminalReason, ProblemCode>): void {
    if (!isObsolete(mapping)) return uncertain(scan, mapping, code)
    problem(scan, mapping, code)
    finishObsolete(mapping, code)
  }

  async function handleMapping(original: RoutineMapping, catalog: NativeScheduleEntry[], scan: Scan): Promise<void> {
    if (!canWork() || original.state === 'terminal') return
    let mapping = original
    const ref = refForMapping(mapping)
    const entries = catalog.filter(entry => entry.marker === mapping.marker)
    if (entries.length > 1) return unavailable(scan, mapping, 'ambiguous_native')
    let entry = entries[0]
    if (entry && !exactEntry(entry, mapping, native.targetSessionId)) return unavailable(scan, mapping, 'changed_native')
    if (!entry && mapping.nativeId !== undefined) {
      return unavailable(scan, mapping, catalog.some(item => item.id === mapping.nativeId) ? 'changed_native' : 'missing_native')
    }
    if (!entry && isObsolete(mapping)) return finishObsolete(mapping, mapping.state === 'intent' ? 'abandoned_intent' : 'missing_native')

    if (!entry && mapping.state === 'intent') {
      const routine = store.getRoutine(ref)
      if (routine?.status !== 'armed' || routine.revision !== mapping.routineRevision) return
      if (!sameAuthority(routine.authority, authority(mapping))) return
      if (mapping.mailboxId !== native.targetSessionId) return uncertain(scan, mapping, 'changed_native')
      const at = now()
      if (mapping.nativeWakeAt <= at) {
        const floor = routine.nextIntendedAt
        if (!floor || floor > at) return uncertain(scan, mapping, 'changed_native')
        const occurrences = due(routine, floor, at)
        if (routine.misfire === 'skip' || occurrences.latest > mapping.intendedAt) {
          const skipped = store.skipRoutineMisfire(ref, {
            expectedRevision: routine.revision, expectedIntendedAt: floor,
            nextIntendedAt: routine.misfire === 'skip' ? occurrences.future : occurrences.latest, at,
            mappingId: mapping.id, expectedMappingVersion: mapping.version,
          })
          if (skipped.ok) scan.skipped++
          return
        }
        const retimed = store.retimeRoutineMapping(ref, {
          mappingId: mapping.id, expectedVersion: mapping.version, nativeWakeAt: physicalWake(mapping.intendedAt, at),
        })
        if (!retimed.ok) return
        mapping = retimed.mapping
      }
      if (!canWork() || !sameAuthority(routine.authority, authority(mapping))) return
      try {
        entry = await native.create({ marker: mapping.marker, wakeAt: mapping.nativeWakeAt })
      } catch (error) {
        if (error instanceof NativeWakeElapsed) {
          // No native mutation ran. Rescan the complete catalog before
          // retiming or skipping the durable intent under its misfire policy.
          if (now() >= mapping.nativeWakeAt) retryElapsed = true
          return
        }
        // A throw may be after native commit. A later scan uses a fresh full
        // catalog to adopt the exact marker and never blindly creates again.
        return uncertain(scan, mapping, 'native_create_unknown')
      }
      if (!canWork()) return
      if (!exactEntry(entry, mapping, native.targetSessionId)) return unavailable(scan, mapping, 'changed_native')
      catalog.push(entry)
      scan.created++
    }
    if (!entry) return
    if (mapping.state !== 'bound') {
      const bound = store.updateRoutineMapping(ref, {
        mappingId: mapping.id, expectedVersion: mapping.version, state: 'bound', nativeId: entry.id,
      })
      if (!bound.ok) return
      mapping = bound.mapping
      scan.adopted++
    }
    if (entry.status !== 'ended' && isObsolete(mapping)) {
      // Let a concurrent end go through receipt settlement on the next scan.
      if (!native.cancel) return
      try {
        if (await native.cancel(entry)) finishObsolete(mapping, 'cancelled')
      } catch { /* The next complete catalog can settle a lost cancellation acknowledgement. */ }
      return
    }
    if (entry.status === 'paused') return uncertain(scan, mapping, 'native_paused')
    if (entry.status !== 'ended') return

    let history: readonly NativeScheduleReceipt[]
    try { history = await native.history(entry.id) } catch { return problem(scan, mapping, 'native_receipt_unavailable') }
    if (!canWork()) return
    if (history.length === 0) return problem(scan, mapping, 'native_receipt_unavailable')
    const receipt = history[0]!
    if (history.length !== 1 || !exactReceipt(receipt, mapping, entry.id)) return unavailable(scan, mapping, 'native_receipt_mismatch')
    const at = now()
    if (receipt.deliveredAt > at) return problem(scan, mapping, 'native_receipt_mismatch')
    const routine = store.getRoutine(ref)
    const current = routine?.status === 'armed' && routine.revision === mapping.routineRevision ? routine : undefined
    const occurrences = current === undefined ? undefined : due(current, mapping.intendedAt, at)
    const superseded = occurrences !== undefined && occurrences.latest > mapping.intendedAt
    const misfire = superseded || (current?.misfire === 'skip' && Date.parse(at) - Date.parse(mapping.nativeWakeAt) > DELIVERY_GRACE_MS)
    const owner = authority(mapping)
    const admitted = current !== undefined && sameAuthority(current.authority, owner)
    const result = store.completeRoutineOccurrence(ref, {
      mappingId: mapping.id,
      receipt: { nativeId: receipt.nativeId, messageId: receipt.messageId, scheduledAt: receipt.wakeAt,
        deliveredAt: receipt.deliveredAt, targetSessionId: receipt.targetSessionId, prompt: receipt.prompt },
      intendedAt: mapping.intendedAt, at, authority: owner,
      nextIntendedAt: superseded && current?.misfire === 'latest' ? occurrences?.latest : occurrences?.future,
      ...(misfire ? { skipReason: 'misfire' as const } : {}),
      goalAdmission: admitted && !misfire ? goalAdmission(current, at) : undefined,
    })
    if (result.ok && !result.duplicate) {
      if (result.occurrence.status === 'skipped') scan.skipped++
      else scan.completed++
    }
  }

  async function retireCommitted(catalog: readonly NativeScheduleEntry[], scan: Scan): Promise<void> {
    if (!native.retire) return
    let attempts = 0
    let retired = 0
    for (const entry of catalog) {
      if (!canWork()) return
      if (entry.invalid || entry.status !== 'ended' || entry.targetSessionId !== native.targetSessionId) continue
      const proof = store.getRoutineRetirement(entry.id)
      if (!proof || proof.nativeId !== entry.id || proof.prompt !== entry.marker || proof.scheduledAt !== entry.wakeAt
        || proof.targetSessionId !== entry.targetSessionId) continue
      attempts++
      try {
        if (await native.retire({ nativeId: proof.nativeId, marker: entry.marker, prompt: proof.prompt, wakeAt: proof.scheduledAt,
          deliveredAt: proof.deliveredAt, targetSessionId: proof.targetSessionId, messageId: proof.messageId })) retired++
      } catch { /* Keep the saved receipt. A later catalog can retry exact retirement. */ }
      if (attempts >= MAX_RETIRE_PER_PASS) {
        if (retired > 0) dirty = true
        break
      }
    }
    scan.retired += retired
  }

  async function scanOnce(scan: Scan): Promise<void> {
    if (!canWork()) return
    const original = store.listRoutineMappings()
    if (!native.retire && original.length === 0 && store.listArmedRoutines().length === 0) return
    const catalog = [...await native.catalog()]
    if (catalog.length > MAX_CATALOG || new Set(catalog.map(entry => entry.id)).size !== catalog.length) {
      throw new Error('The native schedule catalog is incomplete or ambiguous')
    }
    for (const mapping of original) await handleMapping(mapping, catalog, scan)
    await retireCommitted(catalog, scan)
    if (!canWork()) return
    const active = new Set(store.listRoutineMappings().filter(mapping => mapping.state !== 'terminal')
      .map(mapping => JSON.stringify([mapping.ownerId, mapping.profileId, mapping.routineId, mapping.routineRevision])))
    for (const routine of store.listArmedRoutines()) {
      if (!canWork()) return
      const ref = refFor(routine)
      if (active.has(JSON.stringify([ref.ownerId, ref.profileId, ref.routineId, routine.revision]))
        || !routine.nextIntendedAt || !sameAuthority(routine.authority, authority(ref))) continue
      const at = now()
      const occurrences = due(routine, routine.nextIntendedAt, at)
      if (routine.misfire === 'skip' && routine.nextIntendedAt < at) {
        const skipped = store.skipRoutineMisfire(ref, { expectedRevision: routine.revision,
          expectedIntendedAt: routine.nextIntendedAt, nextIntendedAt: occurrences.future, at })
        if (!skipped.ok) continue
        scan.skipped++
        if (occurrences.future === undefined) continue
      }
      const intendedAt = routine.misfire === 'skip' && routine.nextIntendedAt < at ? occurrences.future! : occurrences.latest
      const reserved = store.reserveRoutineMapping(ref, {
        expectedRevision: routine.revision, intendedAt, nativeWakeAt: physicalWake(intendedAt, at), mailboxId: native.targetSessionId, at,
      })
      if (reserved.ok) await handleMapping(reserved.mapping, catalog, scan)
    }
  }

  function reconcile(): Promise<ScheduleScanResult> {
    if (closed) return Promise.resolve(blank())
    if (running) { dirty = true; return running }
    clearImmediate(scheduled)
    scheduled = undefined
    running = Promise.resolve().then(async () => {
      const scan = blank()
      for (let pass = 0; pass < MAX_SCAN_PASSES && !closed; pass++) {
        dirty = false
        retryElapsed = false
        await scanOnce(scan)
        if (!dirty && !retryElapsed) break
      }
      return scan
    }).finally(() => {
      running = undefined
      if (dirty && !closed) schedule()
    })
    return running
  }

  const unsubscribe = native.subscribe(schedule)

  return Object.freeze({
    create(scope: Scope, input: unknown) {
      if (!canWork()) return fail(closed ? 'closed' : 'recovery_required')
      const decoded = createRoutineSchema.safeParse(input)
      const intent = decoded.success ? canonicalIntent(decoded.data) : undefined
      return intent ? store.createRoutine({ ownerId: scope.ownerId, profileId: scope.profileId }, intent, now()) : fail('invalid_input')
    },
    update(ref: RoutineRef, input: Update, owner?: RoutineAuthority) {
      if (!canWork()) return fail(closed ? 'closed' : 'recovery_required')
      const at = now()
      const routine = store.getRoutine(ref)
      if (!routine) return fail('not_found')
      if (routine.revision !== input.expectedRevision) return fail('version_conflict')
      if (input.type === 'arm') {
        if (!sameAuthority(owner, authority(ref))) return fail('permission_denied')
        const nextIntendedAt = nextOnArm(routine, at)
        if (!nextIntendedAt) return fail('invalid_input')
        const result = store.updateRoutine(ref, { type: 'arm', expectedRevision: input.expectedRevision, at, authority: owner, nextIntendedAt })
        if (result.ok) schedule()
        return result
      }
      const decoded = input.type === 'edit' ? routineIntentSchema.safeParse(input.intent) : undefined
      const intent = decoded?.success ? canonicalIntent(decoded.data) : undefined
      if (input.type === 'edit' && !intent) return fail('invalid_input')
      const result = input.type === 'pause'
        ? store.updateRoutine(ref, { type: 'pause', expectedRevision: input.expectedRevision, at })
        : store.updateRoutine(ref, { type: 'edit', expectedRevision: input.expectedRevision, at, intent })
      if (result.ok) schedule()
      return result
    },
    runNow(ref: RoutineRef, input: { expectedRevision: number; commandId: string }, owner: RoutineAuthority) {
      if (!canWork()) return fail(closed ? 'closed' : 'recovery_required')
      if (!sameAuthority(owner, authority(ref))) return fail('permission_denied')
      const routine = store.getRoutine(ref)
      if (!routine) return fail('not_found')
      const at = now()
      return store.runRoutineNow(ref, { ...input, at, authority: owner, goalAdmission: goalAdmission(routine, at) })
    },
    reconcile,
    close(): Promise<void> {
      if (disposing) return disposing
      closed = true
      unsubscribe()
      clearImmediate(scheduled)
      disposing = Promise.resolve(running).catch(() => undefined).then(() => native.dispose())
      return disposing
    },
  })
}
