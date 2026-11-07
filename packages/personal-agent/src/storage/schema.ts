import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { migration001 } from './migrations/001.js'
import { migration002 } from './migrations/002.js'
import { migration003 } from './migrations/003.js'
import { migration004 } from './migrations/004.js'
import { migration005 } from './migrations/005.js'
import { migration006 } from './migrations/006.js'

export const APPLICATION_ID = 0x44534850 // DSHP
export const SCHEMA_VERSION = 6
export const V1_BACKUP_SUFFIX = '.v1.bak'
export const V2_BACKUP_SUFFIX = '.v2.bak'
export const V3_BACKUP_SUFFIX = '.v3.bak'
export const V4_BACKUP_SUFFIX = '.v4.bak'
export const V5_BACKUP_SUFFIX = '.v5.bak'

export type StorageErrorCode =
  | 'busy'
  | 'closed'
  | 'conflict'
  | 'corrupt'
  | 'full'
  | 'invalid_input'
  | 'migration_failed'
  | 'stale_attempt'
  | 'unsafe_path'
  | 'unsupported_schema'
  | 'version_conflict'

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StorageError'
  }
}

/** Return the primary result code from a Node SQLite error, including extended codes. */
export function sqliteCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) return undefined
  const { errcode } = error
  if (typeof errcode !== 'number' || !Number.isInteger(errcode)) return undefined
  return errcode & 0xff
}

function isThenable(value: unknown): boolean {
  return ((typeof value === 'object' && value !== null) || typeof value === 'function')
    && 'then' in value && typeof value.then === 'function'
}

/** Run a short synchronous transaction, including deferred checks at commit. */
export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    if (isThenable(result)) throw new StorageError('invalid_input', 'Storage transactions must finish synchronously')
    db.exec('COMMIT')
    return result
  } catch (cause) {
    try {
      if (db.isTransaction) db.exec('ROLLBACK')
    } catch (rollbackCause) {
      throw new AggregateError([cause, rollbackCause], 'Storage transaction could not roll back', { cause })
    }
    throw cause
  }
}

const schema1Tables = [
  'projects', 'conversations', 'tasks', 'attempts', 'source_events', 'effects', 'outbox', 'commands', 'work_events',
]
const schema2Tables = [
  ...schema1Tables, 'action_proposals', 'action_approvals', 'action_grants', 'action_dispatches',
]
const schema3Tables = [
  ...schema2Tables, 'artifacts', 'work_verifications', 'outbox_bindings',
]
const schema4Tables = [
  ...schema3Tables, 'runtime_recovery', 'worker_inputs',
]
const schema5Tables = [
  ...schema4Tables, 'routing_receipts', 'routing_subscriptions', 'routing_deliveries',
]
const schema6Tables = [
  ...schema5Tables, 'budget_reservations', 'attention_policies', 'attention_decisions', 'attention_progress',
]
const sourceTables = { 1: schema1Tables, 2: schema2Tables, 3: schema3Tables, 4: schema4Tables, 5: schema5Tables }
const backupSuffixes = {
  1: V1_BACKUP_SUFFIX, 2: V2_BACKUP_SUFFIX, 3: V3_BACKUP_SUFFIX, 4: V4_BACKUP_SUFFIX, 5: V5_BACKUP_SUFFIX,
}
const migrations = [migration001, migration002, migration003, migration004, migration005, migration006]

function requireTables(db: DatabaseSync, required: readonly string[]): void {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name))
  if (!required.every(table => tables.has(table))) {
    throw new StorageError('corrupt', 'The storage schema is missing required tables')
  }
}

function requireRecoveryAdmission(db: DatabaseSync): void {
  const mode = db.prepare('SELECT mode FROM runtime_recovery WHERE id = 1').get()?.mode
  if (mode !== 'normal' && mode !== 'reconciling' && mode !== 'restore') {
    throw new StorageError('corrupt', 'The storage recovery admission record is invalid')
  }
}

function syncPath(path: string, flags: 'r' | 'r+'): void {
  const descriptor = openSync(path, flags)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/** Snapshot the live connection before DDL, including committed WAL contents. */
function backupBeforeUpgrade(db: DatabaseSync, version: keyof typeof backupSuffixes): void {
  const path = db.location()
  if (!path) throw new StorageError('migration_failed', 'A schema upgrade requires an on-disk backup')
  const directory = dirname(path)
  const backup = path + backupSuffixes[version]
  const existing = lstatSync(backup, { throwIfNoEntry: false })
  const uid = process.getuid?.()
  if (existing && (!existing.isFile() || existing.nlink !== 1
    || (uid !== undefined && (existing.uid !== uid || (existing.mode & 0o777) !== 0o600)))) {
    throw new StorageError('unsafe_path', 'Migration backup path must be an owner-private file')
  }

  const staging = mkdtempSync(join(directory, `.migration-v${SCHEMA_VERSION}-`))
  const temporaryBackup = join(staging, 'snapshot.sqlite')
  try {
    const descriptor = openSync(temporaryBackup, 'wx', 0o600)
    try {
      if (uid !== undefined) fchmodSync(descriptor, 0o600)
    } finally {
      closeSync(descriptor)
    }
    db.prepare('VACUUM main INTO ?').run(temporaryBackup)
    syncPath(temporaryBackup, 'r+')
    renameSync(temporaryBackup, backup)
    if (process.platform !== 'win32') syncPath(directory, 'r')
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Initialize or upgrade the database. The caller holds the profile writer guard. */
export function migrateSchema(db: DatabaseSync): void {
  try {
    const applicationId = db.prepare('PRAGMA application_id').get()?.application_id
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (applicationId === APPLICATION_ID && version === SCHEMA_VERSION) {
      requireTables(db, schema6Tables)
      requireRecoveryAdmission(db)
      return
    }

    const isUpgrade = applicationId === APPLICATION_ID
      && (version === 1 || version === 2 || version === 3 || version === 4 || version === 5)
    const isEmpty = applicationId === 0 && version === 0
      && db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get() === undefined
    if (!isUpgrade && !isEmpty) {
      throw new StorageError('unsupported_schema', 'The database has an unsupported application or schema version')
    }
    if (isUpgrade) {
      requireTables(db, sourceTables[version])
      if (version >= 4) requireRecoveryAdmission(db)
      if (db.prepare('PRAGMA foreign_key_check').get() !== undefined) {
        throw new StorageError('corrupt', 'SQLite foreign key check failed before migration')
      }
      backupBeforeUpgrade(db, version)
    }

    transaction(db, () => {
      for (const migration of migrations.slice(version)) db.exec(migration)
      if (isEmpty) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
      if (db.prepare('PRAGMA foreign_key_check').get() !== undefined) {
        throw new StorageError('migration_failed', 'SQLite foreign key check failed during migration')
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
  } catch (cause) {
    if (cause instanceof StorageError) throw cause
    if (typeof cause === 'object' && cause !== null && 'code' in cause
      && (cause.code === 'ENOSPC' || cause.code === 'EDQUOT')) {
      throw new StorageError('full', 'Storage ran out of space during migration', { cause })
    }
    switch (sqliteCode(cause)) {
      case 5: // SQLITE_BUSY
      case 6: // SQLITE_LOCKED
        throw new StorageError('busy', 'Storage is locked', { cause })
      case 11: // SQLITE_CORRUPT
      case 26: // SQLITE_NOTADB
        throw new StorageError('corrupt', 'Storage could not be read as a SQLite database', { cause })
      case 13: // SQLITE_FULL
        throw new StorageError('full', 'Storage ran out of space during migration', { cause })
      default:
        throw new StorageError('migration_failed', 'Storage schema migration failed', { cause })
    }
  }
}
