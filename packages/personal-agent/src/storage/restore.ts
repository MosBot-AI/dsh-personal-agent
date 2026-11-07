import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATABASE_FILENAME, openStorageDatabase } from './database.js'
import { APPLICATION_ID, SCHEMA_VERSION, sqliteCode, StorageError, transaction } from './schema.js'

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function requireStandalone(path: string): BigIntStats {
  const file = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  const uid = process.getuid?.()
  if (!file?.isFile() || file.nlink !== 1n
    || (uid !== undefined && (file.uid !== BigInt(uid) || (file.mode & 0o077n) !== 0n))) {
    throw new StorageError('unsafe_path', 'Restore source must be an owner-private snapshot file')
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (lstatSync(path + suffix, { throwIfNoEntry: false })) {
      throw new StorageError('unsafe_path', 'Restore source must not have SQLite sidecars')
    }
  }
  return file
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

function copySnapshot(source: string, destination: string): void {
  const expected = requireStandalone(source)
  const input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!sameFile(expected, fstatSync(input, { bigint: true }))) {
      throw new StorageError('unsafe_path', 'Restore source changed before it could be copied')
    }
    const output = openSync(destination, 'wx', 0o600)
    try {
      if (process.getuid) fchmodSync(output, 0o600)
      const buffer = Buffer.allocUnsafe(256 * 1024)
      let copied = 0n
      for (let count = readSync(input, buffer); count > 0; count = readSync(input, buffer)) {
        for (let offset = 0; offset < count;) {
          const written = writeSync(output, buffer, offset, count - offset)
          if (written === 0) throw new Error('Could not write the restore snapshot')
          offset += written
        }
        copied += BigInt(count)
        if (copied > expected.size) throw new StorageError('unsafe_path', 'Restore source grew during copy')
      }
      if (copied !== expected.size || !sameFile(expected, fstatSync(input, { bigint: true }))
        || !sameFile(expected, requireStandalone(source))) {
        throw new StorageError('unsafe_path', 'Restore source changed during copy')
      }
    } finally {
      closeSync(output)
    }
  } finally {
    closeSync(input)
  }
}

function prepareRestoredDatabase(directory: string, path: string): void {
  // Recognize an owned snapshot before the normal opener can initialize an empty file.
  const snapshot = new DatabaseSync(path, { readOnly: true, timeout: 0 })
  try {
    const applicationId = snapshot.prepare('PRAGMA application_id').get()?.application_id
    const version = snapshot.prepare('PRAGMA user_version').get()?.user_version
    if (applicationId !== APPLICATION_ID || typeof version !== 'number' || version < 1 || version > SCHEMA_VERSION) {
      throw new StorageError('unsupported_schema', 'Restore source is not a supported work snapshot')
    }
  } finally {
    snapshot.close()
  }

  const storage = openStorageDatabase(directory)
  try {
    transaction(storage.db, () => {
      const updated = storage.db.prepare("UPDATE runtime_recovery SET mode = 'restore' WHERE id = 1").run()
      if (updated.changes !== 1) throw new StorageError('corrupt', 'Restore snapshot has no recovery admission record')
    })
    // Publish one standalone file. The normal opener will restore WAL mode.
    if (storage.db.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode !== 'delete') {
      throw new StorageError('migration_failed', 'Could not checkpoint the restored snapshot')
    }
  } finally {
    storage.close()
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

function publish(path: string, directory: string, parent: string): void {
  // mkdir and link are exclusive. A directory rename could overwrite an empty
  // destination created by another process between checking and publishing.
  mkdirSync(directory, { mode: 0o700 })
  let linked = false
  try {
    if (process.getuid) chmodSync(directory, 0o700)
    linkSync(path, join(directory, DATABASE_FILENAME))
    linked = true
    unlinkSync(path)
    if (process.platform !== 'win32') {
      syncPath(directory, 'r')
      syncPath(parent, 'r')
    }
  } catch (error) {
    if (!linked) {
      // A racing store initializer may have written its own files here.
      try { rmdirSync(directory) } catch { /* Preserve anything it created. */ }
    }
    throw error
  }
}

/** Restore a standalone snapshot into a fresh directory in reconciliation-only mode. */
export function restoreWorkStoreBackup(sourceAbsolute: string, destinationAbsolute: string): void {
  if (!isAbsolute(sourceAbsolute) || !isAbsolute(destinationAbsolute)
    || sourceAbsolute.includes('\0') || destinationAbsolute.includes('\0')) {
    throw new StorageError('invalid_input', 'Restore requires absolute snapshot and destination paths')
  }
  let staging: string | undefined
  try {
    const destination = resolve(destinationAbsolute)
    if (lstatSync(destination, { throwIfNoEntry: false })) {
      throw new StorageError('conflict', 'Restore destination already exists')
    }
    const parent = realpathSync(dirname(destination))
    staging = mkdtempSync(join(parent, '.dshpa-restore-'))
    if (process.getuid) chmodSync(staging, 0o700)
    const path = join(staging, DATABASE_FILENAME)
    copySnapshot(resolve(sourceAbsolute), path)
    prepareRestoredDatabase(staging, path)
    syncPath(path, 'r+')
    publish(path, join(parent, basename(destination)), parent)
  } catch (cause) {
    if (cause instanceof StorageError) throw cause
    const code = errorCode(cause)
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new StorageError('conflict', 'Restore destination already exists', { cause })
    }
    if (code === 'ENOSPC' || code === 'EDQUOT' || sqliteCode(cause) === 13) {
      throw new StorageError('full', 'Storage ran out of space during restore', { cause })
    }
    if (sqliteCode(cause) === 11 || sqliteCode(cause) === 26) {
      throw new StorageError('corrupt', 'Restore snapshot could not be read as a SQLite database', { cause })
    }
    throw new StorageError('migration_failed', 'The work snapshot could not be restored', { cause })
  } finally {
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true })
  }
}
