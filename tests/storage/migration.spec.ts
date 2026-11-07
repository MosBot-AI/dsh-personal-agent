import { spawnSync } from 'node:child_process'
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
  DATABASE_FILENAME,
  openStorageDatabase,
  QUARANTINE_FILENAME,
  WRITER_LOCK_FILENAME,
} from '../../packages/personal-agent/src/storage/database.js'
import {
  APPLICATION_ID,
  migrateSchema,
  SCHEMA_VERSION,
  sqliteCode,
  transaction,
} from '../../packages/personal-agent/src/storage/schema.js'

const directories: string[] = []

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-storage-'))
  directories.push(directory)
  return directory
}

function createPrivateFixture(path: string, content = ''): void {
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 })
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
