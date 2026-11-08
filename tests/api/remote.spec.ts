import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished } from 'vitest'
import {
  attemptIdSchema, clientIdSchema, conversationSchema, deviceIdSchema, mandateRefSchema,
  ownerIdSchema, profileIdSchema, profileSchema, projectSchema, taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { restoreWorkStoreBackup } from '../../packages/personal-agent/src/storage/restore.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const scope = { ownerId: ownerIdSchema.parse('owner'), profileId: profileIdSchema.parse('profile') }
const other = { ...scope, profileId: profileIdSchema.parse('other-profile') }
const instant = '2026-11-08T14:50:00.000Z'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dshpa-mobile-'))
  const directory = join(root, 'work')
  let store = openWorkStore(directory)
  let clock = utcInstantSchema.parse(instant)
  onTestFinished(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root, directory,
    get store() { return store },
    get ledger() { return store.mobileDevices(scope, () => clock) },
    get feed() { return store.mobileFeed(scope, () => clock) },
    get foreignLedger() { return store.mobileDevices(other, () => clock) },
    advance(ms: number) { clock = utcInstantSchema.parse(new Date(Date.parse(clock) + ms).toISOString()) },
    reopen() { store.close(); store = openWorkStore(directory) },
    reopenAsV14() {
      store.close()
      const db = new DatabaseSync(join(directory, DATABASE_FILENAME))
      try { db.exec('DROP TABLE mobile_approval_reviews; PRAGMA user_version = 14') }
      finally { db.close() }
      store = openWorkStore(directory)
    },
  }
}

function requireSuccess<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error('Expected mobile enrollment success')
  return result as Extract<T, { ok: true }>
}

it('exchanges a scoped pairing code once and persists only digests of device secrets', () => {
  const f = fixture()
  const pair = requireSuccess(f.ledger.begin('Phone'))
  expect(f.foreignLedger.enroll(pair.pairingCode)).toEqual({ ok: false, code: 'invalid_pairing' })
  expect(f.ledger.authenticate(pair.pairingCode)).toBeUndefined()
  f.reopen()
  const result = requireSuccess(f.ledger.enroll(pair.pairingCode))
  expect(result.device).toMatchObject({ deviceId: pair.deviceId, label: 'Phone', state: 'active', enrolledAt: instant })
  expect(result.credential).not.toBe(pair.pairingCode)
  expect(f.ledger.enroll(pair.pairingCode)).toEqual({ ok: false, code: 'invalid_pairing' })
  expect(f.foreignLedger.authenticate(result.credential)).toBeUndefined()
  expect(f.ledger.list()).toEqual([result.device])

  const reader = new DatabaseSync(join(f.directory, DATABASE_FILENAME), { readOnly: true })
  try {
    const saved = reader.prepare('SELECT secret_hash FROM mobile_devices').get()
    expect(saved?.secret_hash).toMatch(/^[a-f\d]{64}$/u)
    expect(JSON.stringify(saved)).not.toContain(pair.pairingCode)
    expect(JSON.stringify(saved)).not.toContain(result.credential)
  } finally { reader.close() }
  f.reopen()
  expect(f.ledger.authenticate(result.credential)).toEqual(result.device)
})

it('fences an already bound identity and blocks device or pairing credentials after revocation', () => {
  const f = fixture()
  const pair = requireSuccess(f.ledger.begin('Phone'))
  const pending = requireSuccess(f.ledger.begin('Unused invitation'))
  const result = requireSuccess(f.ledger.enroll(pair.pairingCode))
  const identity = createIdentityBoundary(profileId => profileId === scope.profileId ? profileSchema.parse({
    ownerId: scope.ownerId, id: profileId, verifiedDevices: f.ledger.verifiedDevices(), verifiedAccounts: [], policyVersion: 'test',
  }) : undefined)
  const owner = identity.bindOwner({ ...scope, deviceId: pair.deviceId, clientId: 'mobile', sessionId: 'mobile-phone' })
  expect(identity.resolveOwner(owner)?.deviceId).toBe(pair.deviceId)
  expect(f.foreignLedger.revoke(pair.deviceId)).toBe(false)
  expect(f.ledger.revoke(pending.deviceId)).toBe(true)
  expect(f.ledger.revoke(pair.deviceId)).toBe(true)
  expect(identity.resolveOwner(owner)).toBeUndefined()
  expect(f.ledger.enroll(pending.pairingCode)).toEqual({ ok: false, code: 'invalid_pairing' })
  f.reopen()
  expect(f.ledger.authenticate(result.credential)).toBeUndefined()
  expect(f.ledger.revoke(pair.deviceId)).toBe(false)
})

it('expires pairing codes and active devices and bounds pending enrollment', () => {
  const f = fixture()
  const pair = requireSuccess(f.ledger.begin('First phone'))
  for (const label of ['Second', 'Third', 'Fourth']) requireSuccess(f.ledger.begin(label))
  expect(f.ledger.begin('Fifth')).toEqual({ ok: false, code: 'capacity' })
  f.advance(5 * 60_000)
  expect(f.ledger.enroll(pair.pairingCode)).toEqual({ ok: false, code: 'invalid_pairing' })
  const next = requireSuccess(f.ledger.begin('Phone'))
  const result = requireSuccess(f.ledger.enroll(next.pairingCode))
  expect(f.ledger.authenticate(result.credential)?.deviceId).toBe(next.deviceId)
  f.advance(30 * 24 * 60 * 60_000)
  expect(f.ledger.authenticate(result.credential)).toBeUndefined()
  expect(f.ledger.verifiedDevices()).toEqual([])
})

it('preserves a v14 device credential when upgrading to the approval schema', () => {
  const f = fixture()
  const pair = requireSuccess(f.ledger.begin('Phone'))
  const enrolled = requireSuccess(f.ledger.enroll(pair.pairingCode))
  f.reopenAsV14()
  expect(f.ledger.authenticate(enrolled.credential)).toEqual(enrolled.device)
  const db = new DatabaseSync(join(f.directory, DATABASE_FILENAME), { readOnly: true })
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(15)
    expect(db.prepare('SELECT count(*) AS count FROM mobile_approval_reviews').get()?.count).toBe(0)
  } finally { db.close() }
})

it('clears both prior device credentials and pairing codes on backup restore', async () => {
  const f = fixture()
  const pair = requireSuccess(f.ledger.begin('Phone'))
  const result = requireSuccess(f.ledger.enroll(pair.pairingCode))
  const pending = requireSuccess(f.ledger.begin('Pending phone'))
  const backup = await f.store.createBackup(join(f.root, 'backups'))
  expect(f.ledger.revoke(pair.deviceId)).toBe(true)
  const restoredPath = join(f.root, 'restored')
  restoreWorkStoreBackup(backup.path, restoredPath)
  const restored = openWorkStore(restoredPath)
  try {
    const ledger = restored.mobileDevices(scope, () => utcInstantSchema.parse(instant))
    expect(restored.recoveryMode()).toBe('restore')
    expect(ledger.list()).toEqual([])
    expect(ledger.authenticate(result.credential)).toBeUndefined()
    expect(ledger.enroll(pending.pairingCode)).toEqual({ ok: false, code: 'invalid_pairing' })
    expect(ledger.begin('New phone')).toEqual({ ok: false, code: 'recovery_required' })
  } finally { restored.close() }
})


function seedWork(store: WorkStore, owner = scope, label = 'primary') {
  const project = projectSchema.parse({
    ...owner, id: 'project-' + label, kind: 'project', title: 'Mobile access', purpose: 'Exercise scoped work.',
    resourceRefs: ['private-project-path'], status: 'active', successCriteria: ['Verify the task'], planRevision: 1, milestones: [],
  })
  const conversation = conversationSchema.parse({
    ...owner, id: 'thread-' + label, sessionIds: [],
    originalDestination: { sourceInstanceId: 'original-source', externalDestinationId: 'private-origin' },
  })
  store.insertProject(project)
  store.insertConversation(conversation)
  const actor = {
    ...owner, role: 'owner' as const, deviceId: deviceIdSchema.parse('local-device'),
    clientId: clientIdSchema.parse('local-web'), policyVersion: 'mobile-test',
  }
  return (name: string, visible = true) => {
    const taskId = taskIdSchema.parse('task-' + label + '-' + name)
    const result = store.applyCommand({ type: 'work.create', commandId: 'create-' + taskId,
      payload: { projectId: project.id, requestedOutcome: 'Outcome for ' + name, constraints: ['private-constraint'],
        acceptance: { criteria: ['Verify the task'], requiresArtifact: false, requiresReceipt: false } },
    }, {
      actor, at: utcInstantSchema.parse(instant), projectId: project.id, newTaskId: taskId,
      ...(visible ? { conversationId: conversation.id } : {}),
      newAttempt: {
        id: attemptIdSchema.parse('attempt-' + taskId),
        mandate: mandateRefSchema.parse({ ...owner, id: 'mandate-' + taskId, policyVersion: actor.policyVersion }),
      },
    })
    return requireSuccess(result).state.task
  }
}

it('reads the same task IDs from a scoped mobile projection and resumes after a durable cursor', () => {
  const f = fixture()
  const pairing = requireSuccess(f.ledger.begin('Phone'))
  const { credential } = requireSuccess(f.ledger.enroll(pairing.pairingCode))
  const create = seedWork(f.store)
  const original = create('first')
  expect(f.feed.snapshot(pairing.pairingCode)).toEqual({ ok: false, code: 'unauthorized' })
  const initial = requireSuccess(f.feed.snapshot(credential))
  expect(initial.tasks).toEqual([{ id: original.id, projectId: original.projectId,
    outcome: original.requestedOutcome, version: original.version, status: original.status }])

  const foreign = seedWork(f.store, other, 'foreign')('unrelated')
  create('internal', false)
  const second = create('second')
  f.reopen()
  const replay = requireSuccess(f.feed.replay(credential, initial.cursor))
  expect(replay.events).toEqual([{ type: 'task.updated', taskId: second.id, version: second.version,
    status: second.status, at: instant, cursor: replay.cursor }])
  expect(f.feed.replay(credential, replay.cursor)).toEqual({ ok: true, cursor: replay.cursor, events: [] })
  const foreignCursor = Buffer.from(JSON.stringify([foreign.id, foreign.version])).toString('base64url')
  expect(f.feed.replay(credential, foreignCursor)).toEqual({ ok: false, code: 'snapshot_required' })
  expect(f.ledger.revoke(pairing.deviceId)).toBe(true)
  expect(f.feed.replay(credential, replay.cursor)).toEqual({ ok: false, code: 'unauthorized' })
  expect(f.feed.snapshot(credential)).toEqual({ ok: false, code: 'unauthorized' })
})

it('requires a fresh bounded snapshot when a valid cursor falls outside the replay window', () => {
  const f = fixture()
  const pair = requireSuccess(f.ledger.begin('Phone'))
  const { credential } = requireSuccess(f.ledger.enroll(pair.pairingCode))
  const create = seedWork(f.store)
  create('anchor')
  const anchor = requireSuccess(f.feed.snapshot(credential)).cursor
  for (let index = 0; index < 128; index++) create(String(index))
  expect(requireSuccess(f.feed.replay(credential, anchor)).events).toHaveLength(128)
  create('overflow')
  expect(f.feed.replay(credential, anchor)).toEqual({ ok: false, code: 'snapshot_required' })
  const replacement = requireSuccess(f.feed.snapshot(credential))
  expect(replacement.tasks).toHaveLength(64)
  expect(f.feed.replay(credential, replacement.cursor)).toEqual({ ok: true, cursor: replacement.cursor, events: [] })
})
