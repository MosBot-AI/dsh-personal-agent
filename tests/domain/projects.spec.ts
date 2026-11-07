import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import { attemptIdSchema, mandateRefSchema, profileSchema, projectIdSchema, taskIdSchema, utcInstantSchema } from '../../packages/personal-agent/src/domain/model.js'
import type { InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { createInboxService } from '../../packages/personal-agent/src/inbox/service.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'

const time = utcInstantSchema.parse('2026-11-08T03:00:00.000Z')
const profile = profileSchema.parse({ ownerId: 'plan-owner', id: 'plan-profile', verifiedAccounts: [], policyVersion: 'plan-policy',
  verifiedDevices: [{ deviceId: 'plan-device', verifiedAt: time }] })
const draft = { title: 'A goal', purpose: 'Finish a sourced result.', successCriteria: ['Verify the result.'], priority: 'normal',
  milestones: [{ title: 'First review', deadline: { at: '2026-11-09T00:00:00.000Z', timeZone: 'UTC' } }],
  reviewCadence: { intervalDays: 7, timeZone: 'UTC' } } as const

function updated(response: InboxResponse) {
  assert.ok(response.ok && response.kind === 'updated', JSON.stringify(response))
  return response
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-plan-'))
  const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
  const token = identity.bindOwner({ ownerId: profile.ownerId, profileId: profile.id, deviceId: 'plan-device',
    clientId: 'plan-client', sessionId: 'plan-session' })
  const owner = identity.resolveOwner(token)
  assert.ok(owner)
  let store = openWorkStore(directory)
  const inbox = () => createInboxService({ store, identity, resolveSession: id => id === 'plan-primary', now: () => time })
  let service = inbox()
  onTestFinished(() => { try { store.close() } finally { rmSync(directory, { recursive: true, force: true }) } })
  return { owner, get store() { return store }, request: (request: unknown) => service.handle(token, request),
    reopen(legacyTaskId?: string) {
      store.close()
      if (legacyTaskId) {
        const db = new DatabaseSync(join(directory, DATABASE_FILENAME))
        try { db.prepare('DELETE FROM task_prerequisites WHERE task_id = ?').run(legacyTaskId) }
        finally { db.close() }
      }
      store = openWorkStore(directory)
      service = inbox()
    } }
}

describe('goal plan and prerequisite contracts', () => {
  it('retains a sourced revision history across restart and keeps create replay stable after plan edits', async () => {
    const f = fixture()
    const create = { type: 'create_project', commandId: 'legacy', title: 'Earlier project', purpose: 'Keep the creation identity.' }
    const projectId = updated(await f.request(create)).projectId
    assert.ok(projectId)
    const edit = { type: 'save_plan', projectId, expectedRevision: 1, commandId: 'plan-edit', draft, rationale: 'Owner revised the outcome.' }
    expect(updated(await f.request(edit)).projectId).toBe(projectId)
    expect(updated(await f.request(create)).projectId).toBe(projectId)
    expect(updated(await f.request(edit)).projectId).toBe(projectId)
    expect(await f.request({ ...edit, rationale: 'Changed replay' })).toEqual({ ok: false, code: 'command_conflict' })
    expect(await f.request({ ...edit, commandId: 'stale' })).toEqual({ ok: false, code: 'version_conflict' })
    f.reopen()
    expect(await f.request({ type: 'project_plan', projectId })).toMatchObject({
      plan: { kind: 'project', revision: 2, draft, history: [
        { revision: 2, rationale: edit.rationale, draft },
        { revision: 1, draft: { title: create.title } },
      ] },
    })
    const goal = updated(await f.request({ type: 'save_plan', commandId: 'goal', draft, rationale: 'Record a new goal.' }))
    expect(await f.request({ type: 'project_plan', projectId: goal.projectId })).toMatchObject({ plan: { kind: 'goal', revision: 1 } })
    expect(await f.request({ type: 'project_review' })).toMatchObject({ ok: true, kind: 'project_review', projects: expect.any(Array) })
  })

  it('rejects cross-project edges and cycles, and reblocks queued dependents when a prerequisite is reopened', async () => {
    const f = fixture()
    const create = async (label: string) => projectIdSchema.parse(updated(await f.request({
      type: 'create_project', commandId: label, title: label, purpose: 'Review exact work.',
    })).projectId)
    const projectId = await create('project')
    const foreignId = await create('foreign')
    const task = async (label: string, project = projectId) => ({ ...f.owner, taskId: taskIdSchema.parse(updated(await f.request({
      type: 'create_task', commandId: label.replaceAll(' ', '-'), projectId: project, sessionId: 'plan-primary', outcome: label,
    })).taskId) })
    const first = await task('First result')
    const second = await task('Second result')
    const third = await task('Third result')
    const foreign = await task('Foreign result', foreignId)
    const state = (ref: typeof first) => {
      const item = f.store.getWork(ref)
      assert.ok(item)
      return item
    }
    const fence = (ref: typeof first) => {
      const work = state(ref)
      return { at: time, expectedVersion: work.task.version, generation: work.attempt.generation, attemptId: work.attempt.id }
    }
    const link = (target: typeof first, predecessor: typeof first) => f.store.setTaskPrerequisites(
      target, state(target).task.version, time, [predecessor.taskId])
    expect(link(second, foreign)).toEqual({ ok: false, code: 'not_found' })
    expect(link(second, first)).toMatchObject({ ok: true, state: { task: { status: 'blocked' } } })
    expect(link(third, second)).toMatchObject({ ok: true })
    expect(link(first, third)).toEqual({ ok: false, code: 'condition_unmet' })
    expect(f.store.getTaskPrerequisites(first)).toEqual([])
    f.reopen(second.taskId)
    expect(state(second).task.wait?.referenceId).toBe(first.taskId)
    expect(f.store.applyEvent(second, { type: 'start', executor: 'fixture', ...fence(second) })).toMatchObject({ ok: false })
    expect(f.store.applyEvent(first, { type: 'start', executor: 'fixture', ...fence(first) })).toMatchObject({ ok: true })
    const running = state(first)
    const artifact = f.store.artifacts.seal(first, { id: 'verified-fixture', attemptId: running.attempt.id,
      generation: running.attempt.generation, expectedVersion: running.task.version, mediaType: 'text/plain', visibility: 'private',
      sourceEventIds: running.task.provenance.sourceEventIds, bytes: new TextEncoder().encode('Verified first result.') })
    expect(f.store.applyEvent(first, { type: 'ready', artifactIds: [artifact.artifact.id], ...fence(first) })).toMatchObject({ ok: true })
    const verification = f.store.createVerifier({ now: () => time, check: ({ state: candidate }) =>
      candidate.task.acceptance.criteria.map(criterion => ({ criterion, satisfied: true, evidence: 'Fixture verified the sealed result.' })) })
    expect(await verification.verify(first, { expectedVersion: state(first).task.version })).toMatchObject({ ok: true })
    expect(state(second).task.status).toBe('queued')
    expect(state(third).task.status).toBe('blocked')
    expect(f.store.applyCommand({ type: 'work.reopen', taskId: first.taskId, commandId: 'reopen-first',
      expectedVersion: state(first).task.version, payload: {} }, { actor: f.owner, at: time,
      newAttempt: { id: attemptIdSchema.parse('reopened-plan-attempt'), mandate: mandateRefSchema.parse({
        ownerId: f.owner.ownerId, profileId: f.owner.profileId, id: 'reopened-plan-mandate', policyVersion: f.owner.policyVersion,
      }) } })).toMatchObject({ ok: true })
    expect(state(second).task.status).toBe('blocked')
  })
})
