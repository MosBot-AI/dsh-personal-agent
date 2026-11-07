import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createRecall, type RecallEvidence } from '../../packages/personal-agent/src/context/recall.js'
import {
  artifactIdSchema, attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, ownerIdSchema, profileIdSchema,
  projectSchema, sourceEventSchema, taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import type { WorkState } from '../../packages/personal-agent/src/domain/transitions.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore, type WorkRef } from '../../packages/personal-agent/src/storage/store.js'

const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const owner = { ownerId: ownerIdSchema.parse('recall-owner'), profileId: profileIdSchema.parse('recall-profile') }
const actor = { ...owner, role: 'owner', clientId: clientIdSchema.parse('recall-client'), deviceId: deviceIdSchema.parse('recall-device'),
  policyVersion: 'recall-policy' } as const
const sourceAccount = 'recall-verified-account'
const project = projectSchema.parse({ ...owner, id: 'recall-project', kind: 'project', title: 'Recall fixture',
  purpose: 'Verify scoped recall.', resourceRefs: [], status: 'active', successCriteria: ['Verify evidence.'], planRevision: 1, milestones: [] })

function value<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`Fixture operation failed: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

function fence(state: WorkState) {
  return { at, expectedVersion: state.task.version, attemptId: state.attempt.id, generation: state.attempt.generation }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-recall-'))
  let store = openWorkStore(directory)
  store.insertProject(project)
  const authority = Object.freeze({ actor, destination: 'local-fixture' })
  let allowSource = true
  let allowPrivate = true
  let allowDestination = true
  const seen: RecallEvidence[] = []
  function recall() {
    return createRecall({ store, now: () => at, authorize(token, evidence) {
      seen.push(evidence)
      return token === authority && allowDestination && evidence.scope.ownerId === owner.ownerId
        && evidence.scope.profileId === owner.profileId
        && (evidence.kind !== 'event' || allowSource && (evidence.event.sourceInstanceId === 'dshpa-local-inbox'
          ? evidence.event.actor.deviceId === actor.deviceId : evidence.event.actor.accountId === sourceAccount))
        && (evidence.kind !== 'artifact' || allowPrivate || evidence.artifact.visibility === 'shared')
    } })
  }
  onTestFinished(() => {
    try { store.close() } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  function task(label: string, outcome = 'Task objective for recall.', eventText = 'Linked source fixture.', external = false) {
    const ref = { ...owner, taskId: taskIdSchema.parse(`task-${label}`) }
    const event = sourceEventSchema.parse({ ...owner, id: `event-${label}`, sourceInstanceId: external ? 'recall-external' : 'dshpa-local-inbox',
      externalEventId: `external-${label}`, externalRevision: '1', actor: { kind: 'person', externalActorId: actor.ownerId,
        ...(external ? { accountId: sourceAccount } : { deviceId: actor.deviceId }) },
      occurredAt: at, receivedAt: at, body: { ...(external ? { kind: 'event', text: eventText } : { kind: 'inbox-task', outcome: eventText }),
        providerRaw: 'unprojected-provider-secret' },
      provenance: { description: 'Private adapter metadata' } })
    const state = value(store.applyCommand({ type: 'work.create', commandId: `create-${label}`, payload: {
      projectId: project.id, requestedOutcome: outcome, constraints: [], acceptance: { criteria: ['Verify evidence.'], requiresArtifact: false, requiresReceipt: false },
    } }, { actor, at, projectId: project.id, newTaskId: ref.taskId, newAttempt: {
      id: attemptIdSchema.parse(`attempt-${label}`),
      mandate: mandateRefSchema.parse({ ...owner, id: `mandate-${label}`, policyVersion: actor.policyVersion }),
    } }, { sourceEvent: event })).state
    return { ref, state, event, taskPointer: { kind: 'task', taskId: ref.taskId } as const, eventPointer: { kind: 'event', eventId: event.id } as const }
  }

  function start(ref: WorkRef, state: WorkState) {
    return value(store.applyEvent(ref, { type: 'start', ...fence(state), executor: 'recall-fixture' })).state
  }

  function seal(ref: WorkRef, state: WorkState, label: string, text: string) {
    const artifactId = artifactIdSchema.parse(`artifact-${label}`)
    store.artifacts.seal(ref, { id: artifactId, attemptId: state.attempt.id, generation: state.attempt.generation,
      expectedVersion: state.task.version, sourceEventIds: state.task.provenance.sourceEventIds, visibility: 'private',
      mediaType: 'text/plain', bytes: new TextEncoder().encode(text) })
    return { kind: 'artifact', artifactId } as const
  }

  return { directory, get store() { return store }, recall: recall(), authority, task, start, seal, seen,
    allowSource(allowed: boolean) { allowSource = allowed },
    allowPrivate(allowed: boolean) { allowPrivate = allowed },
    allowDestination(allowed: boolean) { allowDestination = allowed },
    reopen() { store.close(); store = openWorkStore(directory); return recall() },
  }
}

describe('scope-bound context recall', () => {
  it('pages sealed UTF-8 on scalar boundaries and binds cursor to exact scope, ref, version and digest', () => {
    const f = fixture()
    const task = f.task('paging')
    const other = f.task('paging-other')
    const text = '中🙂e文𠮷末 Mixed ABC'.repeat(6)
    const artifact = f.seal(task.ref, f.start(task.ref, task.state), 'utf8', text)
    const request = { ref: artifact, maxBytes: 5 }
    const first = value(f.recall.lookup(task.ref, f.authority, request)).page
    expect(first.text).toBe('中')
    expect(first.digest).toBe(createHash('sha256').update(text).digest('hex'))
    expect(first.totalBytes).toBe(Buffer.byteLength(text))
    expect(first.adjacent.map(item => item.ref)).toContainEqual(task.eventPointer)
    expect(first.nextCursor).toBeDefined()
    const cursor = first.nextCursor!
    const tampered = cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A')
    expect(f.recall.lookup(task.ref, f.authority, { ...request, cursor: tampered })).toEqual({ ok: false, code: 'invalid_cursor' })
    expect(f.recall.lookup(task.ref, f.authority, { ref: task.eventPointer, cursor })).toEqual({ ok: false, code: 'invalid_cursor' })
    expect(f.recall.lookup(other.ref, f.authority, { ...request, cursor })).toEqual({ ok: false, code: 'invalid_cursor' })

    let reconstructed = first.text
    let next = first.nextCursor
    let pages = 1
    while (next && pages++ < 100) {
      const page = value(f.recall.lookup(task.ref, f.authority, { ...request, cursor: next })).page
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(5)
      expect(page.text).not.toContain('�')
      expect(page.adjacent).toEqual([])
      reconstructed += page.text
      next = page.nextCursor
    }
    expect(next).toBeUndefined()
    expect(reconstructed).toBe(text)

    const queued = f.task('stale')
    const previous = value(f.recall.lookup(queued.ref, f.authority, { ref: queued.taskPointer, maxBytes: 5 })).page
    const running = f.start(queued.ref, queued.state)
    const latest = value(f.recall.lookup(queued.ref, f.authority, { ref: queued.taskPointer })).page
    expect(latest.revision).toBe(String(running.task.version))
    expect(latest.digest).toBe(previous.digest)
    expect(f.recall.lookup(queued.ref, f.authority, { ref: queued.taskPointer, cursor: previous.nextCursor })).toEqual({ ok: false, code: 'stale_cursor' })

    const sourcePage = value(f.recall.lookup(task.ref, f.authority, { ref: task.eventPointer, maxBytes: 5 })).page
    const db = new DatabaseSync(join(f.directory, DATABASE_FILENAME))
    try {
      // Simulate changed backing bytes with an unchanged external revision.
      db.prepare("UPDATE source_events SET record = json_set(record, '$.body.outcome', ?) WHERE id = ?")
        .run('Replaced source fixture text.', task.event.id)
    } finally { db.close() }
    const newSource = value(f.recall.lookup(task.ref, f.authority, { ref: task.eventPointer })).page
    expect(newSource.revision).toBe(sourcePage.revision)
    expect(newSource.digest).not.toBe(sourcePage.digest)
    expect(f.recall.lookup(task.ref, f.authority, { ref: task.eventPointer, cursor: sourcePage.nextCursor })).toEqual({ ok: false, code: 'stale_cursor' })
  })

  it('searches only linked authorized candidates with NFKC matching in Chinese and English', () => {
    const f = fixture()
    const task = f.task('linked', 'Authoritative outcome', '中文 ＡＢＣ search input')
    const other = f.task('other', 'Different task', '中文 abc search input unreachable')
    const state = f.start(task.ref, task.state)
    const artifact = f.seal(task.ref, state, 'linked', '中文 abc sealed result')
    f.seal(other.ref, f.start(other.ref, other.state), 'other', '中文 abc unlinked sealed result')
    const search = { query: '中文 AbＣ' }
    expect(value(f.recall.search(task.ref, f.authority, search)).hits.map(hit => hit.ref)).toEqual([task.eventPointer, artifact])
    expect(value(f.recall.search(task.ref, f.authority, { query: 'unprojected-provider-secret' })).hits).toEqual([])
    expect(value(f.recall.search(task.ref, f.authority, { query: 'Private adapter metadata' })).hits).toEqual([])
    expect(f.recall.lookup(task.ref, f.authority, { ref: other.eventPointer })).toEqual({ ok: false, code: 'source_unavailable' })
    expect(f.recall.lookup(task.ref, f.authority, { ref: other.taskPointer })).toEqual({ ok: false, code: 'permission_denied' })
    expect(f.recall.lookup(task.ref, f.authority, { ref: { kind: 'path', path: '../../private' } })).toEqual({ ok: false, code: 'invalid_input' })
    expect(f.recall.lookup(task.ref, f.authority, { ref: task.eventPointer, path: '../../private' })).toEqual({ ok: false, code: 'invalid_input' })
    f.allowPrivate(false)
    expect(value(f.recall.search(task.ref, f.authority, search)).hits.map(hit => hit.ref)).toEqual([task.eventPointer])
    expect(value(f.recall.lookup(task.ref, f.authority, { ref: task.taskPointer })).page.adjacent.map(item => item.ref)).not.toContainEqual(artifact)
  })

  it('rechecks actor, route and transitive source authority on each page and fences persisted exclusions on restart', () => {
    const f = fixture()
    const task = f.task('revoked', 'Objective from authenticated source', '中文 input that can be forgotten', true)
    const artifact = f.seal(task.ref, f.start(task.ref, task.state), 'revoked', '中文 text with sealed source provenance')
    const input = { ref: artifact, maxBytes: 5 }
    const page = value(f.recall.lookup(task.ref, f.authority, input)).page
    expect(page.nextCursor).toBeDefined()
    expect(f.seen).toContainEqual(expect.objectContaining({ kind: 'event', event: expect.objectContaining({
      actor: expect.objectContaining({ accountId: sourceAccount }), sourceInstanceId: 'recall-external',
    }) }))
    const next = { ...input, cursor: page.nextCursor }
    expect(f.recall.lookup(task.ref, {}, next)).toEqual({ ok: false, code: 'permission_denied' })
    f.allowDestination(false)
    expect(f.recall.lookup(task.ref, f.authority, next)).toEqual({ ok: false, code: 'permission_denied' })
    f.allowDestination(true)
    f.allowSource(false)
    expect(f.recall.lookup(task.ref, f.authority, next)).toEqual({ ok: false, code: 'permission_denied' })
    expect(value(f.recall.search(task.ref, f.authority, { query: '中文' })).hits).toEqual([])
    f.allowSource(true)
    expect(f.recall.lookup(task.ref, f.authority, next).ok).toBe(true)
    f.store.excludeContextPointer(task.ref, task.eventPointer, { kind: 'forgotten', at })
    const reopened = f.reopen()
    expect(reopened.lookup(task.ref, f.authority, next)).toEqual({ ok: false, code: 'invalid_cursor' })
    expect(reopened.lookup(task.ref, f.authority, { ref: task.eventPointer })).toEqual({ ok: false, code: 'source_unavailable' })
    expect(reopened.lookup(task.ref, f.authority, { ref: artifact })).toEqual({ ok: false, code: 'source_unavailable' })
    expect(value(reopened.search(task.ref, f.authority, { query: '中文' })).hits).toEqual([])
  })
})
