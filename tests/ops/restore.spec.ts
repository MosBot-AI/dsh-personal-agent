import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  accountIdSchema, attemptIdSchema, clientIdSchema, deliverySchema, deviceIdSchema, mandateRefSchema,
  ownerIdSchema, profileIdSchema, profileSchema, projectSchema, taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { canonicalizeAction, type ActionBinding } from '../../packages/personal-agent/src/policy/grants.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { restoreWorkStoreBackup } from '../../packages/personal-agent/src/storage/restore.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const fault = vi.hoisted(() => ({ failNextSync: false }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync(descriptor: number) {
      if (fault.failNextSync) {
        fault.failNextSync = false
        throw Object.assign(new Error('Fixture disk capacity reached'), { code: 'ENOSPC' })
      }
      actual.fsyncSync(descriptor)
    },
  }
})

const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const scope = { ownerId: ownerIdSchema.parse('audit-owner'), profileId: profileIdSchema.parse('audit-profile') }
const privatePrompt = 'private-prompt-canary credential=test-fake-token'
const privatePath = '/private/fixture/cwd-canary'
const providerError = 'private-provider-response-canary'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dshpa-operations-'))
  const source = join(root, 'state')
  const destination = join(root, 'backups')
  const stores = new Set<WorkStore>()
  onTestFinished(() => {
    try {
      for (const store of stores) store.close()
    } finally {
      fault.failNextSync = false
      rmSync(root, { recursive: true, force: true })
    }
  })
  return {
    root, source, destination,
    open(directory = source) {
      const store = openWorkStore(directory)
      stores.add(store)
      return store
    },
    close(store: WorkStore) {
      store.close()
      stores.delete(store)
    },
  }
}

function createTask(store: WorkStore, label: string, scopeForTask = scope) {
  const taskId = taskIdSchema.parse(`task-${label}`)
  const attemptId = attemptIdSchema.parse(`attempt-${label}`)
  const project = projectSchema.parse({
    ...scopeForTask, id: `project-${label}`, kind: 'project', title: 'Operations fixture', purpose: 'Exercise a private snapshot',
    resourceRefs: [privatePath], status: 'active', successCriteria: ['Preserve work'], planRevision: 1, milestones: [],
  })
  store.insertProject(project)
  const actor = {
    ...scopeForTask, role: 'owner', deviceId: deviceIdSchema.parse('private-device-canary'),
    clientId: clientIdSchema.parse('private-client-canary'), policyVersion: 'policy-1',
  } as const
  const result = store.applyCommand({
    type: 'work.create', commandId: `create-${label}`, payload: {
      projectId: project.id, requestedOutcome: privatePrompt, constraints: [],
      acceptance: { criteria: ['Preserve evidence'], requiresArtifact: false, requiresReceipt: false },
    },
  }, {
    actor, at, projectId: project.id, newTaskId: taskId,
    newAttempt: { id: attemptId, mandate: mandateRefSchema.parse({ ...scopeForTask, id: `mandate-${label}`, policyVersion: actor.policyVersion }) },
  }, { effects: [{ operationId: `effect-${label}`, taskId, attemptId, generation: 1, status: 'prepared', intent: providerError,
    payloadDigest: 'a'.repeat(64) }] })
  if (!result.ok) throw new Error(`Could not create operations work: ${result.code}`)
  return { ref: { ...scopeForTask, taskId }, state: result.state }
}

describe('resident store backup and restore', () => {
  it('pins a committed WAL snapshot while foreground commands keep writing and publishes one private standalone file', async () => {
    const f = fixture()
    const store = f.open()
    const existing = createTask(store, 'before-backup')
    const started = store.applyEvent(existing.ref, {
      type: 'start', expectedVersion: existing.state.task.version, attemptId: existing.state.attempt.id,
      generation: existing.state.attempt.generation, at, executor: 'operations-fixture',
    })
    if (!started.ok) throw new Error(`Could not start operations work: ${started.code}`)
    const artifact = store.artifacts.seal(existing.ref, {
      id: 'artifact-before-backup', attemptId: started.state.attempt.id, generation: started.state.attempt.generation,
      expectedVersion: started.state.task.version, mediaType: 'text/plain', sourceEventIds: [], visibility: 'private',
      bytes: new TextEncoder().encode('Private artifact from the committed WAL.'),
    })
    expect(statSync(join(f.source, `${DATABASE_FILENAME}-wal`)).size).toBeGreaterThan(0)

    const pending = store.createBackup(f.destination)
    await expect(store.createBackup(f.destination)).rejects.toMatchObject({ code: 'busy' })
    const later = createTask(store, 'after-backup')
    expect(store.getWork(later.ref)).toEqual(later.state)

    const snapshot = await pending
    expect(readdirSync(f.destination)).toEqual([snapshot.name])
    expect(statSync(snapshot.path)).toMatchObject({ nlink: 1, size: snapshot.bytes })
    if (process.getuid) {
      expect(statSync(f.destination).mode & 0o777).toBe(0o700)
      expect(statSync(snapshot.path).mode & 0o777).toBe(0o600)
    }
    const restoredPath = join(f.root, 'restored')
    restoreWorkStoreBackup(snapshot.path, restoredPath)
    const restored = f.open(restoredPath)
    expect(restored.recoveryMode()).toBe('restore')
    expect(restored.getWork(existing.ref)).toEqual(started.state)
    expect(restored.artifacts.read(existing.ref, artifact.artifact.id)).toEqual(artifact)
    expect(restored.getWork(later.ref)).toBeUndefined()
    expect(store.recoveryMode()).toBe('normal')
    expect(store.getWork(later.ref)).toEqual(later.state)
  })

  it('keeps older restored grants and pending deliveries inert after live handoff and revocation', async () => {
    const f = fixture()
    const ledger = join(f.root, 'provider.jsonl')
    const seed = fileURLToPath(new URL('../recovery/fixtures/dispatch-crash.mjs', import.meta.url))
    const seeded = spawnSync(process.execPath, [seed, f.source, ledger, 'restore', 'before'], {
      encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    })
    expect(seeded.status, seeded.stderr).toBe(0)
    const evidence = JSON.parse(seeded.stdout)
    const profile = profileSchema.parse(evidence.profile)
    const ref = { ownerId: profile.ownerId, profileId: profile.id, taskId: taskIdSchema.parse(evidence.ref.taskId) }
    const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
    const token = identity.bindOwner(evidence.metadata)
    const action = canonicalizeAction(evidence.action)?.action
    const otherAction = canonicalizeAction(evidence.otherAction)?.action
    if (!token || !action || !otherAction) throw new Error('Invalid recovery fixture authority')
    const binding: ActionBinding = evidence.binding
    const message = deliverySchema.parse(evidence.message)
    const live = f.open()
    let handoffs = 0
    const gate = (store: WorkStore) => store.createActionGate({ identity, now: () => at, routes: [{
      binding, permitsPayload: () => true, handoff() { handoffs++; return undefined },
    }] })
    const snapshot = await live.createBackup(f.destination)
    const liveGate = gate(live)
    expect(liveGate.dispatch(action, evidence.grantId, evidence.version)).toMatchObject({ ok: true })
    expect(liveGate.revoke(evidence.otherGrantId, token)).toEqual({ ok: true })
    expect(liveGate.dispatch(otherAction, evidence.otherGrantId, evidence.version)).toEqual({ ok: false, code: 'revoked' })

    const restoredPath = join(f.root, 'restored')
    restoreWorkStoreBackup(snapshot.path, restoredPath)
    for (let count = 0; count < 2; count++) {
      const restored = f.open(restoredPath)
      expect(restored.canDispatch()).toBe(false)
      expect(restored.getEffect(ref, action.operationId)?.status).toBe('authorized')
      expect(gate(restored).dispatch(action, evidence.grantId, evidence.version)).toEqual({ ok: false, code: 'recovery_required' })
      expect(gate(restored).dispatch(otherAction, evidence.otherGrantId, evidence.version)).toEqual({ ok: false, code: 'recovery_required' })
      const outbox = restored.createOutbox({ now: () => at, allowDisclosure: () => true, resolveRoute: route => ({
        ...route, id: evidence.routeId, accountId: accountIdSchema.parse(evidence.accountId), provider: {
          async send() { handoffs++; return { kind: 'unknown' } },
          async lookup() { throw new Error('Unexpected provider lookup') },
        },
      }) })
      expect(restored.getDelivery(ref, message.id)?.status).toBe('pending')
      expect(await outbox.deliver(ref, message.id)).toEqual({ ok: false, code: 'recovery_required' })
      f.close(restored)
    }
    expect(handoffs).toBe(1)
  })

  it('cleans interrupted and full writes, rejects corrupt input, and leaves an existing native directory intact', async () => {
    const f = fixture()
    const store = f.open()
    const work = createTask(store, 'fault-boundaries')
    const controller = new AbortController()
    const interrupted = store.createBackup(f.destination, { signal: controller.signal })
    controller.abort()
    await expect(interrupted).rejects.toMatchObject({ name: 'AbortError' })
    expect(readdirSync(f.destination)).toEqual([])

    fault.failNextSync = true
    await expect(store.createBackup(f.destination)).rejects.toMatchObject({ code: 'full' })
    expect(fault.failNextSync).toBe(false)
    expect(readdirSync(f.destination)).toEqual([])
    const snapshot = await store.createBackup(f.destination)
    const restoreFull = join(f.root, 'full-restore')
    fault.failNextSync = true
    expect(() => restoreWorkStoreBackup(snapshot.path, restoreFull)).toThrow(expect.objectContaining({ code: 'full' }))
    expect(existsSync(restoreFull)).toBe(false)

    const nativeDirectory = join(f.root, 'existing-native-state')
    const nativeEvidence = join(nativeDirectory, DATABASE_FILENAME)
    mkdirSync(nativeDirectory, { mode: 0o700 })
    writeFileSync(nativeEvidence, 'Existing native state', { mode: 0o600 })
    expect(() => restoreWorkStoreBackup(snapshot.path, nativeDirectory)).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(readFileSync(nativeEvidence, 'utf8')).toBe('Existing native state')

    const corrupt = join(f.root, 'corrupt.sqlite')
    writeFileSync(corrupt, 'Fixture invalid SQLite bytes', { mode: 0o600 })
    const rejected = join(f.root, 'rejected-restore')
    expect(() => restoreWorkStoreBackup(corrupt, rejected)).toThrow(expect.objectContaining({ code: 'corrupt' }))
    expect(existsSync(rejected)).toBe(false)
    expect(readdirSync(f.root).some(name => name.startsWith('.dshpa-restore-'))).toBe(false)
    expect(store.getWork(work.ref)).toEqual(work.state)
  })

  it('prunes only managed snapshots by age and count, without touching authoritative storage or foreign files', async () => {
    const f = fixture()
    const store = f.open()
    const work = createTask(store, 'retained')
    const first = await store.createBackup(f.destination)
    const second = await store.createBackup(f.destination)
    const third = await store.createBackup(f.destination)
    const aged = join(f.destination, first.name.replace(/\d{13}/, '1000000000000'))
    renameSync(first.path, aged)
    const decoy = join(f.destination, 'dshpa-work-1000000000000-12345678-1234-1234-1234-000000000001.sqlite')
    const linked = join(f.destination, 'dshpa-work-1000000000000-12345678-1234-1234-1234-000000000002.sqlite')
    const sym = join(f.destination, 'dshpa-work-1000000000000-12345678-1234-1234-1234-000000000003.sqlite')
    const manual = join(f.destination, 'manual-copy.sqlite')
    writeFileSync(decoy, 'Foreign data', { mode: 0o600 })
    copyFileSync(third.path, manual)
    linkSync(manual, linked)
    if (process.platform !== 'win32') symlinkSync(manual, sym)

    expect(store.pruneBackups(f.destination, { maxAgeDays: 1 })).toEqual({ removed: 1, remaining: 2 })
    expect(existsSync(aged)).toBe(false)
    expect(store.pruneBackups(f.destination, { maxBackups: 1 })).toEqual({ removed: 1, remaining: 1 })
    expect([second.path, third.path].filter(existsSync)).toHaveLength(1)
    expect(readFileSync(decoy, 'utf8')).toBe('Foreign data')
    expect(statSync(linked).nlink).toBe(2)
    if (process.platform !== 'win32') expect(existsSync(sym)).toBe(true)
    expect(store.getWork(work.ref)).toEqual(work.state)
  })

  it('exports bounded scoped metadata without raw identifiers, private work, paths or provider text', () => {
    const f = fixture()
    const store = f.open()
    const current = createTask(store, 'audit-secret-task')
    createTask(store, 'another-owner-task', { ...scope, ownerId: ownerIdSchema.parse('other-owner') })
    createTask(store, 'another-profile-task', { ...scope, profileId: profileIdSchema.parse('other-profile') })
    expect(store.applyEvent(current.ref, {
      type: 'start', expectedVersion: current.state.task.version, attemptId: current.state.attempt.id,
      generation: current.state.attempt.generation, at, executor: privatePath,
    })).toMatchObject({ ok: true })
    f.close(store)
    const db = new DatabaseSync(join(f.source, DATABASE_FILENAME))
    try {
      db.prepare("UPDATE work_events SET type = ? WHERE type = 'start'").run(providerError)
    } finally {
      db.close()
    }
    const reopened = f.open()
    const first = reopened.exportAudit(scope, { limit: 1 })
    expect(first).toMatchObject({ version: 1, counts: { tasks: 1, effects: 1, artifacts: 0, deliveries: 0, occurrences: 0 },
      workEvents: [{ type: 'work.create', status: 'queued', hasSourceEvent: false, occurredAt: at }] })
    expect(first.nextAfterSequence).toBe(first.workEvents[0]?.sequence)
    const last = reopened.exportAudit(scope, { afterSequence: first.nextAfterSequence, limit: 1 })
    expect(last.workEvents).toMatchObject([{ type: 'unknown', status: 'running' }])
    expect(last.nextAfterSequence).toBeUndefined()
    expect(() => reopened.exportAudit(scope, { limit: 501 })).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    const exported = JSON.stringify([first, last])
    for (const privateValue of [privatePrompt, privatePath, providerError, 'audit-secret-task', 'private-client-canary', 'test-fake-token']) {
      expect(exported).not.toContain(privateValue)
    }
  })
})
