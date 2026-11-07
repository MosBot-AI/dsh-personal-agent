import type { DatabaseSync } from 'node:sqlite'
import { migration001 } from './migrations/001.js'

export const APPLICATION_ID = 0x44534850 // DSHP
export const SCHEMA_VERSION = 1

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

const requiredTables = [
  'projects', 'conversations', 'tasks', 'attempts', 'source_events', 'effects', 'outbox', 'commands', 'work_events',
]

/** Recognize an owned database or install the first schema into an empty database. */
export function migrateSchema(db: DatabaseSync): void {
  try {
    transaction(db, () => {
      const applicationId = db.prepare('PRAGMA application_id').get()?.application_id
      const version = db.prepare('PRAGMA user_version').get()?.user_version
      if (applicationId === APPLICATION_ID && version === SCHEMA_VERSION) {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name))
        if (!requiredTables.every(table => tables.has(table))) {
          throw new StorageError('corrupt', 'The storage schema is missing required tables')
        }
        return
      }
      if (applicationId !== 0 || version !== 0 || db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get() !== undefined) {
        throw new StorageError('unsupported_schema', 'The database has an unsupported application or schema version')
      }

      db.exec(migration001)
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
  } catch (cause) {
    if (cause instanceof StorageError) throw cause
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
