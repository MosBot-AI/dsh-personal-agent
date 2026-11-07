import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryAccess, MemoryActiveRecord, MemoryRecord, ProviderPin } from '@mosbot-ai/dshpa-plugin-api'
import { describe, expect, it, onTestFinished } from 'vitest'
import { attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, ownerIdSchema, profileIdSchema,
  projectSchema, taskIdSchema, utcInstantSchema } from '../../packages/personal-agent/src/domain/model.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { memoryRecordProof, memoryValueDigest, type MemoryLedgerRecord } from '../../packages/personal-agent/src/storage/memory.js'
import { restoreWorkStoreBackup } from '../../packages/personal-agent/src/storage/restore.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'

const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const later = utcInstantSchema.parse('2026-11-07T08:00:00.010Z')
const actor = { ownerId: ownerIdSchema.parse('memory-owner'), profileId: profileIdSchema.parse('memory-profile'),
  clientId: clientIdSchema.parse('memory-client'), deviceId: deviceIdSchema.parse('memory-device'),
  role: 'owner', verifiedAt: utcInstantSchema.parse('2026-11-01T00:00:00.000Z'), policyVersion: 'memory-policy' } as const
const profile: MemoryAccess = { ownerId: actor.ownerId, profileId: actor.profileId, scope: { kind: 'profile' } }
const pin: ProviderPin<'memory'> = { kind: 'memory', instanceId: 'local-memory', pluginId: 'memory-fixture', pluginVersion: '1.0.0', configRevision: 1 }
const switched = { ...pin, configRevision: 2 }
const privateText = 'Private ledger fixture: 蓝色偏好。'
const originalValue = { kind: 'fact', text: privateText } as const
const correctedValue = { kind: 'fact', text: 'Corrected private preference.' } as const

function success<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`Memory fixture failed: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dshpa-memory-ledger-'))
  const directory = join(root, 'work')
  let store = openWorkStore(directory)
  onTestFinished(() => { try { store.close() } finally { rmSync(root, { recursive: true, force: true }) } })
  return { root, directory, get store() { return store }, reopen() { store.close(); store = openWorkStore(directory) },
    sql<T>(fn: (db: DatabaseSync) => T): T {
      const db = new DatabaseSync(join(directory, DATABASE_FILENAME))
      try { return fn(db) } finally { db.close() }
    } }
}

function asActive(metadata: MemoryLedgerRecord, value: MemoryActiveRecord['value']): MemoryActiveRecord {
  return { ...metadata.access, id: metadata.id, revision: metadata.revision, sourceEventIds: metadata.sourceEventIds,
    validFrom: metadata.validFrom, validUntil: metadata.validUntil, origin: metadata.origin, confidence: metadata.confidence, state: 'active', value }
}

function request(access: MemoryAccess, commandId: string, value = originalValue) {
  return { access, commandId, pin, at, kind: 'remember', digest: memoryValueDigest(value) } as const
}

describe('core personal memory ledger', () => {
  it('reserves only exact authenticated scopes, binds synthetic provenance and replays without storing values', () => {
    const f = fixture()
    const project = projectSchema.parse({ ownerId: actor.ownerId, profileId: actor.profileId, id: 'memory-project', kind: 'project', title: 'Memory fixture',
      purpose: 'Prove memory scope.', resourceRefs: [], status: 'active', successCriteria: ['Keep scopes distinct.'], planRevision: 1, milestones: [] })
    f.store.insertProject(project)
    const taskId = taskIdSchema.parse('memory-task')
    success(f.store.applyCommand({ type: 'work.create', commandId: 'new-task', payload: { projectId: project.id,
      requestedOutcome: 'Create a scoped task.', constraints: [], acceptance: { criteria: ['Prove scope'], requiresArtifact: false, requiresReceipt: false } },
    }, { actor, at, projectId: project.id, newTaskId: taskId, newAttempt: {
      id: attemptIdSchema.parse('memory-attempt'), mandate: mandateRefSchema.parse({ ownerId: actor.ownerId, profileId: actor.profileId,
        id: 'memory-mandate', policyVersion: actor.policyVersion }),
    } }))
    const projectAccess = { ...profile, scope: { kind: 'project', projectId: project.id } } as const
    const taskAccess = { ...profile, scope: { kind: 'task', taskId } } as const
    expect(f.store.hasMemoryScope(projectAccess)).toBe(true)
    expect(f.store.hasMemoryScope(taskAccess)).toBe(true)
    expect(f.store.hasMemoryScope({ ...taskAccess, ownerId: 'unrelated-owner' })).toBe(false)
    expect(f.store.hasMemoryScope({ ...projectAccess, profileId: 'unrelated-profile' })).toBe(false)
    expect(f.store.reserveMemoryCommand(actor, request({ ...taskAccess, profileId: 'unrelated-profile' }, 'wrong-scope')))
      .toEqual({ ok: false, code: 'permission_denied' })

    const input = { ...request(taskAccess, 'remember-one'), validUntil: later }
    const reserved = success(f.store.reserveMemoryCommand(actor, input))
    const proposed = reserved.receipt.proposed!
    expect(reserved).toMatchObject({ replayed: false, receipt: { status: 'pending', pin, at, proposed: { state: 'pending', validUntil: later } } })
    expect(f.store.getMemoryRecord(taskAccess, proposed.id)).toEqual(proposed)
    expect(f.store.listMemoryRecords(taskAccess).items).toEqual([])
    expect(f.store.getMemoryRecord(projectAccess, proposed.id)).toBeUndefined()
    expect(f.store.getMemorySource(taskAccess, proposed.sourceEventIds[0]!)).toMatchObject({ access: taskAccess,
      clientId: actor.clientId, deviceId: actor.deviceId, verifiedAt: actor.verifiedAt, policyVersion: actor.policyVersion, at })
    expect(f.store.hasMemorySource(projectAccess, proposed.sourceEventIds[0]!)).toBe(false)
    expect(f.sql(db => db.prepare('SELECT count(*) AS count FROM source_events').get()?.count)).toBe(0)

    const proof = memoryRecordProof(asActive(proposed, originalValue))
    const finish = { access: taskAccess, commandId: input.commandId, pin, proofs: [proof] }
    expect(f.store.finishMemoryCommand(actor, { ...finish, pin: switched })).toEqual({ ok: false, code: 'conflict' })
    expect(f.store.finishMemoryCommand(actor, { ...finish, proofs: [{ ...proof, sourceEventIds: ['forged-source'] }] }))
      .toEqual({ ok: false, code: 'invalid_result' })
    expect(f.store.finishMemoryCommand(actor, { ...finish, proofs: [{ ...proof, digest: 'a'.repeat(64) }] }))
      .toEqual({ ok: false, code: 'invalid_result' })
    expect(f.store.finishMemoryCommand(actor, { ...finish, proofs: [{ ...proof, validUntil: undefined }] }))
      .toEqual({ ok: false, code: 'invalid_result' })
    expect(f.store.finishMemoryCommand(actor, finish)).toMatchObject({ ok: true, replayed: false, receipt: { status: 'completed' } })
    expect(f.store.listMemoryRecords(taskAccess).items).toEqual([{ ...proposed, state: 'active' }])

    f.reopen()
    expect(f.store.reserveMemoryCommand(actor, { ...input, at: later })).toMatchObject({ ok: true, replayed: true,
      receipt: { status: 'completed', at, proposed } })
    expect(f.store.finishMemoryCommand(actor, finish)).toMatchObject({ ok: true, replayed: true, receipt: { status: 'completed' } })
    expect(f.store.reserveMemoryCommand(actor, { ...input, validUntil: undefined })).toEqual({ ok: false, code: 'conflict' })
    expect(f.store.reserveMemoryCommand(actor, { ...input, pin: switched })).toEqual({ ok: false, code: 'conflict' })
    expect(f.store.reserveMemoryCommand({ ...actor, verifiedAt: at }, input)).toEqual({ ok: false, code: 'conflict' })
    const second = success(f.store.reserveMemoryCommand(actor, { ...request(taskAccess, 'remember-two'), at: later })).receipt.proposed!
    success(f.store.finishMemoryCommand(actor, { access: taskAccess, commandId: 'remember-two', pin,
      proofs: [memoryRecordProof(asActive(second, originalValue))] }))
    const firstPage = f.store.listMemoryRecords(taskAccess, { limit: 1 })
    expect(firstPage.items.map(record => record.id)).toEqual([second.id])
    expect(firstPage.nextAfter).toBeDefined()
    expect(f.store.listMemoryRecords(taskAccess, { limit: 1, after: firstPage.nextAfter }).items.map(record => record.id))
      .toEqual([proposed.id])
    const raw = f.sql(db => ['memory_ledger', 'memory_commands', 'memory_sources'].map(table => db.prepare(`SELECT * FROM ${table}`).all()))
    expect(JSON.stringify(raw)).not.toContain(privateText)
  })

  it('hides old memory before correction and deletion, even across restart, and accepts only exact final proof', () => {
    const f = fixture()
    const initial = success(f.store.reserveMemoryCommand(actor, request(profile, 'initial'))).receipt.proposed!
    const original = asActive(initial, originalValue)
    success(f.store.finishMemoryCommand(actor, { access: profile, commandId: 'initial', pin, proofs: [memoryRecordProof(original)] }))
    const correction = { ...request(profile, 'correct'), kind: 'correct', recordId: original.id, expectedRevision: 1,
      digest: memoryValueDigest(correctedValue) } as const
    const pending = success(f.store.reserveMemoryCommand(actor, correction)).receipt
    expect(pending.at).toBe('2026-11-07T08:00:00.001Z')
    expect(pending.previous).toMatchObject({ id: original.id, revision: 1, state: 'active' })
    const replacement = asActive(pending.proposed!, correctedValue)
    expect(f.store.getMemoryRecord(profile, original.id)).toMatchObject({ state: 'superseded', revision: 2,
      supersededBy: replacement.id, validUntil: pending.at })
    expect(f.store.getMemoryRecord(profile, replacement.id)?.state).toBe('pending')
    expect(f.store.listMemoryRecords(profile).items).toEqual([])
    expect(f.store.reserveMemoryCommand(actor, { access: profile, pin, at: later, kind: 'forget', commandId: 'concurrent',
      recordId: original.id, expectedRevision: 2 })).toEqual({ ok: false, code: 'busy' })
    f.reopen()
    expect(f.store.reserveMemoryCommand(actor, { ...correction, at: later, pin: switched })).toEqual({ ok: false, code: 'conflict' })
    expect(success(f.store.reserveMemoryCommand(actor, { ...correction, at: later })).receipt).toEqual(pending)
    expect(f.store.listMemoryRecords(profile).items).toEqual([])
    const superseded: MemoryRecord = { ...original, state: 'superseded', revision: 2, validUntil: pending.at, supersededBy: replacement.id }
    const done = { access: profile, pin, commandId: correction.commandId, proofs: [memoryRecordProof(superseded), memoryRecordProof(replacement)] }
    expect(f.store.finishMemoryCommand(actor, { ...done, proofs: [memoryRecordProof(replacement)] }))
      .toEqual({ ok: false, code: 'invalid_result' })
    f.sql(db => db.exec(`CREATE TRIGGER fixture_reject_completion BEFORE UPDATE ON memory_commands
      WHEN (NEW.receipt ->> '$.status') = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture late completion rollback'); END`))
    expect(() => f.store.finishMemoryCommand(actor, done)).toThrow()
    expect(f.store.getMemoryRecord(profile, replacement.id)?.state).toBe('pending')
    expect(f.store.listMemoryRecords(profile).items).toEqual([])
    expect(success(f.store.reserveMemoryCommand(actor, { ...correction, at: later })).receipt.status).toBe('pending')
    f.sql(db => db.exec('DROP TRIGGER fixture_reject_completion'))
    success(f.store.finishMemoryCommand(actor, done))
    expect(f.store.listMemoryRecords(profile).items.map(record => record.id)).toEqual([replacement.id])

    const forget = { access: profile, pin: switched, at: later, commandId: 'forget-superseded', kind: 'forget',
      recordId: original.id, expectedRevision: 2 } as const
    success(f.store.reserveMemoryCommand(actor, forget))
    expect(f.store.getMemoryRecord(profile, original.id)).toMatchObject({ state: 'forgotten', revision: 3, forgottenAt: later, digest: undefined })
    f.reopen()
    const { value: _value, supersededBy: _supersededBy, ...historical } = superseded
    const tombstone: MemoryRecord = { ...historical, state: 'forgotten', revision: 3, forgottenAt: later }
    const finish = { access: profile, pin: switched, commandId: forget.commandId, proofs: [memoryRecordProof(tombstone)] }
    expect(f.store.finishMemoryCommand(actor, { ...finish, proofs: [{ ...finish.proofs[0], forgottenAt: at }] }))
      .toEqual({ ok: false, code: 'invalid_result' })
    success(f.store.finishMemoryCommand(actor, finish))
    expect(f.store.getMemoryRecord(profile, original.id)?.state).toBe('forgotten')
    expect(f.store.listMemoryRecords(profile).items.map(record => record.id)).toEqual([replacement.id])
    expect(f.store.reserveMemoryCommand(actor, { ...forget, commandId: 'stale-forget', expectedRevision: 2 }))
      .toEqual({ ok: false, code: 'version_conflict' })
  })

  it('rolls back a late correction failure atomically and keeps restored memory inert', async () => {
    const f = fixture()
    const initial = success(f.store.reserveMemoryCommand(actor, request(profile, 'before-failure'))).receipt.proposed!
    success(f.store.finishMemoryCommand(actor, { access: profile, pin, commandId: 'before-failure',
      proofs: [memoryRecordProof(asActive(initial, originalValue))] }))
    const correction = { ...request(profile, 'late-failure'), kind: 'correct', recordId: initial.id, expectedRevision: 1,
      digest: memoryValueDigest(correctedValue) }
    const sizes = () => f.sql(db => ['memory_ledger', 'memory_commands', 'memory_sources'].map(table => db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count))
    const before = sizes()
    f.sql(db => db.exec("CREATE TRIGGER fixture_reject_correction BEFORE UPDATE ON memory_ledger WHEN NEW.state = 'superseded' BEGIN SELECT RAISE(ABORT, 'fixture late rollback'); END"))
    expect(() => f.store.reserveMemoryCommand(actor, correction)).toThrow()
    expect(sizes()).toEqual(before)
    expect(f.store.getMemoryRecord(profile, initial.id)?.state).toBe('active')
    f.sql(db => db.exec('DROP TRIGGER fixture_reject_correction'))
    const pending = success(f.store.reserveMemoryCommand(actor, correction)).receipt
    expect(f.store.listMemoryRecords(profile).items).toEqual([])

    const backup = await f.store.createBackup(join(f.root, 'backups'))
    const destination = join(f.root, 'restored')
    restoreWorkStoreBackup(backup.path, destination)
    const restored = openWorkStore(destination)
    try {
      expect(restored.recoveryMode()).toBe('restore')
      expect(restored.getMemoryRecord(profile, initial.id)?.state).toBe('superseded')
      expect(restored.getMemoryRecord(profile, pending.proposed!.id)?.state).toBe('pending')
      expect(restored.listMemoryRecords(profile).items).toEqual([])
      expect(restored.reserveMemoryCommand(actor, correction)).toEqual({ ok: false, code: 'recovery_required' })
      expect(restored.reserveMemoryCommand(actor, request(profile, 'new-in-restore'))).toEqual({ ok: false, code: 'recovery_required' })
      expect(restored.finishMemoryCommand(actor, { access: profile, pin, commandId: correction.commandId,
        proofs: [memoryRecordProof(asActive(pending.proposed!, correctedValue))] })).toEqual({ ok: false, code: 'recovery_required' })
    } finally { restored.close() }
  })
})
