import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readSync, realpathSync, rmSync, unlinkSync, type Stats,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { APPLICATION_ID, SCHEMA_VERSION, sqliteCode, StorageError } from './schema.js'

const SNAPSHOT_NAME = /^dshpa-work-(\d{13})-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.sqlite$/
const DAY_MS = 86_400_000
export const DEFAULT_BACKUP_RETENTION = Object.freeze({ maxBackups: 7, maxAgeDays: 30 })

export interface WorkBackup {
  readonly name: string
  readonly path: string
  readonly createdAt: string
  readonly bytes: number
}

export interface BackupRetention {
  readonly maxBackups?: number
  readonly maxAgeDays?: number
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function backupDirectory(input: string, create: boolean): string {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) {
    throw new StorageError('invalid_input', 'An absolute backup directory is required')
  }
  const requested = resolve(input)
  const path = join(realpathSync(dirname(requested)), basename(requested))
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }
  const entry = lstatSync(path)
  const uid = process.getuid?.()
  if (!entry.isDirectory() || (uid !== undefined && (entry.uid !== uid || (entry.mode & 0o777) !== 0o700))) {
    throw new StorageError('unsafe_path', 'Backup directory must be an owner-private directory')
  }
  return path
}

function syncPath(path: string, flags: 'r' | 'r+'): void {
  const descriptor = openSync(path, flags)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function operationError(error: unknown): unknown {
  if (error instanceof StorageError || (error instanceof Error && error.name === 'AbortError')) return error
  const code = errorCode(error)
  const sqlite = sqliteCode(error)
  if (code === 'ENOSPC' || code === 'EDQUOT' || sqlite === 13) {
    return new StorageError('full', 'Storage ran out of space during backup maintenance', { cause: error })
  }
  if (sqlite === 11 || sqlite === 26) return new StorageError('corrupt', 'SQLite snapshot could not be read', { cause: error })
  if (code === 'EEXIST') return new StorageError('conflict', 'Backup destination already exists', { cause: error })
  if (sqlite === 5 || sqlite === 6) return new StorageError('busy', 'SQLite backup could not acquire its snapshot', { cause: error })
  return new StorageError('migration_failed', 'Work backup maintenance failed', { cause: error })
}

function validateSnapshot(path: string): void {
  const snapshot = new DatabaseSync(path, { timeout: 0 })
  try {
    if (snapshot.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID
      || snapshot.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
      || snapshot.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok'
      || snapshot.prepare('PRAGMA foreign_key_check').get() !== undefined) {
      throw new StorageError('corrupt', 'SQLite backup failed validation')
    }
    if (snapshot.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode !== 'delete') {
      throw new StorageError('migration_failed', 'SQLite backup could not be made standalone')
    }
  } finally {
    snapshot.close()
  }
}

function isManagedSnapshot(path: string, entry: Stats): boolean {
  const header = Buffer.alloc(100)
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ELOOP') return false
    throw error
  }
  try {
    const current = fstatSync(descriptor)
    if (current.dev !== entry.dev || current.ino !== entry.ino) return false
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) return false
    const version = header.readUInt32BE(60)
    return header.toString('binary', 0, 16) === 'SQLite format 3\0' && header[18] === 1 && header[19] === 1
      && header.readUInt32BE(68) === APPLICATION_ID && version >= 1 && version <= SCHEMA_VERSION
  } finally {
    closeSync(descriptor)
  }
}

/** Pin a committed WAL snapshot on a read-only connection while the WorkStore keeps writing. */
export async function createWorkBackup(sourcePath: string, destination: string, signal?: AbortSignal): Promise<WorkBackup> {
  let staging: string | undefined
  let source: DatabaseSync | undefined
  try {
    const checkAbort = () => {
      if (signal?.aborted) throw new DOMException('Work backup was interrupted', 'AbortError')
    }
    checkAbort()
    const directory = backupDirectory(destination, true)
    staging = mkdtempSync(join(directory, '.dshpa-backup-'))
    const temporary = join(staging, 'snapshot.sqlite')
    const descriptor = openSync(temporary, 'wx', 0o600)
    try {
      if (process.getuid) fchmodSync(descriptor, 0o600)
    } finally {
      closeSync(descriptor)
    }

    source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 0 })
    source.exec('BEGIN')
    // The first read establishes the WAL snapshot before backup() yields to the caller.
    if (source.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID) {
      throw new StorageError('corrupt', 'Backup source is not a WorkStore database')
    }
    const createdAt = new Date()
    // The native backup runs in check-phase batches. Wake the poll phase on an
    // otherwise idle host so copy and cancellation progress do not wait on UI traffic.
    const wake = setInterval(() => {}, 20)
    try {
      await backup(source, temporary, { rate: 64, progress: checkAbort })
    } finally {
      clearInterval(wake)
    }
    source.close()
    source = undefined

    checkAbort()
    validateSnapshot(temporary)
    syncPath(temporary, 'r+')
    const bytes = lstatSync(temporary).size
    const name = `dshpa-work-${String(createdAt.getTime()).padStart(13, '0')}-${randomUUID()}.sqlite`
    const path = join(directory, name)
    linkSync(temporary, path)
    try {
      unlinkSync(temporary)
      if (process.platform !== 'win32') {
        syncPath(directory, 'r')
        syncPath(dirname(directory), 'r')
      }
    } catch (error) {
      unlinkSync(path)
      throw error
    }
    return { name, path, createdAt: createdAt.toISOString(), bytes }
  } catch (error) {
    throw operationError(error)
  } finally {
    if (source?.isOpen) source.close()
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true })
  }
}

/** Retain only owner-private managed snapshot files. Leave other files and directories alone. */
export function pruneWorkBackups(destination: string, retention: BackupRetention = {}): { removed: number; remaining: number } {
  const { maxBackups = DEFAULT_BACKUP_RETENTION.maxBackups, maxAgeDays = DEFAULT_BACKUP_RETENTION.maxAgeDays } = retention
  if (!Number.isSafeInteger(maxBackups) || maxBackups < 1 || maxBackups > 100
    || !Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 3650) {
    throw new StorageError('invalid_input', 'Backup retention bounds are invalid')
  }
  try {
    let directory: string
    try {
      directory = backupDirectory(destination, false)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { removed: 0, remaining: 0 }
      throw error
    }
    const uid = process.getuid?.()
    const cutoff = Date.now() - maxAgeDays * DAY_MS
    let removed = 0
    let remaining = 0
    for (const name of readdirSync(directory).sort().reverse()) {
      const managed = SNAPSHOT_NAME.exec(name)
      if (!managed) continue
      const path = join(directory, name)
      const entry = lstatSync(path, { throwIfNoEntry: false })
      if (!entry?.isFile() || entry.nlink !== 1
        || (uid !== undefined && (entry.uid !== uid || (entry.mode & 0o777) !== 0o600))
        || !isManagedSnapshot(path, entry)) continue
      if (remaining < maxBackups && Number(managed[1]) >= cutoff) {
        remaining++
      } else {
        try {
          unlinkSync(path)
          removed++
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error
        }
      }
    }
    if (removed > 0 && process.platform !== 'win32') syncPath(directory, 'r')
    return { removed, remaining }
  } catch (error) {
    throw operationError(error)
  }
}
