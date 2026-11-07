import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { createArtifactStore, readScopedArtifact } from '../artifacts/store.js'
import {
  applyWorkCommand,
  workCommandSchema,
  type WorkCommand,
  type WorkCommandContext,
  type WorkCommandResult,
} from '../domain/commands.js'
import {
  artifactSchema,
  attemptSchema,
  conversationSchema,
  deliverySchema,
  effectSchema,
  projectSchema,
  sourceEventSchema,
  taskSchema,
  type ArtifactId,
  type AttemptId,
  type ConversationId,
  type DeliveryId,
  type OperationId,
  type ProjectId,
  type SourceEvent,
  type SourceEventId,
  type Task,
  type TaskId,
  type UtcInstant,
} from '../domain/model.js'
import { ROUTINE_SOURCE, type RoutineRef, type RoutineScope } from '../domain/routines.js'
import {
  transitionWork,
  workEventSchema,
  workStateSchema,
  type WorkEvent,
  type WorkState,
  type WorkTransitionResult,
} from '../domain/transitions.js'
import {
  artifactProofs, collectArtifacts, createVerifier, criteriaSatisfied, exactEffectReceipt, readyToVerify,
  verificationRecordSchema, type VerificationCommit, type VerificationOptions,
} from '../domain/verification.js'
import { createActionGate, type ActionGateOptions } from '../policy/dispatch.js'
import { createAttention, type AttentionOptions } from '../runtime/attention.js'
import { createBudget, markColdBudgetReservations, type BudgetOptions, type BudgetService } from '../runtime/budget.js'
import { consumeWorkerReleaseProof } from '../runtime/executor.js'
import {
  acknowledgeWorkerInput, insertWorkerInput, readWorkerInputs, recordInputObservation,
  type InputObservation, type JournaledWorkerInput, type WorkerInputIntent,
} from '../runtime/input-journal.js'
import { createEffectRecovery, type EffectRecoveryOptions } from '../runtime/recovery-effects.js'
import { createOutbox, type OutboxOptions } from '../runtime/outbox.js'
import type { RoutingAuthority, RoutingEventRef, SubscriptionKey, SubscriptionScope, WorkerRouteIntent } from '../runtime/subscriptions.js'
import { exportWorkAudit, type WorkAuditOptions, type WorkAuditScope } from './audit.js'
import { createWorkBackup, pruneWorkBackups, type BackupRetention, type WorkBackup } from './backup.js'
import { openStorageDatabase, type StorageDatabase } from './database.js'
import { dispatchPermitted, markStartupRecovery, recoveryMode } from './recovery-state.js'
import {
  applyWorkerHandback, cancelUnfinishedRouting, checkWorkerRoute, commitWorkerRoute, getRoutingEvent, getSubscription,
  listRoutingEvents, listSubscriptions, putSubscription, recordRoutingEvent, setRoutingDisposition,
} from './routing.js'
import {
  completeRoutineOccurrence, createRoutine, getRoutine, getRoutineRetirement, listArmedRoutines, listRoutineMappings,
  listRoutineOccurrences, listRoutines, reserveRoutineMapping, retimeRoutineMapping, runRoutineNow,
  skipRoutineMisfire, updateRoutine, updateRoutineMapping, type RoutineWakeRequest, type RoutineWakeResult,
} from './routines.js'
import { sqliteCode, StorageError, transaction } from './schema.js'

const MAX_BYTES = 1024 * 1024
const MAX_INTENTS = 64
const INBOX_LIMIT = 64
const intentsSchema = z.strictObject({
  sourceEvent: sourceEventSchema.optional(),
  effects: z.array(effectSchema).max(MAX_INTENTS).optional(),
  deliveries: z.array(deliverySchema).max(MAX_INTENTS).optional(),
})
const receiptSchema = z.strictObject({
  ok: z.literal(true),
  state: workStateSchema,
  previousAttempt: attemptSchema.optional(),
  sequence: z.int().positive().optional(),
})

type Scope = Pick<Task, 'ownerId' | 'profileId'>
export type WorkRef = Scope & { readonly taskId: TaskId }
type CommandActor = Extract<NonNullable<WorkCommandContext['actor']>, { role: 'owner' }>
export type StoredCommandContext = Omit<WorkCommandContext, 'state' | 'project' | 'conversation' | 'sourceEventIds'> & {
  readonly projectId?: ProjectId
  readonly conversationId?: ConversationId
}

export interface CommitIntents {
  readonly sourceEvent?: unknown
  readonly effects?: readonly unknown[]
  readonly deliveries?: readonly unknown[]
}

type ValidatedIntents = z.infer<typeof intentsSchema>
type Receipt = z.infer<typeof receiptSchema>
export type StoredWorkResult =
  | (Receipt & { replayed: boolean })
  | Extract<WorkCommandResult, { ok: false }>
  | { ok: false; code: 'command_conflict' | 'source_duplicate' | 'conflict' | 'recovery_required' }

function hasBoundedJson(value: unknown): boolean {
  try {
    const text = JSON.stringify(value)
    return text !== undefined && Buffer.byteLength(text) <= MAX_BYTES
  } catch {
    return false
  }
}

/** Bound the total record bytes written by a single transaction. */
function recordEncoder() {
  let remaining = MAX_BYTES
  return (value: unknown) => {
    const text = JSON.stringify(value)
    if (text === undefined) throw new StorageError('invalid_input', 'Storage record is not JSON')
    remaining -= Buffer.byteLength(text)
    if (remaining < 0) throw new StorageError('invalid_input', 'Storage write exceeds the transaction size limit')
    return text
  }
}

function readJson(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) {
    throw new StorageError('corrupt', 'Invalid storage record encoding')
  }
  try {
    return JSON.parse(value)
  } catch {
    throw new StorageError('corrupt', 'Storage record contains invalid JSON')
  }
}

function decodeRecord<T>(value: unknown, schema: { parse(value: unknown): T }): T {
  const input = readJson(value)
  try {
    return schema.parse(input)
  } catch {
    throw new StorageError('corrupt', 'Storage record failed validation')
  }
}

function decodeIntents(input: CommitIntents): ValidatedIntents | undefined {
  if ((input.effects?.length ?? 0) + (input.deliveries?.length ?? 0) > MAX_INTENTS
    || !hasBoundedJson(input)) return undefined
  const decoded = intentsSchema.safeParse(input)
  if (!decoded.success) return undefined
  const { effects, deliveries } = decoded.data
  if (decoded.data.sourceEvent?.sourceInstanceId === ROUTINE_SOURCE
    || effects?.some(effect => effect.status !== 'prepared')
    || deliveries?.some(delivery => delivery.status !== 'pending' || delivery.retries !== 0)) return undefined
  return decoded.data
}

function hasIntents(intents: ValidatedIntents): boolean {
  return intents.sourceEvent !== undefined
    || (intents.effects?.length ?? 0) > 0 || (intents.deliveries?.length ?? 0) > 0
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.ownerId === right.ownerId && left.profileId === right.profileId
}

function unsettledEffects(db: DatabaseSync, ref: WorkRef, attemptId: AttemptId): boolean {
  return db.prepare(`
    SELECT 1 FROM tasks t WHERE t.id = ? AND t.owner_id = ? AND t.profile_id = ?
    AND (
      EXISTS (
        SELECT 1 FROM effects e WHERE e.task_id = t.id AND e.attempt_id = ?
        AND coalesce(e.record ->> '$.status', '') NOT IN ('prepared', 'authorized', 'confirmed', 'failed')
      )
      OR EXISTS (
        SELECT 1 FROM outbox o WHERE o.task_id = t.id AND o.attempt_id = ?
        AND coalesce(o.record ->> '$.status', '') NOT IN ('pending', 'accepted', 'delivered', 'read', 'failed')
      )
    )
  `).get(ref.taskId, ref.ownerId, ref.profileId, attemptId, attemptId) !== undefined
}

function commandFingerprint(
  command: WorkCommand,
  context: StoredCommandContext,
  actor: CommandActor,
  source: ValidatedIntents['sourceEvent'],
): string {
  const input = {
    command,
    profileId: actor.profileId,
    deviceId: actor.deviceId,
    projectId: context.projectId,
    conversationId: context.conversationId,
    source: source && [source.sourceInstanceId, source.externalEventId, source.externalRevision],
  }
  const canonical = JSON.stringify(input, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1))
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** The store holds the profile writer lock until close. All commit inputs are data. */
class WorkStore {
  private closed = false
  private backupActive = false
  private budget?: BudgetService
  private outbox?: ReturnType<typeof createOutbox>
  private effectRecovery?: ReturnType<typeof createEffectRecovery>
  readonly artifacts = createArtifactStore(operation => this.access(operation))

  constructor(private readonly storage: StorageDatabase) {}

  close(): void {
    if (this.outbox?.isActive()) throw new StorageError('busy', 'The outbox still has provider operations in flight')
    if (this.effectRecovery?.isActive()) throw new StorageError('busy', 'Effect readback is still in flight')
    this.closeDatabase()
  }

  private closeDatabase(): void {
    this.closed = true
    this.storage.close()
  }

  async createBackup(directory: string, options: { signal?: AbortSignal } = {}): Promise<WorkBackup> {
    const source = this.access(db => db.location())
    if (!source) throw new StorageError('invalid_input', 'An on-disk WorkStore is required for backup')
    if (this.backupActive) throw new StorageError('busy', 'A work backup is already in progress')
    this.backupActive = true
    try {
      return await createWorkBackup(source, directory, options.signal)
    } finally {
      this.backupActive = false
    }
  }

  pruneBackups(directory: string, retention?: BackupRetention): { removed: number; remaining: number } {
    return this.access(() => pruneWorkBackups(directory, retention))
  }

  exportAudit(scope: WorkAuditScope, options?: WorkAuditOptions) {
    return this.access(db => exportWorkAudit(db, scope, options))
  }

  createActionGate(options: ActionGateOptions) {
    return createActionGate(operation => this.access(operation), options, dispatchPermitted)
  }

  createBudget(options: BudgetOptions): BudgetService {
    if (this.budget) throw new Error('A budget is already open for this store')
    this.budget = createBudget(operation => this.access(operation), options, dispatchPermitted)
    return this.budget
  }

  createAttention(options: AttentionOptions = {}) {
    return createAttention(operation => this.access(operation), options, () => this.outbox?.deliver)
  }

  createOutbox(options: OutboxOptions) {
    if (this.outbox) throw new Error('An outbox is already open for this store')
    this.outbox = createOutbox(operation => this.access(operation), options, dispatchPermitted)
    return this.outbox
  }

  createEffectRecovery(options: EffectRecoveryOptions = {}) {
    if (this.effectRecovery) throw new Error('Effect recovery is already open for this store')
    this.effectRecovery = createEffectRecovery(operation => this.access(operation), options)
    return this.effectRecovery
  }

  recoveryMode() {
    return this.access(recoveryMode)
  }

  canDispatch(): boolean {
    return this.access(dispatchPermitted)
  }

  recordRoutingEvent(event: SourceEvent, digest: string, metadata: { projectId: ProjectId; authority: RoutingAuthority }) {
    if (event.sourceInstanceId === ROUTINE_SOURCE) return { ok: false, code: 'invalid_input' } as const
    if (!hasBoundedJson(event)) return { ok: false, code: 'invalid_input' } as const
    return this.access(db => transaction(db, () => recordRoutingEvent(db, event, digest, metadata)))
  }

  getRoutingEvent(ref: RoutingEventRef) {
    return this.access(db => getRoutingEvent(db, ref))
  }

  listRoutingEvents(scope: Scope, limit?: number) {
    return this.access(db => listRoutingEvents(db, scope, limit))
  }

  setRoutingDisposition(ref: RoutingEventRef, expectedVersion: number, disposition: unknown) {
    return this.access(db => transaction(db, () => setRoutingDisposition(db, ref, expectedVersion, disposition)))
  }

  cancelUnfinishedRouting(scope?: Scope, limit?: number): number {
    return this.access(db => transaction(db, () => cancelUnfinishedRouting(db, scope, limit)))
  }

  getSubscription(key: SubscriptionKey) {
    return this.access(db => getSubscription(db, key))
  }

  listSubscriptions(scope: SubscriptionScope, projectId: ProjectId, at: UtcInstant) {
    return this.access(db => listSubscriptions(db, scope, projectId, at))
  }

  putSubscription(input: unknown, expectedVersion?: number) {
    return this.access(db => transaction(db, () => putSubscription(db, input, expectedVersion)))
  }

  createRoutine(scope: RoutineScope, input: unknown, at: UtcInstant) {
    return this.access(db => transaction(db, () => createRoutine(db, scope, input, at)))
  }

  updateRoutine(ref: RoutineRef, input: unknown) {
    return this.access(db => transaction(db, () => updateRoutine(db, ref, input)))
  }

  getRoutine(ref: RoutineRef) {
    return this.access(db => getRoutine(db, ref))
  }

  listRoutines(scope: RoutineScope, limit?: number) {
    return this.access(db => listRoutines(db, scope, limit))
  }

  listArmedRoutines() {
    return this.access(listArmedRoutines)
  }

  listRoutineMappings(scope?: RoutineScope) {
    return this.access(db => listRoutineMappings(db, scope))
  }

  listRoutineOccurrences(scope: RoutineScope, limit?: number) {
    return this.access(db => listRoutineOccurrences(db, scope, limit))
  }

  reserveRoutineMapping(ref: RoutineRef, input: unknown) {
    return this.access(db => transaction(db, () => reserveRoutineMapping(db, ref, input)))
  }

  updateRoutineMapping(ref: RoutineRef, input: unknown) {
    return this.access(db => transaction(db, () => updateRoutineMapping(db, ref, input)))
  }

  retimeRoutineMapping(ref: RoutineRef, input: unknown) {
    return this.access(db => transaction(db, () => retimeRoutineMapping(db, ref, input)))
  }

  skipRoutineMisfire(ref: RoutineRef, input: unknown) {
    return this.access(db => transaction(db, () => skipRoutineMisfire(db, ref, input)))
  }

  completeRoutineOccurrence(ref: RoutineRef, input: unknown) {
    return this.access(db => transaction(db, () => completeRoutineOccurrence(db, ref, input,
      request => this.wakeRoutineGoal(db, request))))
  }

  runRoutineNow(ref: RoutineRef, input: unknown) {
    return this.access(db => transaction(db, () => runRoutineNow(db, ref, input, request => this.wakeRoutineGoal(db, request))))
  }

  getRoutineRetirement(nativeId: string) {
    return this.access(db => getRoutineRetirement(db, nativeId))
  }

  listColdWork(after: string): WorkState[] {
    return this.access(db => db.prepare(`
      SELECT t.record AS task, a.record AS attempt FROM tasks t
      LEFT JOIN attempts a ON a.task_id = t.id AND a.id = t.attempt_id
      WHERE t.id > ? AND json_type(a.record, '$.worker') = 'object'
        AND (t.record ->> '$.status') IN (
          'queued', 'running', 'verifying', 'cancelling', 'paused', 'waiting_input',
          'waiting_approval', 'waiting_event', 'waiting_environment', 'waiting_resource', 'blocked'
        )
      ORDER BY t.id LIMIT 128
    `).all(after).map(row => this.decodeWork(row)))
  }

  listColdInputAttempts(after: string) {
    return this.access(db => db.prepare(`
      SELECT DISTINCT i.attempt_id AS attemptId, t.record AS task, a.record AS attempt
      FROM worker_inputs i JOIN tasks t ON t.id = i.task_id
      JOIN attempts a ON a.task_id = i.task_id AND a.id = i.attempt_id AND a.generation = i.generation
      WHERE i.attempt_id > ? AND i.status IN ('intent', 'flushed')
      ORDER BY i.attempt_id LIMIT 128
    `).all(after).map(row => {
      const task = decodeRecord(row.task, taskSchema)
      const attempt = decodeRecord(row.attempt, attemptSchema)
      if (attempt.id !== row.attemptId || attempt.taskId !== task.id || !sameScope(task, attempt.mandate)) {
        throw new StorageError('corrupt', 'Worker journal attempt scope does not match its task')
      }
      return { ref: { ownerId: task.ownerId, profileId: task.profileId, taskId: task.id }, attempt }
    }))
  }

  workerInputs(ref: WorkRef, attemptId: AttemptId) {
    return this.access(db => readWorkerInputs(db, ref, attemptId))
  }

  observeWorkerInput(ref: WorkRef, input: JournaledWorkerInput, observation: InputObservation, at: UtcInstant): boolean {
    return this.access(db => recordInputObservation(db, ref, input, observation, at))
  }

  applyWorkerEvent(ref: WorkRef, input: unknown, journal: WorkerInputIntent, route?: WorkerRouteIntent): StoredWorkResult {
    const event = workEventSchema.safeParse(input)
    if (!event.success || (event.data.type !== 'start' && event.data.type !== 'record_input' && event.data.type !== 'wake_worker')) {
      return { ok: false, code: 'invalid_input' }
    }
    if (event.data.type === 'wake_worker' && route === undefined) return { ok: false, code: 'permission_denied' }
    if (route !== undefined && journal.cursor !== route.eventId) return { ok: false, code: 'invalid_input' }
    return this.applyRuntimeEvent(ref, event.data, {}, journal, route)
  }

  applyWorkerHandback(ref: WorkRef, input: unknown): boolean {
    return this.access(db => transaction(db, () => {
      if (recoveryMode(db) !== 'normal') return false
      const state = this.loadWork(db, ref)
      return state !== undefined && applyWorkerHandback(db, ref, state, input)
    }))
  }

  acknowledgeWorkerInput(ref: WorkRef, input: WorkerInputIntent, at: UtcInstant): boolean {
    return this.access(db => recoveryMode(db) === 'normal' && acknowledgeWorkerInput(db, ref, input, at))
  }

  createVerifier(options: VerificationOptions & { readonly authorizeCommit?: () => boolean }) {
    return createVerifier({
      readWork: ref => this.getWork(ref),
      readArtifact: (ref, id) => this.artifacts.read(ref, id),
      readEffect: (ref, id) => this.getEffect(ref, id),
      commit: (ref, evidence) => options.authorizeCommit !== undefined && !options.authorizeCommit()
        ? { ok: false, code: 'permission_denied' } : this.commitVerification(ref, evidence),
    }, options)
  }

  getVerification(ref: WorkRef, version: number) {
    return this.access(db => {
      const row = db.prepare(`
        SELECT v.record FROM work_verifications v JOIN tasks t ON t.id = v.task_id
        WHERE v.task_id = ? AND v.version = ? AND t.owner_id = ? AND t.profile_id = ?
      `).get(ref.taskId, version, ref.ownerId, ref.profileId)
      if (!row) return undefined
      const evidence = decodeRecord(row.record, verificationRecordSchema)
      if (evidence.taskId !== ref.taskId || evidence.version !== version) {
        throw new StorageError('corrupt', 'Verification scope does not match its work event')
      }
      return evidence
    })
  }

  insertProject(input: unknown): void {
    if (!hasBoundedJson(input)) throw new StorageError('invalid_input', 'Invalid project record')
    const project = projectSchema.safeParse(input)
    if (!project.success) throw new StorageError('invalid_input', 'Invalid project record')
    this.access(db => db.prepare('INSERT INTO projects (id, record) VALUES (?, ?)')
      .run(project.data.id, recordEncoder()(project.data)))
  }

  insertConversation(input: unknown): void {
    if (!hasBoundedJson(input)) throw new StorageError('invalid_input', 'Invalid conversation record')
    const conversation = conversationSchema.safeParse(input)
    if (!conversation.success) throw new StorageError('invalid_input', 'Invalid conversation record')
    this.access(db => db.prepare('INSERT INTO conversations (id, record) VALUES (?, ?)')
      .run(conversation.data.id, recordEncoder()(conversation.data)))
  }

  getProject(scope: Scope, id: ProjectId) {
    return this.access(db => {
      const row = db.prepare('SELECT record FROM projects WHERE id = ? AND owner_id = ? AND profile_id = ?')
        .get(id, scope.ownerId, scope.profileId)
      return row && decodeRecord(row.record, projectSchema)
    })
  }

  getConversation(scope: Scope, id: ConversationId) {
    return this.access(db => {
      const row = db.prepare('SELECT record FROM conversations WHERE id = ? AND owner_id = ? AND profile_id = ?')
        .get(id, scope.ownerId, scope.profileId)
      return row && decodeRecord(row.record, conversationSchema)
    })
  }

  listInboxProjects(scope: Scope) {
    return this.access(db => db.prepare(`
      SELECT record FROM projects WHERE owner_id = ? AND profile_id = ? ORDER BY rowid DESC LIMIT ?
    `).all(scope.ownerId, scope.profileId, INBOX_LIMIT).map(row => decodeRecord(row.record, projectSchema)))
  }

  listInboxWork(scope: Scope): WorkState[] {
    return this.access(db => db.prepare(`
      SELECT t.record AS task, a.record AS attempt FROM tasks t
      LEFT JOIN attempts a ON a.id = t.attempt_id AND a.task_id = t.id
      WHERE t.owner_id = ? AND t.profile_id = ? AND t.conversation_id IS NOT NULL
      ORDER BY CASE
        WHEN (t.record ->> '$.status') IN ('waiting_input', 'waiting_approval', 'blocked', 'reconciliation_required') THEN 0
        WHEN (t.record ->> '$.status') = 'completed' THEN 1
        ELSE 2
      END, (t.record ->> '$.updatedAt') DESC, t.rowid DESC
      LIMIT ?
    `).all(scope.ownerId, scope.profileId, INBOX_LIMIT).map(row => this.decodeWork(row)))
  }

  listInboxDeliveries(ref: WorkRef) {
    return this.access(db => db.prepare(`
      SELECT record FROM outbox WHERE task_id = ? AND owner_id = ? AND profile_id = ?
      ORDER BY rowid DESC LIMIT 16
    `).all(ref.taskId, ref.ownerId, ref.profileId).map(row => decodeRecord(row.record, deliverySchema)))
  }

  listInboxArtifacts(ref: WorkRef, attemptId: AttemptId, generation: number, artifactIds: readonly ArtifactId[]) {
    const ids = artifactIds.slice(0, INBOX_LIMIT)
    if (ids.length === 0) return []
    return this.access(db => db.prepare(`
      SELECT id, version, (record -> '$.artifact') AS metadata FROM artifacts
      WHERE owner_id = ? AND profile_id = ? AND task_id = ? AND attempt_id = ? AND generation = ?
        AND id IN (${ids.map(() => '?').join(', ')})
    `).all(ref.ownerId, ref.profileId, ref.taskId, attemptId, generation, ...ids).map(row => {
      const artifact = decodeRecord(row.metadata, artifactSchema)
      if (artifact.id !== row.id || !sameScope(ref, artifact) || artifact.attemptId !== attemptId || typeof row.version !== 'number') {
        throw new StorageError('corrupt', 'Artifact metadata does not match its stored scope')
      }
      return { artifact, version: row.version }
    }))
  }

  getWakeSource(ref: WorkRef, version: number) {
    return this.access(db => {
      const row = db.prepare(`
        SELECT s.record FROM work_events w JOIN source_events s ON s.id = w.source_event_id
        WHERE w.task_id = ? AND w.owner_id = ? AND w.profile_id = ? AND w.version = ? AND w.type = 'wake'
      `).get(ref.taskId, ref.ownerId, ref.profileId, version)
      return row && decodeRecord(row.record, sourceEventSchema)
    })
  }

  getWork(ref: WorkRef): WorkState | undefined {
    return this.access(db => this.loadWork(db, ref))
  }

  getAttempt(ref: WorkRef, attemptId: AttemptId) {
    return this.access(db => {
      const row = db.prepare(`
        SELECT a.record FROM attempts a JOIN tasks t ON t.id = a.task_id
        WHERE a.id = ? AND t.id = ? AND t.owner_id = ? AND t.profile_id = ?
      `).get(attemptId, ref.taskId, ref.ownerId, ref.profileId)
      if (!row) return undefined
      const attempt = decodeRecord(row.record, attemptSchema)
      if (!sameScope(ref, attempt.mandate)) throw new StorageError('corrupt', 'Attempt scope does not match its task')
      return attempt
    })
  }

  getEffect(ref: WorkRef, operationId: OperationId) {
    return this.access(db => {
      const row = db.prepare(`
        SELECT e.record FROM effects e JOIN tasks t ON t.id = e.task_id
        WHERE e.operation_id = ? AND t.id = ? AND t.owner_id = ? AND t.profile_id = ?
      `).get(operationId, ref.taskId, ref.ownerId, ref.profileId)
      return row && decodeRecord(row.record, effectSchema)
    })
  }

  hasUnsettledEffects(ref: WorkRef, attemptId: AttemptId): boolean {
    return this.access(db => unsettledEffects(db, ref, attemptId))
  }

  getDelivery(ref: WorkRef, deliveryId: DeliveryId) {
    return this.access(db => {
      const row = db.prepare(`
        SELECT record FROM outbox WHERE id = ? AND task_id = ? AND owner_id = ? AND profile_id = ?
      `).get(deliveryId, ref.taskId, ref.ownerId, ref.profileId)
      return row && decodeRecord(row.record, deliverySchema)
    })
  }

  applyCommand(input: unknown, context: StoredCommandContext, intentInput: CommitIntents = {}): StoredWorkResult {
    const { actor } = context
    if (actor?.role !== 'owner') return { ok: false, code: 'permission_denied' }
    if (!hasBoundedJson(input)) return { ok: false, code: 'invalid_command' }
    const decoded = workCommandSchema.safeParse(input)
    if (!decoded.success) return { ok: false, code: 'invalid_command' }
    const command = decoded.data
    if (command.type !== 'work.get' && command.type !== 'work.cancel' && this.recoveryMode() === 'restore') {
      return { ok: false, code: 'recovery_required' }
    }
    const intents = decodeIntents(intentInput)
    if (!intents) return { ok: false, code: 'invalid_input' }
    if (intents.sourceEvent && !sameScope(actor, intents.sourceEvent)) {
      return { ok: false, code: 'permission_denied' }
    }

    if (command.type === 'work.get') {
      if (hasIntents(intents)) return { ok: false, code: 'invalid_input' }
      return this.access(db => {
        const { result } = this.evaluateCommand(db, command, context, actor, intents)
        return result.ok ? { ...result, replayed: false } : result
      })
    }

    const fingerprint = commandFingerprint(command, context, actor, intents.sourceEvent)
    return this.commit(db => {
      const existing = db.prepare(`
        SELECT profile_id, fingerprint, task_id, result FROM commands
        WHERE owner_id = ? AND client_id = ? AND command_id = ?
      `).get(actor.ownerId, actor.clientId, command.commandId)
      if (existing) {
        if (existing.profile_id !== actor.profileId || existing.fingerprint !== fingerprint) {
          return { ok: false, code: 'command_conflict' }
        }
        const receipt = decodeRecord(existing.result, receiptSchema)
        const { task } = receipt.state
        if (task.id !== existing.task_id || !sameScope(actor, task) || (receipt.previousAttempt
          && (receipt.previousAttempt.taskId !== task.id || !sameScope(actor, receipt.previousAttempt.mandate)))) {
          throw new StorageError('corrupt', 'Command receipt does not match its stored task scope')
        }
        return { ...receipt, replayed: true }
      }
      const { before, result } = this.evaluateCommand(db, command, context, actor, intents)
      if (!result.ok) return result
      if (this.sourceAlreadyStored(db, intents.sourceEvent)) return { ok: false, code: 'source_duplicate' }
      const encode = recordEncoder()
      const receipt = this.persist(db, before, result, command.type, context.at, intents, encode)
      db.prepare(`
        INSERT INTO commands (owner_id, profile_id, client_id, command_id, fingerprint, result, task_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(actor.ownerId, actor.profileId, actor.clientId, command.commandId, fingerprint,
        encode(receipt), receipt.state.task.id)
      return { ...receipt, replayed: false }
    })
  }

  /** The caller authenticates the coordinator and supplies the scoped task reference. */
  applyEvent(ref: WorkRef, input: unknown, intentInput: CommitIntents = {}): StoredWorkResult {
    if (!hasBoundedJson(input)) return { ok: false, code: 'invalid_input' }
    const event = workEventSchema.safeParse(input)
    const intents = decodeIntents(intentInput)
    if (!event.success || !intents) return { ok: false, code: 'invalid_input' }
    if (!('generation' in event.data) || event.data.type === 'verify' || event.data.type === 'release_worker'
      || event.data.type === 'wake_worker' || event.data.type === 'record_input'
      || (event.data.type === 'start' && event.data.worker !== undefined)
      || (event.data.type === 'reconcile' && event.data.outcome.status === 'completed')
      || (intents.sourceEvent && !sameScope(ref, intents.sourceEvent))) {
      return { ok: false, code: 'permission_denied' }
    }
    return this.applyRuntimeEvent(ref, event.data, intents)
  }

  confirmWorkerRelease(proof: unknown): StoredWorkResult {
    const release = consumeWorkerReleaseProof(proof, this)
    if (!release) return { ok: false, code: 'permission_denied' }
    return this.applyRuntimeEvent(release.ref, release.event, {})
  }

  private applyRuntimeEvent(
    ref: WorkRef, event: WorkEvent, intents: ValidatedIntents, journal?: WorkerInputIntent, route?: WorkerRouteIntent,
  ): StoredWorkResult {
    return this.commit(db => {
      if (journal && !dispatchPermitted(db)) return { ok: false, code: 'recovery_required' }
      if (event.type === 'recover_attempt' && recoveryMode(db) !== 'reconciling') {
        return { ok: false, code: 'invalid_transition' }
      }
      const before = this.loadWork(db, ref)
      if (!before) return { ok: false, code: 'not_found' }
      const routing = route === undefined ? undefined : checkWorkerRoute(db, before, event, route)
      if (routing && !routing.ok) return routing
      const result = transitionWork(before, event)
      if (!result.ok) return result
      if (event.type === 'ready'
        && !collectArtifacts(before, event.artifactIds, id => readScopedArtifact(db, ref, id))) {
        return { ok: false, code: 'acceptance_unsatisfied' }
      }
      if (this.sourceAlreadyStored(db, intents.sourceEvent)) return { ok: false, code: 'source_duplicate' }
      const receipt = this.persist(db, before, result, event.type, event.at, intents, recordEncoder(), routing?.claim.ref.eventId)
      if (journal) {
        insertWorkerInput(db, result.state, journal)
        if (routing) commitWorkerRoute(db, routing.claim, result.state, journal)
      }
      return { ...receipt, replayed: false }
    })
  }

  private commitVerification(ref: WorkRef, evidence: VerificationCommit): StoredWorkResult {
    const intents = decodeIntents({ deliveries: evidence.deliveries })
    if (!intents) return { ok: false, code: 'invalid_input' }
    return this.commit(db => {
      if (!dispatchPermitted(db)) return { ok: false, code: 'recovery_required' }
      const before = this.loadWork(db, ref)
      if (!before) return { ok: false, code: 'not_found' }
      if (before.task.version !== evidence.expectedVersion) return { ok: false, code: 'version_conflict' }
      if (before.attempt.id !== evidence.attemptId || before.attempt.generation !== evidence.generation
        || before.task.generation !== evidence.generation) return { ok: false, code: 'stale_attempt' }
      if (!readyToVerify(before)) return { ok: false, code: 'invalid_transition' }
      const artifacts = collectArtifacts(before, before.attempt.artifactIds, id => readScopedArtifact(db, ref, id))
      if (!artifacts || !criteriaSatisfied(before, evidence.criteria)
        || JSON.stringify(artifactProofs(artifacts)) !== JSON.stringify(evidence.artifacts)) {
        return { ok: false, code: 'acceptance_unsatisfied' }
      }
      if (evidence.effectReceipt) {
        const row = db.prepare('SELECT record FROM effects WHERE operation_id = ? AND task_id = ?')
          .get(evidence.effectReceipt.operationId, ref.taskId)
        const current = exactEffectReceipt(before, row && decodeRecord(row.record, effectSchema))
        if (JSON.stringify(current) !== JSON.stringify(evidence.effectReceipt)) {
          return { ok: false, code: 'acceptance_unsatisfied' }
        }
      } else if (before.task.acceptance.requiresReceipt) {
        return { ok: false, code: 'acceptance_unsatisfied' }
      }

      if (intents.deliveries?.length) {
        const row = db.prepare('SELECT record FROM conversations WHERE id = ? AND owner_id = ? AND profile_id = ?')
          .get(before.task.conversationId ?? null, ref.ownerId, ref.profileId)
        if (!row) return { ok: false, code: 'permission_denied' }
        const { originalDestination } = decodeRecord(row.record, conversationSchema)
        const verified = new Set(evidence.artifacts.map(proof => proof.id))
        if (intents.deliveries.some(delivery => !sameScope(ref, delivery)
          || delivery.destination.sourceInstanceId !== originalDestination.sourceInstanceId
          || delivery.destination.externalDestinationId !== originalDestination.externalDestinationId
          || delivery.payload.artifactIds.some(id => !verified.has(id)))) {
          return { ok: false, code: 'permission_denied' }
        }
      }
      const result = transitionWork(before, {
        type: 'verify',
        expectedVersion: evidence.expectedVersion,
        attemptId: evidence.attemptId,
        generation: evidence.generation,
        at: evidence.at,
        evidence: {
          criteriaSatisfied: true,
          artifactIds: evidence.artifacts.map(proof => proof.id),
          receiptId: evidence.effectReceipt?.providerReceiptId,
        },
      })
      if (!result.ok) return result
      const encode = recordEncoder()
      const receipt = this.persist(db, before, result, 'verify', evidence.at, intents, encode)
      const record = verificationRecordSchema.parse({
        taskId: ref.taskId,
        attemptId: evidence.attemptId,
        generation: evidence.generation,
        version: result.state.task.version,
        verifiedAt: evidence.at,
        criteria: evidence.criteria,
        artifacts: evidence.artifacts,
        effectReceipt: evidence.effectReceipt,
      })
      db.prepare(`
        INSERT INTO work_verifications (task_id, attempt_id, generation, version, record)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.taskId, record.attemptId, record.generation, record.version, encode(record))
      return { ...receipt, replayed: false }
    })
  }

  private access<T>(fn: (db: DatabaseSync) => T): T {
    const { db } = this.storage
    if (this.closed || !db.isOpen) throw new StorageError('closed', 'The work store is closed')
    try {
      return fn(db)
    } catch (error) {
      const code = sqliteCode(error)
      if (code === 11 || code === 26 || (error instanceof StorageError && error.code === 'corrupt')) {
        this.closed = true
        return this.storage.quarantine(error)
      }
      // A failed rollback must not expose the unfinished transaction to readers.
      if (db.isTransaction) {
        try {
          this.closeDatabase()
        } catch (closeError) {
          throw new AggregateError([error, closeError], 'Failed to close the unfinished work transaction')
        }
        throw error
      }
      if (code === 19) throw new StorageError('conflict', 'Storage constraint rejected the write')
      if (code === 13) throw new StorageError('full', 'SQLite storage is full')
      if (code === 5 || code === 6) throw new StorageError('busy', 'SQLite storage is busy')
      throw error
    }
  }

  private commit(fn: (db: DatabaseSync) => StoredWorkResult): StoredWorkResult {
    try {
      return this.access(db => transaction(db, () => fn(db)))
    } catch (error) {
      if (error instanceof StorageError && (
        error.code === 'conflict' || error.code === 'version_conflict'
        || error.code === 'invalid_input' || error.code === 'stale_attempt'
      )) return { ok: false, code: error.code }
      throw error
    }
  }

  private loadWork(db: DatabaseSync, ref: WorkRef): WorkState | undefined {
    const row = db.prepare(`
      SELECT t.record AS task, a.record AS attempt FROM tasks t
      LEFT JOIN attempts a ON a.id = t.attempt_id AND a.task_id = t.id
      WHERE t.id = ? AND t.owner_id = ? AND t.profile_id = ?
    `).get(ref.taskId, ref.ownerId, ref.profileId)
    return row === undefined ? undefined : this.decodeWork(row)
  }

  private wakeRoutineGoal(db: DatabaseSync, request: RoutineWakeRequest): RoutineWakeResult {
    const { routine, goal, occurrence, authority, admission } = request
    const ref = { ownerId: routine.ownerId, profileId: routine.profileId, taskId: goal.taskId }
    const before = this.loadWork(db, ref)
    const project = db.prepare(`
      SELECT record FROM projects WHERE id = ? AND owner_id = ? AND profile_id = ?
    `).get(goal.projectId, ref.ownerId, ref.profileId)
    if (!before || before.task.projectId !== goal.projectId || !project || decodeRecord(project.record, projectSchema).status !== 'active') {
      return { status: 'skipped', reason: 'target_unavailable' }
    }
    const { task, attempt } = before
    if (attempt.id !== goal.attemptId || attempt.generation !== goal.generation || task.generation !== goal.generation) {
      return { status: 'skipped', reason: 'stale_attempt' }
    }
    if (task.version !== goal.expectedVersion) return { status: 'skipped', reason: 'version_conflict' }
    if (attempt.mandate.policyVersion !== authority.policyVersion) return { status: 'skipped', reason: 'authority_changed' }
    if (task.status !== 'waiting_event' || task.wait?.reason !== 'event' || task.wait.referenceId !== goal.waitReference) {
      return { status: 'skipped', reason: 'wait_unavailable' }
    }
    const native = attempt.worker !== undefined || attempt.sessionId !== undefined || attempt.agentId !== undefined
    if (native && attempt.worker?.releasedAt === undefined) return { status: 'skipped', reason: 'runtime_not_quiescent' }
    if (unsettledEffects(db, ref, attempt.id)) return { status: 'skipped', reason: 'effects_unsettled' }
    const at = occurrence.observedAt
    const result = transitionWork(before, {
      type: 'wake', at, expectedVersion: goal.expectedVersion, attemptId: goal.attemptId,
      generation: goal.generation, reason: 'event', referenceId: goal.waitReference,
      policyVersion: authority.policyVersion, runtimeQuiescent: true, ...admission,
    })
    if (!result.ok) return { status: 'skipped', reason: 'wait_unavailable' }
    const sourceEvent = sourceEventSchema.parse({
      id: `${occurrence.id}-source`, ownerId: ref.ownerId, profileId: ref.profileId,
      sourceInstanceId: ROUTINE_SOURCE, externalEventId: occurrence.id, externalRevision: String(routine.revision),
      actor: { kind: 'service', externalActorId: routine.id }, occurredAt: occurrence.intendedAt, receivedAt: at,
      body: { kind: 'routine_wake', routineId: routine.id, routineRevision: routine.revision, occurrenceId: occurrence.id },
      provenance: { description: 'Verified internal Routine occurrence' },
    })
    if (this.sourceAlreadyStored(db, sourceEvent)) {
      throw new StorageError('corrupt', 'Routine wake source exists without its occurrence')
    }
    this.persist(db, before, result, 'wake', at, { sourceEvent }, recordEncoder())
    return { status: 'queued', taskId: task.id, taskVersion: result.state.task.version, sourceEventId: sourceEvent.id }
  }

  private decodeWork(row: Record<string, unknown>): WorkState {
    const decoded = workStateSchema.safeParse({
      task: readJson(row.task),
      attempt: readJson(row.attempt),
    })
    if (!decoded.success) throw new StorageError('corrupt', 'Task and attempt records failed validation')
    return decoded.data
  }

  private evaluateCommand(
    db: DatabaseSync,
    command: WorkCommand,
    context: StoredCommandContext,
    actor: CommandActor,
    intents: ValidatedIntents,
  ): { before?: WorkState; result: WorkCommandResult } {
    const creating = command.type === 'work.create'
    const projectId = context.projectId ?? (creating ? command.payload.projectId : undefined)
    const conversationId = context.conversationId ?? (creating ? command.conversationId : undefined)
    const projectRow = projectId === undefined ? undefined : db.prepare(`
      SELECT record FROM projects WHERE id = ? AND owner_id = ? AND profile_id = ?
    `).get(projectId, actor.ownerId, actor.profileId)
    const conversationRow = conversationId === undefined ? undefined : db.prepare(`
      SELECT record FROM conversations WHERE id = ? AND owner_id = ? AND profile_id = ?
    `).get(conversationId, actor.ownerId, actor.profileId)
    if ((projectId !== undefined && !projectRow) || (conversationId !== undefined && !conversationRow)) {
      return { result: { ok: false, code: 'not_found' } }
    }
    const before = creating ? undefined : this.loadWork(db, { ...actor, taskId: command.taskId })
    const result = applyWorkCommand(command, {
      ...context,
      state: before,
      project: projectRow && decodeRecord(projectRow.record, projectSchema),
      conversation: conversationRow && decodeRecord(conversationRow.record, conversationSchema),
      sourceEventIds: intents.sourceEvent ? [intents.sourceEvent.id] : [],
    })
    return { before, result }
  }

  private sourceAlreadyStored(db: DatabaseSync, source: ValidatedIntents['sourceEvent']): boolean {
    return source !== undefined && db.prepare(`
      SELECT 1 FROM source_events WHERE source_instance_id = ? AND external_event_id = ? AND external_revision = ?
    `).get(source.sourceInstanceId, source.externalEventId, source.externalRevision) !== undefined
  }

  private persist(
    db: DatabaseSync,
    before: WorkState | undefined,
    result: Extract<WorkTransitionResult, { ok: true }>,
    type: string,
    at: UtcInstant,
    intents: ValidatedIntents,
    encode: ReturnType<typeof recordEncoder>,
    linkedSourceEventId?: SourceEventId,
  ): Receipt {
    const { task, attempt } = result.state
    if (before?.task.version === task.version) {
      if (hasIntents(intents)) throw new StorageError('invalid_input', 'A no-op cannot add work intents')
      return result
    }

    if (before) {
      const update = db.prepare(`
        UPDATE tasks SET record = ? WHERE id = ? AND owner_id = ? AND profile_id = ? AND version = ?
      `).run(encode(task), task.id, task.ownerId, task.profileId, before.task.version)
      if (update.changes !== 1) throw new StorageError('version_conflict', 'Task revision changed before commit')
    } else {
      db.prepare('INSERT INTO tasks (id, record) VALUES (?, ?)').run(task.id, encode(task))
    }
    if (before?.attempt.id === attempt.id) {
      db.prepare('UPDATE attempts SET record = ? WHERE id = ? AND task_id = ? AND generation = ?')
        .run(encode(attempt), attempt.id, task.id, attempt.generation)
    } else {
      db.prepare('INSERT INTO attempts (id, record) VALUES (?, ?)').run(attempt.id, encode(attempt))
    }
    if (intents.sourceEvent) {
      db.prepare('INSERT INTO source_events (id, record) VALUES (?, ?)')
        .run(intents.sourceEvent.id, encode(intents.sourceEvent))
    }
    const event = db.prepare(`
      INSERT INTO work_events
        (owner_id, profile_id, task_id, attempt_id, generation, version, type, status, occurred_at, source_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.ownerId, task.profileId, task.id, attempt.id, task.generation, task.version, type, task.status, at,
      intents.sourceEvent?.id ?? linkedSourceEventId ?? null)
    const sequence = Number(event.lastInsertRowid)
    if (!Number.isSafeInteger(sequence)) throw new StorageError('invalid_input', 'Work event sequence limit reached')

    for (const effect of intents.effects ?? []) {
      if (effect.taskId !== task.id || effect.attemptId !== attempt.id || effect.generation !== task.generation
        || attempt.generation !== task.generation) {
        throw new StorageError('stale_attempt', 'The effect intent does not match the current attempt')
      }
      if (task.status !== 'queued' && task.status !== 'running' && task.status !== 'verifying') {
        throw new StorageError('invalid_input', 'The task phase cannot prepare an effect')
      }
      db.prepare('INSERT INTO effects (operation_id, record) VALUES (?, ?)').run(effect.operationId, encode(effect))
    }
    for (const delivery of intents.deliveries ?? []) {
      if (!sameScope(task, delivery)) throw new StorageError('invalid_input', 'The delivery scope does not match the task')
      db.prepare('INSERT INTO outbox (id, task_id, attempt_id, generation, record) VALUES (?, ?, ?, ?, ?)')
        .run(delivery.id, task.id, attempt.id, attempt.generation, encode(delivery))
    }
    return { ...result, sequence }
  }
}

export function openWorkStore(directory: string): WorkStore {
  const storage = openStorageDatabase(directory)
  try {
    transaction(storage.db, () => {
      markColdBudgetReservations(storage.db)
      markStartupRecovery(storage.db)
    })
    return new WorkStore(storage)
  } catch (error) {
    if (error instanceof StorageError && error.code === 'corrupt') return storage.quarantine(error)
    storage.close()
    throw error
  }
}

export type { WorkStore }
