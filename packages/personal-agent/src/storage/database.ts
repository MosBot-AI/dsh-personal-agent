import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateSchema, sqliteCode, StorageError } from './schema.js'

export const DATABASE_FILENAME = 'state.sqlite'
export const WRITER_LOCK_FILENAME = 'writer.lock.sqlite'
export const QUARANTINE_FILENAME = 'quarantine'

export interface StorageDatabase {
  readonly db: DatabaseSync
  close(): void
  quarantine(cause: unknown): never
}

function privateEntry(path: string, kind: 'file' | 'directory'): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (!entry) return false
  const uid = process.getuid?.()
  const permissions = kind === 'file' ? 0o600 : 0o700
  if (!(kind === 'file' ? entry.isFile() : entry.isDirectory())
    || (kind === 'file' && entry.nlink !== 1)
    || (uid !== undefined && (entry.uid !== uid || (entry.mode & 0o777) !== permissions))) {
    throw new StorageError('unsafe_path', `Storage requires an owner-private ${kind}`)
  }
  return true
}

function errorIs(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function ensurePrivateFile(path: string): void {
  if (privateEntry(path, 'file')) return
  try {
    closeSync(openSync(path, 'wx', 0o600))
  } catch (error) {
    // Concurrent openers can race only on creating the writer guard file.
    if (!errorIs(error, 'EEXIST')) throw error
  }
  if (!privateEntry(path, 'file')) throw new StorageError('unsafe_path', 'Storage file disappeared')
}

function checkSidecars(path: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) privateEntry(path + suffix, 'file')
}

function isBusy(error: unknown): boolean {
  const code = sqliteCode(error)
  return code === 5 || code === 6
}

function isCorrupt(error: unknown): boolean {
  const code = sqliteCode(error)
  return (error instanceof StorageError && error.code === 'corrupt') || code === 11 || code === 26
}

function acquireWriter(path: string): DatabaseSync {
  ensurePrivateFile(path)
  checkSidecars(path)
  const writer = new DatabaseSync(path, { timeout: 0 })
  try {
    // An OS-backed lock is released by SQLite on close or process death. The
    // lock file stays at the same path so openers always contend on one inode.
    writer.exec('BEGIN EXCLUSIVE')
    return writer
  } catch (error) {
    writer.close()
    if (isBusy(error)) throw new StorageError('busy', 'The storage writer is already open', { cause: error })
    throw error
  }
}

function writeQuarantineMarker(directory: string, marker: string): void {
  let descriptor: number
  try {
    descriptor = openSync(marker, 'wx', 0o600)
  } catch (error) {
    if (errorIs(error, 'EEXIST')) return
    throw error
  }
  try {
    writeFileSync(descriptor, 'Storage requires recovery before reopening.\n')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  if (process.platform !== 'win32') {
    const parent = openSync(directory, 'r')
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
  }
}

/** A single-user desktop reservation shared by every local profile. */
export function reserveLocalDesktop(): (() => void) | undefined {
  const uid = process.getuid?.()
  if (uid === undefined) return undefined
  const directory = `/tmp/dshpa-desktop-${uid}`
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!privateEntry(directory, 'directory')) return undefined
    const lock = acquireWriter(join(directory, WRITER_LOCK_FILENAME))
    return () => lock.close()
  } catch (error) {
    if (error instanceof StorageError && error.code === 'busy') return undefined
    throw error
  }
}

/** Open one synchronous store. The writer guard covers validation, migration, and quarantine. */
export function openStorageDatabase(directory: string): StorageDatabase {
  const root = resolve(directory)
  if (!privateEntry(root, 'directory')) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (!privateEntry(root, 'directory')) throw new StorageError('unsafe_path', 'Storage directory disappeared')
  }
  const writer = acquireWriter(join(root, WRITER_LOCK_FILENAME))
  const path = join(root, DATABASE_FILENAME)
  const marker = join(root, QUARANTINE_FILENAME)
  let db: DatabaseSync | undefined

  function close(): void {
    // Keep the guard until the application connection has closed.
    if (db?.isOpen) db.close()
    if (writer.isOpen) writer.close()
  }

  function quarantine(cause: unknown): never {
    if (!writer.isOpen || !writer.isTransaction) throw new StorageError('closed', 'The storage writer is closed', { cause })
    const failures = [cause]
    try {
      // Quarantine in place. Keep the database and any SQLite sidecars where
      // the owner can inspect or recover them. Never replace them with a new DB.
      writeQuarantineMarker(root, marker)
    } catch (error) {
      failures.push(error)
    }
    try {
      close()
    } catch (error) {
      failures.push(error)
    }
    throw new StorageError('corrupt', 'Storage requires recovery before reopening', {
      cause: failures.length === 1 ? cause : new AggregateError(failures, 'Storage quarantine failed'),
    })
  }

  try {
    if (lstatSync(marker, { throwIfNoEntry: false })) {
      throw new StorageError('corrupt', 'Storage is quarantined and requires recovery')
    }
    checkSidecars(path)
    ensurePrivateFile(path)
    db = new DatabaseSync(path, { timeout: 0, enableForeignKeyConstraints: true })
    if (db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') {
      throw new StorageError('corrupt', 'SQLite integrity check failed')
    }
    migrateSchema(db)
    if (db.prepare('PRAGMA foreign_key_check').get() !== undefined) {
      throw new StorageError('corrupt', 'SQLite foreign key check failed')
    }
    if (db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode !== 'wal') {
      throw new StorageError('migration_failed', 'SQLite could not enter WAL mode')
    }
    db.exec('PRAGMA synchronous = FULL')
    checkSidecars(path)
    return { db, close, quarantine }
  } catch (error) {
    if (isCorrupt(error)) quarantine(error)
    close()
    if (isBusy(error)) throw new StorageError('busy', 'The storage database is busy', { cause: error })
    if (sqliteCode(error) === 13) throw new StorageError('full', 'The storage database is full', { cause: error })
    throw error
  }
}
