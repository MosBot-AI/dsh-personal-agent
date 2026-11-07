import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  attemptIdSchema, clientIdSchema, conversationSchema, deviceIdSchema, mandateRefSchema, ownerIdSchema,
  profileIdSchema, projectSchema, sessionIdSchema, sourceEventSchema, taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { makeWorkerInput } from '../../packages/personal-agent/src/runtime/input-journal.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const later = utcInstantSchema.parse('2026-11-07T08:01:00.000Z')
const expiry = utcInstantSchema.parse('2026-11-07T08:02:00.000Z')
const scope = { ownerId: ownerIdSchema.parse('context-owner'), profileId: profileIdSchema.parse('context-profile') }
const actor = { role: 'owner' as const, ...scope, clientId: clientIdSchema.parse('context-client'),
  deviceId: deviceIdSchema.parse('context-device'), policyVersion: 'context-policy' }
const sharedSession = sessionIdSchema.parse('context-primary')
const privateSession = sessionIdSchema.parse(`dshpa-${'a'.repeat(64)}`)
const unboundSession = sessionIdSchema.parse('context-unbound')

function success<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`Context fixture operation failed: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-context-store-'))
  let store = openWorkStore(directory)
  onTestFinished(() => {
    try { store.close() } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  return {
    get store() { return store },
    reopen(sql?: string) {
      store.close()
      if (sql !== undefined) {
        const db = new DatabaseSync(join(directory, DATABASE_FILENAME))
        try { db.exec(sql) } finally { db.close() }
      }
      store = openWorkStore(directory)
      return store
    },
  }
}

function task(store: WorkStore, label: string, sessionId = sharedSession) {
  const project = projectSchema.parse({ ...scope, id: `project-${label}`, kind: 'project', title: 'Scoped context',
    purpose: 'Preserve accepted work', status: 'active', successCriteria: ['Keep exact provenance'], resourceRefs: [], planRevision: 1, milestones: [] })
  const conversation = conversationSchema.parse({ ...scope, id: `conversation-${label}`, sessionIds: [sessionId],
    originalDestination: { sourceInstanceId: 'fixture-source', externalDestinationId: `thread-${label}` } })
  const taskId = taskIdSchema.parse(`task-${label}`)
  const attemptId = attemptIdSchema.parse(`attempt-${label}`)
  store.insertProject(project)
  store.insertConversation(conversation)
  const sourceEvent = sourceEventSchema.parse({ ...scope, id: `event-${label}`, sourceInstanceId: 'fixture-source',
    externalEventId: `external-${label}`, externalRevision: '1', actor: { kind: 'person', externalActorId: 'fixture-user' },
    body: { text: `Source for ${label}` }, occurredAt: at, receivedAt: at, threadId: `thread-${label}`, provenance: {} })
  const { state } = success(store.applyCommand({ type: 'work.create', commandId: `create-${label}`,
    conversationId: conversation.id, payload: { projectId: project.id, requestedOutcome: 'Preserve exact evidence.',
      constraints: ['Keep the owner instructions intact.'],
      acceptance: { criteria: ['Validate citation ownership.'], requiresArtifact: true, requiresReceipt: false } } },
  { actor, at, projectId: project.id, conversationId: conversation.id, newTaskId: taskId,
    newAttempt: { id: attemptId, mandate: mandateRefSchema.parse({ ...scope, id: `mandate-${label}`, policyVersion: actor.policyVersion }) } },
  { sourceEvent }))
  return { ref: { ...scope, taskId }, state, sourceEvent, projectId: project.id }
}

function capture(work: ReturnType<typeof task>, compactionId: string, sessionId = sharedSession) {
  return { compactionId, sessionId, attemptId: work.state.attempt.id, generation: work.state.attempt.generation,
    expectedVersion: work.state.task.version, at: later, nativeSeq: 5 }
}

describe('scoped context storage', () => {
  it('captures live task authority, cites only exact work, and enforces session and version fences before commit', () => {
    const f = fixture()
    const work = task(f.store, 'one')
    const foreign = task(f.store, 'other')
    const source = { kind: 'event' as const, eventId: work.sourceEvent.id }
    const input = { ...capture(work, 'compaction-1'), decisions: [{ text: 'Keep this owner decision.', sources: [source] }],
      questions: [{ text: 'What remains unanswered?', sources: [source] }] }
    expect(f.store.listContextBindings(scope, sharedSession).map(item => item.task.id)).toEqual([work.ref.taskId, foreign.ref.taskId])
    expect(f.store.listContextBindings({ ...scope, profileId: profileIdSchema.parse('another-profile') }, sharedSession)).toEqual([])
    expect(f.store.captureContextCheckpoint(work.ref, { ...input, sessionId: unboundSession })).toEqual({ ok: false, code: 'not_found' })
    expect(f.store.captureContextCheckpoint(work.ref, { ...input, expectedVersion: work.state.task.version + 1 }))
      .toEqual({ ok: false, code: 'version_conflict' })
    expect(f.store.captureContextCheckpoint(work.ref, { ...input, generation: 99 })).toEqual({ ok: false, code: 'stale_attempt' })
    expect(f.store.captureContextCheckpoint(work.ref, { ...input, pointers: [{ kind: 'event', eventId: foreign.sourceEvent.id }] }))
      .toEqual({ ok: false, code: 'source_unavailable' })
    const written = success(f.store.captureContextCheckpoint(work.ref, input))
    expect(written.replayed).toBe(false)
    expect(written.checkpoint).toMatchObject({ ...work.ref, projectId: work.projectId, revision: 1,
      objective: work.state.task.requestedOutcome, constraints: work.state.task.constraints, acceptance: work.state.task.acceptance,
      decisions: input.decisions, questions: input.questions, pointers: [{ kind: 'task', taskId: work.ref.taskId }, source] })
    expect(f.store.captureContextCheckpoint(work.ref, { ...input, at: expiry })).toEqual({ ...written, replayed: true })
    expect(f.store.captureContextCheckpoint(work.ref, { ...input, nativeSeq: 6 })).toEqual({ ok: false, code: 'checkpoint_conflict' })
    expect(f.store.getLatestContextCheckpoint(work.ref, unboundSession, later)).toBeUndefined()
    expect(f.store.getLatestContextCheckpoint(foreign.ref, sharedSession, later)).toBeUndefined()
    expect(f.store.getContextSource(work.ref, foreign.sourceEvent.id, later)).toBeUndefined()
    expect(f.store.listContextPointers(work.ref, { kind: 'event', at: later }).items).toEqual([source])
  })

  it('keeps the exact previous checkpoint after a SQLite write failure and retries without a revision gap', () => {
    const f = fixture()
    const work = task(f.store, 'atomic')
    const input = capture(work, 'first')
    const first = success(f.store.captureContextCheckpoint(work.ref, input)).checkpoint
    const second = { ...input, compactionId: 'second', at: expiry }
    f.reopen(`CREATE TRIGGER context_fixture_abort BEFORE INSERT ON context_checkpoints
      WHEN NEW.compaction_id = 'second' BEGIN SELECT RAISE(ABORT, 'fixture write rejected'); END;`)
    expect(() => f.store.captureContextCheckpoint(work.ref, second)).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.getLatestContextCheckpoint(work.ref, sharedSession, expiry)).toEqual(first)
    f.reopen('DROP TRIGGER context_fixture_abort;')
    expect(success(f.store.captureContextCheckpoint(work.ref, second)).checkpoint.revision).toBe(2)
  })

  it('refuses to return a partial session binding list on overflow', () => {
    const { store } = fixture()
    for (let index = 0; index < 16; index++) task(store, `bounded-${index}`)
    expect(store.listContextBindings(scope, sharedSession)).toHaveLength(16)
    task(store, 'over-bound')
    expect(() => store.listContextBindings(scope, sharedSession)).toThrow(expect.objectContaining({ code: 'invalid_input' }))
  })

  it('carries current unresolved wait and removes forgotten source-derived text and artifacts across cold reopen', () => {
    const f = fixture()
    const work = task(f.store, 'forgotten')
    const { state: running } = success(f.store.applyEvent(work.ref, {
      type: 'start', at, expectedVersion: work.state.task.version, attemptId: work.state.attempt.id,
      generation: work.state.attempt.generation, executor: 'fixture', sessionId: privateSession,
    }))
    const artifact = f.store.artifacts.seal(work.ref, { id: 'context-artifact', attemptId: running.attempt.id,
      generation: running.attempt.generation, expectedVersion: running.task.version, mediaType: 'text/plain', visibility: 'private',
      sourceEventIds: [work.sourceEvent.id], bytes: new TextEncoder().encode('A source-derived artifact.') })
    const { state: waiting } = success(f.store.applyEvent(work.ref, { type: 'wait', at, expectedVersion: running.task.version,
      attemptId: running.attempt.id, generation: running.attempt.generation,
      wait: { reason: 'input', referenceId: 'owner-question', resumeCondition: 'Wait for the owner response.' } }))
    expect(f.store.listContextBindings(scope, privateSession).map(item => item.task.id)).toEqual([work.ref.taskId])
    const eventPointer = { kind: 'event' as const, eventId: work.sourceEvent.id }
    const artifactPointer = { kind: 'artifact' as const, artifactId: artifact.artifact.id }
    const input = { ...capture({ ...work, state: waiting }, 'before-forget', privateSession), pointers: [artifactPointer],
      decisions: [{ text: 'Sensitive derived decision.', sources: [artifactPointer] }],
      questions: [{ text: 'Sensitive derived question.', sources: [eventPointer] }] }
    expect(success(f.store.captureContextCheckpoint(work.ref, input)).checkpoint.wait).toEqual(waiting.task.wait)
    expect(f.store.getContextArtifact(work.ref, artifact.artifact.id, later)).toEqual(artifact)
    expect(f.store.excludeContextPointer(work.ref, eventPointer, { kind: 'superseded', at: later })).toMatchObject({ ok: true, replayed: false })
    expect(f.store.excludeContextPointer(work.ref, eventPointer, { kind: 'forgotten', at })).toEqual({ ok: false, code: 'version_conflict' })
    expect(f.store.excludeContextPointer(work.ref, eventPointer, { kind: 'forgotten', at: expiry })).toMatchObject({ ok: true, replayed: false })
    f.reopen()
    expect(f.store.excludeContextPointer(work.ref, eventPointer, { kind: 'superseded', at: expiry }))
      .toMatchObject({ ok: true, replayed: true, exclusion: { kind: 'forgotten' } })
    expect(f.store.isContextExcluded(work.ref, eventPointer)).toBe(true)
    expect(f.store.getContextSource(work.ref, work.sourceEvent.id, expiry)).toBeUndefined()
    expect(f.store.getContextArtifact(work.ref, artifact.artifact.id, expiry)).toBeUndefined()
    expect(f.store.artifacts.read(work.ref, artifact.artifact.id)).toEqual(artifact)
    const visible = f.store.getLatestContextCheckpoint(work.ref, privateSession, expiry)
    expect(visible).toMatchObject({ decisions: [], questions: [], pointers: [{ kind: 'task', taskId: work.ref.taskId }] })
    expect(f.store.captureContextCheckpoint(work.ref, { ...input, at: expiry })).toMatchObject({ ok: true, replayed: true, checkpoint: visible })
    const laterCapture = success(f.store.captureContextCheckpoint(work.ref, {
      ...capture({ ...work, state: waiting }, 'after-forget', privateSession), at: expiry,
    }))
    expect(laterCapture.checkpoint).toMatchObject({ decisions: [], questions: [], pointers: [{ kind: 'task', taskId: work.ref.taskId }] })
  })

  it('recalls only exact routed context with a currently enabled subscription', () => {
    const f = fixture()
    const work = task(f.store, 'routed')
    const foreign = task(f.store, 'routed-foreign')
    const authority = { policyVersion: actor.policyVersion, verifiedAt: at }
    const event = sourceEventSchema.parse({ ...work.sourceEvent, id: 'context-observation', externalEventId: 'external-observation',
      actor: { kind: 'person', externalActorId: 'fixture-user', accountId: 'fixture-account' }, body: { kind: 'event',
        projectId: work.projectId, text: 'A scoped observation.', dataScope: ['fixture'], policyVersion: actor.policyVersion, accountVerifiedAt: at },
      occurredAt: later, receivedAt: later })
    const subscription = { ...work.ref, sourceInstanceId: event.sourceInstanceId, accountId: event.actor.accountId,
      threadId: event.threadId, projectId: work.projectId, mode: 'context', enabled: true, authority, updatedAt: at, expiresAt: expiry }
    success(f.store.putSubscription(subscription))
    const receipt = success(f.store.recordRoutingEvent(event, 'a'.repeat(64), { projectId: work.projectId, authority })).receipt
    const routeRef = { ...scope, eventId: event.id }
    expect(f.store.getContextSource(work.ref, event.id, later)).toBeUndefined()
    success(f.store.setRoutingDisposition(routeRef, receipt.version, { kind: 'context', taskIds: [work.ref.taskId] }))
    expect(f.store.getContextSource(work.ref, event.id, later)).toEqual(event)
    expect(f.store.getContextSource(foreign.ref, event.id, later)).toBeUndefined()
    expect(f.store.getContextSource(work.ref, event.id, expiry)).toBeUndefined()
    const first = f.store.listContextPointers(work.ref, { kind: 'event', at: later, limit: 1 })
    expect(first.items).toEqual([{ kind: 'event', eventId: event.id }])
    expect(f.store.listContextPointers(work.ref, { kind: 'event', at: later, limit: 1, after: first.nextAfter }).items)
      .toEqual([{ kind: 'event', eventId: work.sourceEvent.id }])
    const decision = { text: 'Current route observation.', sources: [{ kind: 'event', eventId: event.id }] }
    const checkpoint = success(f.store.captureContextCheckpoint(work.ref, { ...capture(work, 'routed'), decisions: [decision] })).checkpoint
    expect(checkpoint.decisions).toEqual([decision])
    expect(checkpoint.pointers).toContainEqual({ kind: 'event', eventId: event.id })
    success(f.store.putSubscription({ ...subscription, enabled: false, updatedAt: later }, 1))
    expect(f.store.getContextSource(work.ref, event.id, later)).toBeUndefined()
    expect(f.store.getLatestContextCheckpoint(work.ref, sharedSession, later)?.decisions).toEqual([])
    expect(f.store.getContextSource(foreign.ref, work.sourceEvent.id, later)).toBeUndefined()
  })

  it('retains scoped modern and legacy Worker source fences through revocation and cold reopen', () => {
    const f = fixture()
    const work = task(f.store, 'worker-sources')
    const foreign = task(f.store, 'other-worker-sources')
    const { attempt } = work.state
    const legacy = makeWorkerInput(work.state, privateSession, { cursor: 'legacy', text: 'Old input' }, 'followup')
    const { state: running } = success(f.store.applyWorkerEvent(work.ref, { type: 'start', at,
      expectedVersion: work.state.task.version, attemptId: attempt.id, generation: attempt.generation,
      executor: 'fixture', sessionId: privateSession, worker: { presetId: 'fixture', cwd: '/fixture',
        provider: 'fixture', model: 'test', inputCursor: legacy.cursor, inputHistory: [legacy.cursor] } }, legacy))
    expect(f.store.acknowledgeWorkerInput(work.ref, legacy, at)).toBe(true)

    const authority = { policyVersion: actor.policyVersion, verifiedAt: at }
    const routed = sourceEventSchema.parse({ ...work.sourceEvent, id: 'worker-context-observation', externalEventId: 'worker-context-observation',
      actor: { kind: 'person', externalActorId: 'fixture-user', accountId: 'fixture-account' }, body: { kind: 'event',
        projectId: work.projectId, text: 'Bound observation.', dataScope: ['fixture'], policyVersion: actor.policyVersion, accountVerifiedAt: at },
      occurredAt: later, receivedAt: later })
    const subscription = { ...work.ref, sourceInstanceId: routed.sourceInstanceId, accountId: routed.actor.accountId,
      threadId: routed.threadId, projectId: work.projectId, mode: 'context', enabled: true, authority, updatedAt: at }
    success(f.store.putSubscription(subscription))
    const receipt = success(f.store.recordRoutingEvent(routed, 'a'.repeat(64), { projectId: work.projectId, authority })).receipt
    success(f.store.setRoutingDisposition({ ...scope, eventId: routed.id }, receipt.version, { kind: 'context', taskIds: [work.ref.taskId] }))

    const input = makeWorkerInput(running, privateSession, { cursor: 'modern', text: 'New input' }, 'steer', [routed.id])
    const event = { type: 'record_input', at: later, expectedVersion: running.task.version,
      attemptId: attempt.id, generation: attempt.generation, cursor: input.cursor }
    expect(f.store.applyWorkerEvent(work.ref, event, { ...input, contextSources: [foreign.sourceEvent.id] }))
      .toEqual({ ok: false, code: 'permission_denied' })
    const { state: redirected } = success(f.store.applyWorkerEvent(work.ref, event, input))
    expect(f.store.acknowledgeWorkerInput(work.ref, { ...input, contextSources: [] }, later)).toBe(false)
    expect(f.store.acknowledgeWorkerInput(work.ref, input, later)).toBe(true)

    const workEvent = sourceEventSchema.parse({ ...work.sourceEvent, id: 'legacy-work-source', externalEventId: 'legacy-work-source',
      occurredAt: later, receivedAt: later })
    success(f.store.applyEvent(work.ref, { type: 'wait', at: later, expectedVersion: redirected.task.version,
      attemptId: attempt.id, generation: attempt.generation,
      wait: { reason: 'input', referenceId: 'legacy-question', resumeCondition: 'Receive the owner response.' } }, { sourceEvent: workEvent }))
    success(f.store.putSubscription({ ...subscription, enabled: false, updatedAt: later }, 1))
    success(f.store.excludeContextPointer(work.ref, { kind: 'event', eventId: workEvent.id }, { kind: 'forgotten', at: expiry }))
    f.reopen()
    expect(f.store.workerContextSources(foreign.ref, attempt.id)).toBeUndefined()
    expect(f.store.workerContextSources(work.ref, attempt.id)).toEqual([work.sourceEvent.id, workEvent.id, routed.id].sort())
    expect(f.store.getContextSource(work.ref, routed.id, expiry)).toBeUndefined()
    expect(f.store.getContextSource(work.ref, workEvent.id, expiry)).toBeUndefined()

    const restored = f.store.workerInputs(work.ref, attempt.id).find(row => row.cursor === input.cursor)
    expect(restored?.contextSources).toEqual([routed.id])
    if (!restored) throw new Error('Missing modern input fixture')
    expect(f.store.observeWorkerInput(work.ref, restored, 'cancelled', expiry)).toBe(true)
    expect(f.store.workerContextSources(work.ref, attempt.id)).toEqual([work.sourceEvent.id, workEvent.id].sort())
  })
})
