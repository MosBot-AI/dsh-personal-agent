import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  approvalSchema,
  artifactSchema,
  conversationSchema,
  deliverySchema,
  effectSchema,
  grantSchema,
  projectSchema,
  sourceEventSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { routineSchema } from '../../packages/personal-agent/src/domain/routines.js'
import { workStateSchema } from '../../packages/personal-agent/src/domain/transitions.js'
import { verificationRecordSchema } from '../../packages/personal-agent/src/domain/verification.js'
import { canonicalizeAction } from '../../packages/personal-agent/src/policy/grants.js'
import {
  DATABASE_FILENAME,
  openStorageDatabase,
  QUARANTINE_FILENAME,
  WRITER_LOCK_FILENAME,
} from '../../packages/personal-agent/src/storage/database.js'
import { migration001 } from '../../packages/personal-agent/src/storage/migrations/001.js'
import { migration002 } from '../../packages/personal-agent/src/storage/migrations/002.js'
import { migration003 } from '../../packages/personal-agent/src/storage/migrations/003.js'
import { migration004 } from '../../packages/personal-agent/src/storage/migrations/004.js'
import { migration005 } from '../../packages/personal-agent/src/storage/migrations/005.js'
import { migration006 } from '../../packages/personal-agent/src/storage/migrations/006.js'
import { migration007 } from '../../packages/personal-agent/src/storage/migrations/007.js'
import { restoreWorkStoreBackup } from '../../packages/personal-agent/src/storage/restore.js'
import {
  APPLICATION_ID,
  migrateSchema,
  SCHEMA_VERSION,
  sqliteCode,
  transaction,
  V1_BACKUP_SUFFIX,
  V2_BACKUP_SUFFIX,
  V3_BACKUP_SUFFIX,
  V4_BACKUP_SUFFIX,
  V5_BACKUP_SUFFIX,
  V6_BACKUP_SUFFIX,
  V7_BACKUP_SUFFIX,
} from '../../packages/personal-agent/src/storage/schema.js'

const directories: string[] = []

function preContextRows(db: DatabaseSync, tables: readonly string[]) {
  return tables.map(table => db.prepare(table === 'worker_inputs' ? `
    SELECT task_id, attempt_id, generation, cursor, session_id, message_id, digest, content, kind, status,
      flushed_at, observed_at FROM worker_inputs
  ` : `SELECT * FROM ${table}`).all())
}

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-storage-'))
  directories.push(directory)
  return directory
}

function createPrivateFixture(path: string, content = ''): void {
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 })
}

function createVersionFixture(version: 1 | 2 | 3 | 4, wal = false) {
  const directory = fixtureDirectory()
  const path = join(directory, DATABASE_FILENAME)
  createPrivateFixture(path)
  const at = '2026-11-07T09:00:00.000Z'
  const scope = { ownerId: 'owner-v1', profileId: 'profile-v1' }
  const destination = { sourceInstanceId: 'source-v1', externalDestinationId: 'thread-v1' }
  const status = version >= 3 ? 'completed' : version === 2 ? 'running' : 'queued'
  const artifactId = 'artifact-v3'
  const effectReceipt = { providerReceiptId: 'effect-receipt-v3', recordedAt: at }
  const project = projectSchema.parse({
    id: 'project-v1', ...scope, kind: 'project', title: 'Existing project', purpose: 'Test upgrades',
    resourceRefs: [], status: 'active', successCriteria: ['Preserve records'], planRevision: 1, milestones: [],
  })
  const conversation = conversationSchema.parse({
    id: 'conversation-v1', ...scope, sessionIds: [], originalDestination: destination,
  })
  const work = workStateSchema.parse({
    task: {
      id: 'task-v1', ...scope, projectId: project.id, conversationId: conversation.id,
      requestedOutcome: 'Preserve existing work.', constraints: [],
      acceptance: { criteria: ['Retain work'], requiresArtifact: version >= 3, requiresReceipt: version >= 3 },
      provenance: { sourceEventIds: [] }, version, generation: 1, status,
      attemptId: 'attempt-v1', createdAt: at, updatedAt: at,
    },
    attempt: {
      id: 'attempt-v1', taskId: 'task-v1', generation: 1, status, artifactIds: version >= 3 ? [artifactId] : [],
      mandate: { id: 'mandate-v1', ...scope, policyVersion: 'policy-v1' },
      ...(version >= 2 ? { executor: 'native-dsh', startedAt: at } : {}),
      ...(version >= 3 ? { endedAt: at, outcome: {
        status: 'completed', summary: 'Verified retained fixture.', receiptId: effectReceipt.providerReceiptId,
      } } : {}),
      ...(version === 4 ? { sessionId: 'session-v4', worker: {
        presetId: 'fixture', cwd: '/fixture', provider: 'fixture', model: 'fixture',
        inputCursor: 'cursor-v4', inputHistory: ['cursor-v4'], releasedAt: at,
      } } : {}),
    },
  })
  const actionScope = {
    kind: 'send-notice', resourceRef: 'fixture-notice', accountId: 'account-v2',
    recipient: 'recipient-v2', dataScope: ['public'], limits: { maxUses: 1 },
  }
  const attempt = { taskId: work.task.id, attemptId: work.attempt.id, generation: work.attempt.generation }
  const proposal = canonicalizeAction({
    ...scope, ...attempt, ...actionScope, operationId: 'effect-v1', policyVersion: 'policy-v1',
    sourceInstanceId: destination.sourceInstanceId, payload: { text: 'Retain the claimed dispatch.' },
  })
  if (!proposal) throw new Error('Invalid v2 action fixture')
  const effect = effectSchema.parse({
    operationId: 'effect-v1', ...attempt, intent: 'Retain existing intent.', payloadDigest: proposal.digest,
    ...(version >= 3 ? { status: 'confirmed', grantId: 'grant-v2', receipt: effectReceipt }
      : version === 2 ? { status: 'dispatching', grantId: 'grant-v2' } : { status: 'prepared' }),
  })
  const delivery = deliverySchema.parse({
    id: 'delivery-v1', ...scope, destination,
    payload: { text: 'Retain existing notice.', artifactIds: version >= 3 ? [artifactId] : [] },
    dedupeKey: 'notice-v1', retries: 0,
    ...(version >= 3 ? { status: 'accepted', receipt: { providerReceiptId: 'delivery-receipt-v3', recordedAt: at } }
      : { status: 'pending' }),
  })

  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    transaction(db, () => {
      db.exec(migration001)
      if (version >= 2) db.exec(migration002)
      if (version >= 3) db.exec(migration003)
      if (version === 4) db.exec(migration004)
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${version}`)
    })
    if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0')
    transaction(db, () => {
      db.prepare('INSERT INTO projects (id, record) VALUES (?, ?)').run(project.id, JSON.stringify(project))
      db.prepare('INSERT INTO conversations (id, record) VALUES (?, ?)').run(conversation.id, JSON.stringify(conversation))
      db.prepare('INSERT INTO tasks (id, record) VALUES (?, ?)').run(work.task.id, JSON.stringify(work.task))
      db.prepare('INSERT INTO attempts (id, record) VALUES (?, ?)').run(work.attempt.id, JSON.stringify(work.attempt))
      db.prepare('INSERT INTO effects (operation_id, record) VALUES (?, ?)').run(effect.operationId, JSON.stringify(effect))
      db.prepare('INSERT INTO outbox (id, task_id, attempt_id, generation, record) VALUES (?, ?, ?, ?, ?)')
        .run(delivery.id, work.task.id, work.attempt.id, work.attempt.generation, JSON.stringify(delivery))
      if (version >= 2) {
        const principal = { ...scope, deviceId: 'device-v2' }
        const expiresAt = '2026-11-07T10:00:00.000Z'
        const approval = approvalSchema.parse({
          kind: 'approval', id: 'request-v2', ...scope, ...attempt, displayText: 'Review the existing fixture action.',
          action: { ...actionScope, payloadDigest: proposal.digest }, policyVersion: 'policy-v1', expiresAt,
          status: 'approved', responseActor: principal,
        })
        const grant = grantSchema.parse({
          id: 'grant-v2', ...scope, approvingPrincipal: principal, action: actionScope, expiresAt,
          approvalEvidence: { requestId: approval.id, approvedAt: at }, policyVersion: 'policy-v1',
        })
        db.prepare(`
          INSERT INTO action_proposals
            (operation_id, owner_id, profile_id, task_id, attempt_id, generation, account_verified_at, canonical, digest)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(effect.operationId, scope.ownerId, scope.profileId, attempt.taskId, attempt.attemptId,
          attempt.generation, at, proposal.canonical, proposal.digest)
        db.prepare(`
          INSERT INTO action_approvals
            (request_id, operation_id, record, client_id, session_id, device_id, device_verified_at, status, version)
          VALUES (?, ?, ?, 'client-v2', 'session-v2', ?, ?, 'approved', 1)
        `).run(approval.id, effect.operationId, JSON.stringify(approval), principal.deviceId, at)
        db.prepare('INSERT INTO action_grants (grant_id, request_id, operation_id, record) VALUES (?, ?, ?, ?)')
          .run(grant.id, approval.id, effect.operationId, JSON.stringify(grant))
        db.prepare('INSERT INTO action_dispatches (operation_id, grant_id, claimed_at) VALUES (?, ?, ?)')
          .run(effect.operationId, grant.id, at)
      }
      if (version >= 3) {
        const bytes = Buffer.from('Preserve these exact artifact bytes. 本地交付\n')
        const digest = createHash('sha256').update(bytes).digest('hex')
        const artifact = artifactSchema.parse({
          id: artifactId, ...scope, attemptId: attempt.attemptId, contentHash: digest,
          storageRef: `sqlite:artifact:${artifactId}`, mediaType: 'text/markdown', visibility: 'private',
          provenance: { sourceEventIds: [] },
        })
        db.prepare(`
          INSERT INTO artifacts (id, owner_id, profile_id, task_id, attempt_id, generation, version, record, content)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(artifact.id, scope.ownerId, scope.profileId, attempt.taskId, attempt.attemptId, attempt.generation,
          JSON.stringify({ artifact, taskId: attempt.taskId, generation: attempt.generation, version: 1 }), bytes)
        db.prepare(`
          INSERT INTO work_events (owner_id, profile_id, task_id, attempt_id, generation, version, type, status, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, 'verify', 'completed', ?)
        `).run(scope.ownerId, scope.profileId, attempt.taskId, attempt.attemptId, attempt.generation, work.task.version, at)
        const verification = verificationRecordSchema.parse({
          ...attempt, version: work.task.version, verifiedAt: at,
          criteria: [{ criterion: 'Retain work', satisfied: true, evidence: 'Read back exact artifact bytes.' }],
          artifacts: [{ id: artifactId, version: 1, digest }],
          effectReceipt: { operationId: effect.operationId, ...effectReceipt },
        })
        db.prepare('INSERT INTO work_verifications (task_id, attempt_id, generation, version, record) VALUES (?, ?, ?, ?, ?)')
          .run(attempt.taskId, attempt.attemptId, attempt.generation, work.task.version, JSON.stringify(verification))
        db.prepare("INSERT INTO outbox_bindings (delivery_id, route_id, account_id) VALUES (?, 'route-v3', 'account-v2')")
          .run(delivery.id)
      }
      if (version === 4) {
        const source = sourceEventSchema.parse({
          id: 'source-event-v4', ...scope, sourceInstanceId: destination.sourceInstanceId,
          externalEventId: 'existing-v4-input', externalRevision: '1', actor: { kind: 'person', externalActorId: 'fixture' },
          body: { text: 'Retain legacy source intake.' }, occurredAt: at, receivedAt: at,
          threadId: destination.externalDestinationId, provenance: {},
        })
        db.prepare('INSERT INTO source_events (id, record) VALUES (?, ?)').run(source.id, JSON.stringify(source))
        const content = 'Retain the earlier Worker input journal.'
        db.prepare(`
          INSERT INTO worker_inputs
            (task_id, attempt_id, generation, cursor, session_id, message_id, digest, content, kind, status, observed_at)
          VALUES (?, ?, ?, 'cursor-v4', 'session-v4', ?, ?, ?, 'followup', 'admitted', ?)
        `).run(attempt.taskId, attempt.attemptId, attempt.generation,
          `dshpa-input-${'1'.repeat(64)}`, createHash('sha256').update(content).digest('hex'), content, at)
      }
    })
    return { directory, path, db }
  } catch (error) {
    db.close()
    throw error
  }
}

function readVersion1Records(db: DatabaseSync) {
  return ['projects', 'conversations', 'tasks', 'attempts', 'effects', 'outbox']
    .map(table => db.prepare(`SELECT record FROM ${table}`).all())
}

function readVersion2Records(db: DatabaseSync) {
  return {
    work: readVersion1Records(db),
    authorization: ['action_proposals', 'action_approvals', 'action_grants', 'action_dispatches']
      .map(table => db.prepare(`SELECT * FROM ${table}`).all()),
  }
}

function readVersion3Records(db: DatabaseSync) {
  return {
    ...readVersion2Records(db),
    results: ['artifacts', 'work_verifications', 'outbox_bindings', 'work_events']
      .map(table => db.prepare(`SELECT * FROM ${table}`).all()),
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function runSqliteChild(source: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source, ...args], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  })
}

function tryLockInSubprocess(directory: string) {
  return runSqliteChild(`
    import { DatabaseSync } from 'node:sqlite'
    import { writeSync } from 'node:fs'
    const guard = new DatabaseSync(process.argv[1], { timeout: 0 })
    try {
      guard.exec('BEGIN EXCLUSIVE')
      writeSync(1, 'LOCKED')
      // No close or rollback. The next opener must recover the OS lock.
      process.exit(86)
    } catch (error) {
      writeSync(1, String(error.errcode & 0xff))
      process.exit(1)
    }
  `, join(directory, WRITER_LOCK_FILENAME))
}

describe('on-disk SQLite lifecycle', () => {
  it('initializes the owned schema with WAL, full sync, foreign keys, and private files', () => {
    const directory = join(fixtureDirectory(), 'profile')
    const storage = openStorageDatabase(directory)
    try {
      expect(storage.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
      expect(storage.db.prepare('PRAGMA application_id').get()?.application_id).toBe(APPLICATION_ID)
      expect(storage.db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
      expect(storage.db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2)
      expect(storage.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
      storage.db.exec(`
        CREATE TEMP TABLE parent(id INTEGER PRIMARY KEY);
        CREATE TEMP TABLE child(parent_id INTEGER NOT NULL REFERENCES parent(id));
      `)
      expect(() => storage.db.exec('INSERT INTO child VALUES (42)')).toThrow(/FOREIGN KEY/)
      if (process.getuid) {
        expect(statSync(directory).mode & 0o777).toBe(0o700)
        for (const name of [DATABASE_FILENAME, WRITER_LOCK_FILENAME, `${DATABASE_FILENAME}-wal`, `${DATABASE_FILENAME}-shm`]) {
          expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600)
        }
      }
    } finally {
      storage.close()
    }
    const reopened = openStorageDatabase(directory)
    try {
      expect(reopened.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
    } finally {
      reopened.close()
    }
  })

  it('holds the writer lock for the connection lifetime and recovers it after abrupt process exit', () => {
    const directory = fixtureDirectory()
    const storage = openStorageDatabase(directory)
    try {
      expect(() => openStorageDatabase(directory)).toThrow(expect.objectContaining({ code: 'busy' }))
      const blocked = tryLockInSubprocess(directory)
      expect(blocked.error).toBeUndefined()
      expect(blocked.status, blocked.stderr).toBe(1)
      expect(blocked.stdout).toBe('5')
    } finally {
      storage.close()
    }
    expect(() => storage.quarantine(new Error('stale handle'))).toThrow(expect.objectContaining({ code: 'closed' }))
    expect(existsSync(join(directory, QUARANTINE_FILENAME))).toBe(false)
    expect(existsSync(join(directory, WRITER_LOCK_FILENAME))).toBe(true)
    const acquired = tryLockInSubprocess(directory)
    expect(acquired.error).toBeUndefined()
    expect(acquired.status, acquired.stderr).toBe(86)
    expect(acquired.stdout).toBe('LOCKED')
    const recovered = openStorageDatabase(directory)
    recovered.close()
  })

  it('recovers only committed WAL frames after a process exits during a write', () => {
    const directory = fixtureDirectory()
    const storage = openStorageDatabase(directory)
    try {
      storage.db.exec('CREATE TABLE crash_fixture(id INTEGER PRIMARY KEY, payload BLOB NOT NULL) STRICT')
    } finally {
      storage.close()
    }
    const path = join(directory, DATABASE_FILENAME)
    const interrupted = runSqliteChild(`
      import { statSync, writeSync } from 'node:fs'
      import { DatabaseSync } from 'node:sqlite'

      const [guardPath, path] = process.argv.slice(1)
      const guard = new DatabaseSync(guardPath, { timeout: 0 })
      guard.exec('BEGIN EXCLUSIVE')
      const db = new DatabaseSync(path, { timeout: 0 })
      db.exec('PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0; PRAGMA cache_size = 8')
      db.exec("BEGIN IMMEDIATE; INSERT INTO crash_fixture VALUES (1, X'CAFE'); COMMIT")
      const committedBytes = statSync(path + '-wal').size
      // Overflow the cache so the unfinished transaction emits WAL frames.
      db.exec('BEGIN IMMEDIATE; INSERT INTO crash_fixture VALUES (2, zeroblob(1048576))')
      const interruptedBytes = statSync(path + '-wal').size
      writeSync(1, JSON.stringify({ committedBytes, interruptedBytes, inTransaction: db.isTransaction }))
      process.exit(87)
    `, join(directory, WRITER_LOCK_FILENAME), path)
    expect(interrupted.error).toBeUndefined()
    expect(interrupted.status, interrupted.stderr).toBe(87)
    const observation = JSON.parse(interrupted.stdout)
    expect(observation.inTransaction).toBe(true)
    expect(observation.committedBytes).toBeGreaterThan(0)
    expect(observation.interruptedBytes).toBeGreaterThan(observation.committedBytes)
    expect(statSync(path + '-wal').size).toBe(observation.interruptedBytes)

    const recovered = openStorageDatabase(directory)
    try {
      expect(recovered.db.prepare('SELECT id, hex(payload) AS payload FROM crash_fixture ORDER BY id').all())
        .toEqual([{ id: 1, payload: 'CAFE' }])
    } finally {
      recovered.close()
    }
  })

  it.skipIf(process.platform === 'win32')('refuses a shared directory or linked database file', () => {
    const directory = fixtureDirectory()
    chmodSync(directory, 0o755)
    expect(() => openStorageDatabase(directory)).toThrow(expect.objectContaining({ code: 'unsafe_path' }))
    chmodSync(directory, 0o700)
    const target = join(directory, 'other-file')
    createPrivateFixture(target, 'untouched')
    symlinkSync(target, join(directory, DATABASE_FILENAME))
    expect(() => openStorageDatabase(directory)).toThrow(expect.objectContaining({ code: 'unsafe_path' }))
    expect(readFileSync(target, 'utf8')).toBe('untouched')
  })

  it('leaves unsupported future and foreign databases in place without quarantining them', () => {
    const futureDirectory = fixtureDirectory()
    const future = openStorageDatabase(futureDirectory)
    try {
      future.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    } finally {
      future.close()
    }
    expect(() => openStorageDatabase(futureDirectory)).toThrow(expect.objectContaining({ code: 'unsupported_schema' }))
    expect(existsSync(join(futureDirectory, QUARANTINE_FILENAME))).toBe(false)
    const readFuture = new DatabaseSync(join(futureDirectory, DATABASE_FILENAME), { readOnly: true })
    try {
      expect(readFuture.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION + 1)
    } finally {
      readFuture.close()
    }

    const foreignDirectory = fixtureDirectory()
    const foreignPath = join(foreignDirectory, DATABASE_FILENAME)
    createPrivateFixture(foreignPath)
    const foreign = new DatabaseSync(foreignPath)
    try {
      foreign.exec("CREATE TABLE other(value TEXT); INSERT INTO other VALUES ('preserved')")
    } finally {
      foreign.close()
    }
    const original = readFileSync(foreignPath)
    expect(() => openStorageDatabase(foreignDirectory)).toThrow(expect.objectContaining({ code: 'unsupported_schema' }))
    expect(readFileSync(foreignPath)).toEqual(original)
    expect(existsSync(join(foreignDirectory, QUARANTINE_FILENAME))).toBe(false)
  })

  it('quarantines a non-SQLite file in place and refuses to create an empty replacement', () => {
    const directory = fixtureDirectory()
    const path = join(directory, DATABASE_FILENAME)
    const bytes = 'Corrupt SQLite fixture with bytes to preserve.\n'.repeat(4)
    createPrivateFixture(path, bytes)
    expect(() => openStorageDatabase(directory)).toThrow(expect.objectContaining({ code: 'corrupt' }))
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    expect(existsSync(join(directory, QUARANTINE_FILENAME))).toBe(true)

    renameSync(path, join(directory, 'corrupt-copy'))
    expect(() => openStorageDatabase(directory)).toThrow(expect.objectContaining({ code: 'corrupt' }))
    expect(existsSync(path)).toBe(false)
  })

  it('preserves committed rows and closes the handle when the store reports record corruption', () => {
    const directory = fixtureDirectory()
    const storage = openStorageDatabase(directory)
    try {
      storage.db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')")
      expect(() => storage.quarantine(new Error('fixture corruption'))).toThrow(expect.objectContaining({ code: 'corrupt' }))
      expect(storage.db.isOpen).toBe(false)
      expect(() => openStorageDatabase(directory)).toThrow(expect.objectContaining({ code: 'corrupt' }))
      const readback = new DatabaseSync(join(directory, DATABASE_FILENAME), { readOnly: true })
      try {
        expect(readback.prepare('SELECT value FROM fixture').get()?.value).toBe('committed')
      } finally {
        readback.close()
      }
    } finally {
      storage.close()
    }
  })
})

describe('SQLite failure recovery', () => {
  it('rolls back the migration schema and version under real SQLite capacity exhaustion', () => {
    const path = join(fixtureDirectory(), DATABASE_FILENAME)
    createPrivateFixture(path)
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA max_page_count = 2')
      expect(() => migrateSchema(db)).toThrow(expect.objectContaining({ code: 'full' }))
      expect(db.isTransaction).toBe(false)
      expect(db.prepare('PRAGMA application_id').get()?.application_id).toBe(0)
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(0)
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([])

      db.exec('PRAGMA max_page_count = 128')
      migrateSchema(db)
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('preserves SQLITE_FULL and does not commit earlier transaction writes', () => {
    const directory = fixtureDirectory()
    const storage = openStorageDatabase(directory)
    try {
      const { db } = storage
      db.exec('CREATE TABLE capacity_fixture(id INTEGER PRIMARY KEY, payload BLOB) STRICT')
      const limit = db.prepare('PRAGMA page_count').get()?.page_count
      expect(typeof limit).toBe('number')
      db.exec(`PRAGMA max_page_count = ${limit}`)
      let error: unknown
      try {
        transaction(db, () => {
          db.exec("INSERT INTO capacity_fixture VALUES (1, X'CAFE')")
          db.exec('INSERT INTO capacity_fixture VALUES (2, zeroblob(65536))')
        })
      } catch (caught) {
        error = caught
      }
      expect(sqliteCode(error)).toBe(13)
      expect(db.isTransaction).toBe(false)
      expect(db.prepare('SELECT id FROM capacity_fixture').all()).toEqual([])
    } finally {
      storage.close()
    }
  })
})

describe('SQLite v1 to v6 upgrade', () => {
  it('preserves original work and backs up a consistent v1 view including committed WAL rows', () => {
    const v1 = createVersionFixture(1, true)
    try {
      const originals = readVersion1Records(v1.db)
      expect(statSync(v1.path + '-wal').size).toBeGreaterThan(0)
      const storage = openStorageDatabase(v1.directory)
      try {
        expect(storage.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
        expect(readVersion1Records(storage.db)).toEqual(originals)
        expect(storage.db.prepare('SELECT COUNT(*) AS count FROM action_dispatches').get()?.count).toBe(0)
        expect(storage.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        storage.close()
      }

      const backupPath = v1.path + V1_BACKUP_SUFFIX
      expect(existsSync(v1.path + V2_BACKUP_SUFFIX)).toBe(false)
      expect(existsSync(v1.path + V3_BACKUP_SUFFIX)).toBe(false)
      if (process.getuid) expect(statSync(backupPath).mode & 0o777).toBe(0o600)
      const backup = new DatabaseSync(backupPath, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
        expect(backup.prepare('PRAGMA application_id').get()?.application_id).toBe(APPLICATION_ID)
        expect(backup.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok')
        expect(readVersion1Records(backup)).toEqual(originals)
        expect(backup.prepare("SELECT name FROM sqlite_schema WHERE name = 'action_proposals'").get()).toBeUndefined()
      } finally {
        backup.close()
      }
      const saved = readFileSync(backupPath)
      const reopened = openStorageDatabase(v1.directory)
      reopened.close()
      expect(readFileSync(backupPath)).toEqual(saved)
    } finally {
      v1.db.close()
    }
  })

  it('retains v1 and its backup when SQLite runs out of pages during the additive upgrade', () => {
    const v1 = createVersionFixture(1)
    try {
      const originals = readVersion1Records(v1.db)
      const pages = v1.db.prepare('PRAGMA page_count').get()?.page_count
      if (typeof pages !== 'number') throw new Error('Expected the v1 database page count')
      v1.db.exec(`PRAGMA max_page_count = ${pages + 2}`)
      expect(() => migrateSchema(v1.db)).toThrow(expect.objectContaining({ code: 'full' }))
      expect(v1.db.isTransaction).toBe(false)
      expect(v1.db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
      expect(v1.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'action_%'").all()).toEqual([])
      expect(readVersion1Records(v1.db)).toEqual(originals)

      const backup = new DatabaseSync(v1.path + V1_BACKUP_SUFFIX, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
        expect(readVersion1Records(backup)).toEqual(originals)
      } finally {
        backup.close()
      }
      v1.db.exec(`PRAGMA max_page_count = ${pages + 128}`)
      migrateSchema(v1.db)
      expect(v1.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
      expect(readVersion1Records(v1.db)).toEqual(originals)
    } finally {
      v1.db.close()
    }
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink at the reserved backup path before migrating', () => {
    const v1 = createVersionFixture(1)
    v1.db.close()
    const sentinel = join(fixtureDirectory(), 'sentinel')
    createPrivateFixture(sentinel, 'Keep original target')
    symlinkSync(sentinel, v1.path + V1_BACKUP_SUFFIX)

    expect(() => openStorageDatabase(v1.directory)).toThrow(expect.objectContaining({ code: 'unsafe_path' }))
    expect(readFileSync(sentinel, 'utf8')).toBe('Keep original target')
    expect(existsSync(join(v1.directory, QUARANTINE_FILENAME))).toBe(false)
    const source = new DatabaseSync(v1.path, { readOnly: true })
    try {
      expect(source.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    } finally {
      source.close()
    }
  })
})

describe('SQLite v2 to v6 upgrade', () => {
  it('preserves committed WAL work and authorization claims in an owner-private v2 backup', () => {
    const v2 = createVersionFixture(2, true)
    try {
      const originals = readVersion2Records(v2.db)
      expect(statSync(v2.path + '-wal').size).toBeGreaterThan(0)
      const storage = openStorageDatabase(v2.directory)
      try {
        expect(storage.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
        expect(readVersion2Records(storage.db)).toEqual(originals)
        expect(storage.db.prepare('SELECT COUNT(*) AS count FROM artifacts').get()?.count).toBe(0)
        expect(storage.db.prepare('SELECT COUNT(*) AS count FROM work_verifications').get()?.count).toBe(0)
        expect(storage.db.prepare('SELECT COUNT(*) AS count FROM outbox_bindings').get()?.count).toBe(0)
        expect(storage.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        storage.close()
      }
      const backupPath = v2.path + V2_BACKUP_SUFFIX
      expect(existsSync(v2.path + V1_BACKUP_SUFFIX)).toBe(false)
      if (process.getuid) expect(statSync(backupPath).mode & 0o777).toBe(0o600)
      const backup = new DatabaseSync(backupPath, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
        expect(backup.prepare('PRAGMA application_id').get()?.application_id).toBe(APPLICATION_ID)
        expect(backup.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok')
        expect(readVersion2Records(backup)).toEqual(originals)
        expect(backup.prepare("SELECT name FROM sqlite_schema WHERE name = 'artifacts'").get()).toBeUndefined()
      } finally {
        backup.close()
      }
    } finally {
      v2.db.close()
    }
  })

  it('rolls back the entire upgrade under capacity exhaustion and can retry from v2', () => {
    const v2 = createVersionFixture(2)
    try {
      const originals = readVersion2Records(v2.db)
      const pages = v2.db.prepare('PRAGMA page_count').get()?.page_count
      if (typeof pages !== 'number') throw new Error('Expected the v2 database page count')
      v2.db.exec(`PRAGMA max_page_count = ${pages + 5}`)
      expect(() => migrateSchema(v2.db)).toThrow(expect.objectContaining({ code: 'full' }))
      expect(v2.db.isTransaction).toBe(false)
      expect(v2.db.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
      expect(v2.db.prepare(`
        SELECT name FROM sqlite_schema WHERE name IN (
          'artifacts', 'work_verifications', 'outbox_bindings', 'work_events_exact_completion', 'outbox_by_task_channel'
        )
      `).all()).toEqual([])
      expect(readVersion2Records(v2.db)).toEqual(originals)
      const backup = new DatabaseSync(v2.path + V2_BACKUP_SUFFIX, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
        expect(readVersion2Records(backup)).toEqual(originals)
      } finally {
        backup.close()
      }

      v2.db.exec(`PRAGMA max_page_count = ${pages + 128}`)
      migrateSchema(v2.db)
      expect(v2.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
      expect(readVersion2Records(v2.db)).toEqual(originals)
    } finally {
      v2.db.close()
    }
  })
})

describe('SQLite v3 to v6 upgrade', () => {
  it('preserves committed WAL verification, artifact bytes and receipt bindings', () => {
    const v3 = createVersionFixture(3, true)
    try {
      const originals = readVersion3Records(v3.db)
      expect(statSync(v3.path + '-wal').size).toBeGreaterThan(0)
      const upgraded = openStorageDatabase(v3.directory)
      try {
        expect(upgraded.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
        expect(readVersion3Records(upgraded.db)).toEqual(originals)
        expect(upgraded.db.prepare('SELECT mode FROM runtime_recovery WHERE id = 1').get()?.mode).toBe('normal')
        expect(upgraded.db.prepare('SELECT * FROM worker_inputs').all()).toEqual([])
      } finally {
        upgraded.close()
      }
      const backupPath = v3.path + V3_BACKUP_SUFFIX
      if (process.getuid) expect(statSync(backupPath).mode & 0o777).toBe(0o600)
      const backup = new DatabaseSync(backupPath, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
        expect(readVersion3Records(backup)).toEqual(originals)
        expect(backup.prepare("SELECT name FROM sqlite_schema WHERE name = 'runtime_recovery'").get()).toBeUndefined()
      } finally {
        backup.close()
      }
    } finally {
      v3.db.close()
    }
  })

  it('rolls back both recovery tables and schema version on a real capacity failure', () => {
    const v3 = createVersionFixture(3)
    try {
      const originals = readVersion3Records(v3.db)
      const pages = v3.db.prepare('PRAGMA page_count').get()?.page_count
      if (typeof pages !== 'number') throw new Error('Expected the v3 database page count')
      v3.db.exec(`PRAGMA max_page_count = ${pages + 1}`)
      expect(() => migrateSchema(v3.db)).toThrow(expect.objectContaining({ code: 'full' }))
      expect(v3.db.isTransaction).toBe(false)
      expect(v3.db.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
      expect(v3.db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('worker_inputs', 'runtime_recovery')").all())
        .toEqual([])
      expect(readVersion3Records(v3.db)).toEqual(originals)
      const backup = new DatabaseSync(v3.path + V3_BACKUP_SUFFIX, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
        expect(readVersion3Records(backup)).toEqual(originals)
      } finally {
        backup.close()
      }
      v3.db.exec(`PRAGMA max_page_count = ${pages + 128}`)
      migrateSchema(v3.db)
      expect(v3.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
      expect(readVersion3Records(v3.db)).toEqual(originals)
    } finally {
      v3.db.close()
    }
  })
})

describe('SQLite v4 to v6 upgrade', () => {
  it('retains legacy source dedupe rows, Worker input journals and the recovery fence in a v4 backup', () => {
    const v4 = createVersionFixture(4, true)
    const recoveryRows = (db: DatabaseSync) => preContextRows(db, ['source_events', 'worker_inputs', 'runtime_recovery'])
    try {
      v4.db.exec("UPDATE runtime_recovery SET mode = 'restore' WHERE id = 1")
      const originals = recoveryRows(v4.db)
      const storage = openStorageDatabase(v4.directory)
      try {
        expect(storage.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
        expect(recoveryRows(storage.db)).toEqual(originals)
        expect(storage.db.prepare('SELECT * FROM routing_receipts').all()).toEqual([])
        expect(storage.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        storage.close()
      }
      const backupPath = v4.path + V4_BACKUP_SUFFIX
      if (process.getuid) expect(statSync(backupPath).mode & 0o777).toBe(0o600)
      const backup = new DatabaseSync(backupPath, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(4)
        expect(recoveryRows(backup)).toEqual(originals)
      } finally {
        backup.close()
      }
    } finally {
      v4.db.close()
    }
  })
})

describe('SQLite v5 to v6 upgrade', () => {
  it('preserves committed routing and recovery records while initializing budget and attention ledgers', () => {
    const v5 = createVersionFixture(4, true)
    const rows = (db: DatabaseSync) => preContextRows(db, ['source_events', 'routing_receipts', 'worker_inputs', 'runtime_recovery'])
    try {
      transaction(v5.db, () => {
        v5.db.exec(migration005)
        v5.db.exec('PRAGMA user_version = 5')
        const source = v5.db.prepare("SELECT record FROM source_events WHERE id = 'source-event-v4'").get()?.record
        if (typeof source !== 'string') throw new Error('Missing legacy source fixture')
        const existing = sourceEventSchema.parse(JSON.parse(source))
        const event = sourceEventSchema.parse({
          ...existing, actor: { ...existing.actor, accountId: 'fixture-account' }, body: {
            kind: 'candidate', projectId: 'project-v1', dataScope: ['fixture-public'], text: 'Keep the settled routing event.',
            policyVersion: 'policy-v1', accountVerifiedAt: existing.occurredAt,
          },
        })
        v5.db.prepare('UPDATE source_events SET record = ? WHERE id = ?').run(JSON.stringify(event), event.id)
        v5.db.prepare(`
          INSERT INTO routing_receipts
            (event_id, owner_id, profile_id, project_id, digest, policy_version, account_verified_at, version, disposition)
          VALUES (?, ?, ?, 'project-v1', ?, 'policy-v1', ?, 2, ?)
        `).run(event.id, event.ownerId, event.profileId, 'a'.repeat(64), event.occurredAt,
          JSON.stringify({ kind: 'assessed', decision: { kind: 'ignore' } }))
      })
      const original = rows(v5.db)
      const storage = openStorageDatabase(v5.directory)
      try {
        expect(storage.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
        expect(rows(storage.db)).toEqual(original)
        expect(storage.db.prepare('SELECT * FROM budget_reservations').all()).toEqual([])
        expect(storage.db.prepare('SELECT * FROM attention_decisions').all()).toEqual([])
        expect(storage.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        storage.close()
      }
      const backupPath = v5.path + V5_BACKUP_SUFFIX
      if (process.getuid) expect(statSync(backupPath).mode & 0o777).toBe(0o600)
      const backup = new DatabaseSync(backupPath, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(5)
        expect(rows(backup)).toEqual(original)
      } finally {
        backup.close()
      }
    } finally {
      v5.db.close()
    }
  })
})

describe('SQLite v6 to v7 upgrade', () => {
  it('preserves committed budget, attention, and recovery state in the upgrade and the private v6 backup', () => {
    const v6 = createVersionFixture(4, true)
    const rows = (db: DatabaseSync) => preContextRows(db, ['budget_reservations', 'attention_policies', 'worker_inputs', 'runtime_recovery'])
    const at = '2026-11-07T09:00:00.000Z'
    try {
      transaction(v6.db, () => {
        v6.db.exec(migration005)
        v6.db.exec(migration006)
        v6.db.exec("PRAGMA user_version = 6; UPDATE runtime_recovery SET mode = 'restore' WHERE id = 1")
        v6.db.prepare(`
          INSERT INTO budget_reservations
            (id, owner_id, profile_id, provider, model, pricing_version, day, created_at, updated_at, pricing,
             ceiling_micros, actual_micros, upper_input_tokens, upper_output_tokens, unattended, status, usage)
          VALUES ('legacy-budget', 'owner-v1', 'profile-v1', 'local', 'free', 'pricing-v1', '2026-11-07', ?, ?, ?,
                  0, 0, 0, 1, 0, 'settled', ?)
        `).run(at, at, JSON.stringify({
          kind: 'known', inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
          cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0, ceilingMicros: 0,
        }), JSON.stringify({ inputTokens: 0, outputTokens: 0 }))
        v6.db.prepare("INSERT INTO attention_policies VALUES ('owner-v1', 'profile-v1', 1, ?)")
          .run(JSON.stringify({ version: 1, mode: 'observe', timeZone: 'UTC', quietHours: null, urgentRules: [] }))
      })
      const original = rows(v6.db)
      const storage = openStorageDatabase(v6.directory)
      try {
        expect(storage.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
        expect(rows(storage.db)).toEqual(original)
        for (const table of ['routines', 'routine_mappings', 'routine_occurrences']) {
          expect(storage.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
        }
        expect(storage.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        storage.close()
      }
      const backupPath = v6.path + V6_BACKUP_SUFFIX
      if (process.getuid) expect(statSync(backupPath).mode & 0o777).toBe(0o600)
      const backup = new DatabaseSync(backupPath, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(6)
        expect(rows(backup)).toEqual(original)
      } finally {
        backup.close()
      }
    } finally {
      v6.db.close()
    }
  })
})

describe('SQLite v7 to v8 upgrade', () => {
  it('rolls back capacity failures and preserves committed work, routines and recovery mode in a private v7 backup', () => {
    const v7 = createVersionFixture(4, true)
    const at = '2026-11-07T09:00:00.000Z'
    const rows = (db: DatabaseSync) => preContextRows(db, ['tasks', 'work_events', 'artifacts', 'routines', 'runtime_recovery', 'worker_inputs'])
    try {
      transaction(v7.db, () => {
        v7.db.exec(migration005)
        v7.db.exec(migration006)
        v7.db.exec(migration007)
        v7.db.exec("PRAGMA user_version = 7; UPDATE runtime_recovery SET mode = 'restore' WHERE id = 1")
        const routine = routineSchema.parse({
          id: 'legacy-routine', ownerId: 'owner-v1', profileId: 'profile-v1', revision: 1, status: 'draft', updatedAt: at,
          title: 'Legacy reminder', timing: { kind: 'at', at }, timeZone: 'UTC', localTimeIntent: '09:00 UTC',
          dst: { gap: 'skip', overlap: 'earlier' }, misfire: 'skip', target: { kind: 'reminder', text: 'Keep this routine.' },
        })
        v7.db.prepare('INSERT INTO routines (id, record) VALUES (?, ?)').run(routine.id, JSON.stringify(routine))
      })
      const original = rows(v7.db)
      const pages = v7.db.prepare('PRAGMA page_count').get()?.page_count
      expect(typeof pages).toBe('number')
      v7.db.exec(`PRAGMA max_page_count = ${Number(pages) + 2}`)
      expect(() => migrateSchema(v7.db)).toThrow(expect.objectContaining({ code: 'full' }))
      expect(v7.db.prepare('PRAGMA user_version').get()?.user_version).toBe(7)
      expect(v7.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'context_%'").all()).toEqual([])
      expect(rows(v7.db)).toEqual(original)
      v7.db.exec(`PRAGMA max_page_count = ${Number(pages) + 128}`)
      migrateSchema(v7.db)
      expect(v7.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
      expect(rows(v7.db)).toEqual(original)
      expect(v7.db.prepare('SELECT count(*) AS count FROM context_checkpoints').get()?.count).toBe(0)
      expect(v7.db.prepare('SELECT count(*) AS count FROM context_exclusions').get()?.count).toBe(0)
      expect(v7.db.prepare('SELECT context_sources FROM worker_inputs').all()).toEqual([{ context_sources: null }])
      expect(v7.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      const backupPath = v7.path + V7_BACKUP_SUFFIX
      if (process.getuid) expect(statSync(backupPath).mode & 0o777).toBe(0o600)
      const backup = new DatabaseSync(backupPath, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(7)
        expect(rows(backup)).toEqual(original)
      } finally {
        backup.close()
      }
    } finally {
      v7.db.close()
    }
  })
})

describe('standalone SQLite snapshot restore', () => {
  it.each([3, 4] as const)('publishes source v%s in restore mode while preserving its records and source file', version => {
    const source = createVersionFixture(version)
    source.db.close()
    const sourceBytes = readFileSync(source.path)
    const destination = join(fixtureDirectory(), 'restore')
    restoreWorkStoreBackup(source.path, destination)
    const publishedPath = join(destination, DATABASE_FILENAME)
    expect(statSync(publishedPath).nlink).toBe(1)
    if (process.getuid) {
      expect(statSync(destination).mode & 0o777).toBe(0o700)
      expect(statSync(publishedPath).mode & 0o777).toBe(0o600)
    }
    expect(existsSync(publishedPath + '-wal')).toBe(false)
    const published = new DatabaseSync(publishedPath, { readOnly: true })
    const original = new DatabaseSync(source.path, { readOnly: true })
    try {
      expect(published.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
      expect(published.prepare('SELECT mode FROM runtime_recovery WHERE id = 1').get()?.mode).toBe('restore')
      expect(readVersion3Records(published)).toEqual(readVersion3Records(original))
      expect(original.prepare('PRAGMA user_version').get()?.user_version).toBe(version)
      if (version === 4) expect(original.prepare('SELECT mode FROM runtime_recovery WHERE id = 1').get()?.mode).toBe('normal')
    } finally {
      original.close()
      published.close()
    }
    expect(readFileSync(source.path)).toEqual(sourceBytes)
    const opened = openStorageDatabase(destination)
    try {
      expect(opened.db.prepare('SELECT mode FROM runtime_recovery WHERE id = 1').get()?.mode).toBe('restore')
    } finally {
      opened.close()
    }
  })

  it('does not overwrite an existing destination or copy a source with live SQLite sidecars', () => {
    const source = createVersionFixture(3, true)
    try {
      const existing = fixtureDirectory()
      const sentinel = join(existing, 'sentinel')
      createPrivateFixture(sentinel, 'Keep the original destination.')
      expect(() => restoreWorkStoreBackup(source.path, existing)).toThrow(expect.objectContaining({ code: 'conflict' }))
      expect(readFileSync(sentinel, 'utf8')).toBe('Keep the original destination.')
      expect(existsSync(join(existing, DATABASE_FILENAME))).toBe(false)

      const destination = join(fixtureDirectory(), 'restore')
      expect(existsSync(source.path + '-wal')).toBe(true)
      expect(() => restoreWorkStoreBackup(source.path, destination)).toThrow(expect.objectContaining({ code: 'unsafe_path' }))
      expect(existsSync(destination)).toBe(false)
    } finally {
      source.db.close()
    }
  })

  it('refuses a foreign SQLite file without publishing an empty work profile', () => {
    const source = join(fixtureDirectory(), 'foreign.sqlite')
    createPrivateFixture(source)
    const db = new DatabaseSync(source)
    try {
      db.exec('CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES (\'keep\')')
    } finally {
      db.close()
    }
    const original = readFileSync(source)
    const destination = join(fixtureDirectory(), 'restore')
    expect(() => restoreWorkStoreBackup(source, destination)).toThrow(expect.objectContaining({ code: 'unsupported_schema' }))
    expect(existsSync(destination)).toBe(false)
    expect(readFileSync(source)).toEqual(original)
  })
})
