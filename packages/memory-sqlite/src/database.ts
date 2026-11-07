import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ProviderFailureCode } from '@mosbot-ai/dshpa-plugin-api'

export const MEMORY_DATABASE_FILENAME = 'memory.sqlite'
const APPLICATION_ID = 0x44534d31 // DSM1
const SCHEMA_VERSION = 1

export class MemoryStorageError extends Error {
  constructor(readonly code: ProviderFailureCode) { super('The memory store is unavailable') }
}

export function memoryFailure(error: unknown): ProviderFailureCode {
  if (error instanceof MemoryStorageError) return error.code
  if (typeof error === 'object' && error !== null && 'errcode' in error && typeof error.errcode === 'number') {
    const code = error.errcode & 0xff
    if (code === 5 || code === 6) return 'busy'
    if (code === 19) return 'conflict'
  }
  return 'provider_unavailable'
}

function privateEntry(path: string, kind: 'directory' | 'file'): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) return false
  const uid = process.getuid?.()
  const mode = kind === 'directory' ? 0o700 : 0o600
  if (!(kind === 'directory' ? info.isDirectory() : info.isFile() && info.nlink === 1)
    || (uid !== undefined && (info.uid !== uid || (info.mode & 0o777) !== mode))) {
    throw new MemoryStorageError('invalid_config')
  }
  return true
}

function ensureFile(path: string): void {
  if (privateEntry(path, 'file')) return
  try {
    closeSync(openSync(path, 'wx', 0o600))
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  if (!privateEntry(path, 'file')) throw new MemoryStorageError('invalid_config')
}

function checkSidecars(path: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) privateEntry(path + suffix, 'file')
}

/** Keep provider transactions synchronous and roll back every partial mutation. */
export function writeTransaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = write()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

function initialize(db: DatabaseSync): void {
  writeTransaction(db, () => {
    const app = db.prepare('PRAGMA application_id').get()?.application_id
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (app === APPLICATION_ID && version === SCHEMA_VERSION) {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_records'").get()) {
        throw new MemoryStorageError('provider_unavailable')
      }
      return
    }
    if (app !== 0 || version !== 0 || db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
      throw new MemoryStorageError('invalid_config')
    }
    db.exec(`
      CREATE TABLE memory_records (
        scope_key TEXT NOT NULL,
        id TEXT NOT NULL,
        record TEXT NOT NULL CHECK (length(CAST(record AS BLOB)) <= 131072
          AND json_type(record) IS 'object' AND (record ->> '$.id') IS id),
        PRIMARY KEY (scope_key, id)
      ) STRICT, WITHOUT ROWID;
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
  })
}

export function openMemoryDatabase(directory: string): DatabaseSync {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new MemoryStorageError('invalid_config')
  const root = resolve(directory)
  if (!privateEntry(root, 'directory')) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (!privateEntry(root, 'directory')) throw new MemoryStorageError('invalid_config')
  }
  const path = join(root, MEMORY_DATABASE_FILENAME)
  checkSidecars(path)
  ensureFile(path)
  const db = new DatabaseSync(path, { timeout: 0 })
  try {
    if (db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') throw new MemoryStorageError('provider_unavailable')
    initialize(db)
    if (db.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode !== 'delete') throw new MemoryStorageError('provider_unavailable')
    db.exec('PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF')
    checkSidecars(path)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
