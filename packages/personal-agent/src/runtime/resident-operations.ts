import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { WorkRef, WorkStore } from '../storage/store.js'
import { StorageError } from '../storage/schema.js'
import { createHealth } from './health.js'
import { createWatchdog, watchdogConfigSchema, type WatchdogOptions } from './watchdog.js'

export const residentConfigSchema = z.strictObject({
  backupDirectory: z.string().refine(path => isAbsolute(path) && !path.includes('\0')).optional(),
  maxBackups: z.int().min(1).max(100).default(7),
  maxBackupAgeDays: z.int().min(1).max(3_650).default(30),
  watchdog: watchdogConfigSchema.optional(),
})

type Scope = Pick<WorkRef, 'ownerId' | 'profileId'>

/** Owner operations share the resident WorkStore and never run a second native profile. */
export function createResidentOperations(options: {
  readonly store: WorkStore
  readonly directory: string
  readonly config: z.infer<typeof residentConfigSchema>
  readonly readWorker: WatchdogOptions['readWorker']
  readonly reconcileWarm: WatchdogOptions['reconcileWarm']
}) {
  const { store, config } = options
  const watchdog = createWatchdog({ readWorker: options.readWorker, reconcileWarm: options.reconcileWarm, config: config.watchdog })
  const health = createHealth({ readRecoveryMode: () => store.recoveryMode(), readWatchdog: watchdog.snapshot,
    readWarmReconciliation: watchdog.isReconciling })
  let backupActive: Promise<unknown> | undefined
  const closing = new AbortController()
  const directory = config.backupDirectory ?? join(options.directory, 'resident-backups')
  const retention = { maxBackups: config.maxBackups, maxAgeDays: config.maxBackupAgeDays }
  let nativeReady = false
  let recovered = false
  let startupIssue: 'owner_link_unavailable' | 'recovery_unavailable' | 'schedule_reconcile_unavailable' | undefined

  function readyWhenSettled() {
    if (nativeReady && recovered) health.markStarted()
  }

  async function backup() {
    if (closing.signal.aborted) throw new StorageError('closed', 'Resident operations are stopping')
    if (backupActive) throw new StorageError('busy', 'A resident backup is already in progress')
    const pending = (async () => {
      const result = await store.createBackup(directory, { signal: closing.signal })
      const snapshot = { name: result.name, createdAt: result.createdAt, bytes: result.bytes }
      try {
        return { backup: snapshot, retention: { status: 'applied' as const, ...store.pruneBackups(directory, retention) } }
      } catch {
        return { backup: snapshot, retention: { status: 'unavailable' as const } }
      }
    })()
    backupActive = pending
    try { return await pending } finally { backupActive = undefined }
  }

  return Object.freeze({
    health,
    observe: watchdog.observe,
    beginRecovery: health.beginReconciliation,
    ownerReady() { nativeReady = true; readyWhenSettled(); watchdog.start() },
    ownerUnavailable() { startupIssue = 'owner_link_unavailable' },
    recoverySettled(scheduleError: boolean) {
      recovered = true
      if (scheduleError && startupIssue === undefined) startupIssue = 'schedule_reconcile_unavailable'
      readyWhenSettled()
    },
    recoveryUnavailable() { startupIssue = 'recovery_unavailable' },
    status(scope: Scope) {
      return { health: health.snapshot(), diagnostics: watchdog.diagnostics(scope),
        ...(startupIssue === undefined ? {} : { startupIssue }) }
    },
    backup,
    audit: (scope: Scope, afterSequence?: number) => store.exportAudit(scope, { afterSequence }),
    async close() {
      health.stop()
      closing.abort()
      await Promise.all([watchdog.stop(), backupActive?.catch(() => undefined)])
    },
  })
}

export type ResidentOperations = ReturnType<typeof createResidentOperations>
