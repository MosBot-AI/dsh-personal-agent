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
  attemptSchema,
  conversationSchema,
  deliverySchema,
  effectSchema,
  projectSchema,
  sourceEventSchema,
  type AttemptId,
  type ConversationId,
  type DeliveryId,
  type OperationId,
  type ProjectId,
  type Task,
  type TaskId,
  type UtcInstant,
} from '../domain/model.js'
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
import { consumeWorkerReleaseProof } from '../runtime/executor.js'
import { createOutbox, type OutboxOptions } from '../runtime/outbox.js'
import { openStorageDatabase, type StorageDatabase } from './database.js'
import { sqliteCode, StorageError, transaction } from './schema.js'

const MAX_BYTES = 1024 * 1024
const MAX_INTENTS = 64
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
  | { ok: false; code: 'command_conflict' | 'source_duplicate' | 'conflict' }

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
  if (effects?.some(effect => effect.status !== 'prepared')
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
  private outbox?: ReturnType<typeof createOutbox>
  readonly artifacts = createArtifactStore(operation => this.access(operation))

  constructor(private readonly storage: StorageDatabase) {}

  close(): void {
    if (this.outbox?.isActive()) throw new StorageError('busy', 'The outbox still has provider operations in flight')
    this.closeDatabase()
  }

  private closeDatabase(): void {
    this.closed = true
    this.storage.close()
  }

  createActionGate(options: ActionGateOptions) {
    return createActionGate(operation => this.access(operation), options)
  }

  createOutbox(options: OutboxOptions) {
    if (this.outbox) throw new Error('An outbox is already open for this store')
    this.outbox = createOutbox(operation => this.access(operation), options)
    return this.outbox
  }

  createVerifier(options: VerificationOptions) {
    return createVerifier({
      readWork: ref => this.getWork(ref),
      readArtifact: (ref, id) => this.artifacts.read(ref, id),
      readEffect: (ref, id) => this.getEffect(ref, id),
      commit: (ref, evidence) => this.commitVerification(ref, evidence),
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
    return this.access(db => db.prepare(`
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
    `).get(ref.taskId, ref.ownerId, ref.profileId, attemptId, attemptId) !== undefined)
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

  private applyRuntimeEvent(ref: WorkRef, event: WorkEvent, intents: ValidatedIntents): StoredWorkResult {
    return this.commit(db => {
      const before = this.loadWork(db, ref)
      if (!before) return { ok: false, code: 'not_found' }
      const result = transitionWork(before, event)
      if (!result.ok) return result
      if (event.type === 'ready'
        && !collectArtifacts(before, event.artifactIds, id => readScopedArtifact(db, ref, id))) {
        return { ok: false, code: 'acceptance_unsatisfied' }
      }
      if (this.sourceAlreadyStored(db, intents.sourceEvent)) return { ok: false, code: 'source_duplicate' }
      const receipt = this.persist(db, before, result, event.type, event.at, intents, recordEncoder())
      return { ...receipt, replayed: false }
    })
  }

  private commitVerification(ref: WorkRef, evidence: VerificationCommit): StoredWorkResult {
    const intents = decodeIntents({ deliveries: evidence.deliveries })
    if (!intents) return { ok: false, code: 'invalid_input' }
    return this.commit(db => {
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
    if (!row) return undefined
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
      intents.sourceEvent?.id ?? null)
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
  return new WorkStore(openStorageDatabase(directory))
}

export type { WorkStore }
