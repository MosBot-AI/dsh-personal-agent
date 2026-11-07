import type { RecoveryMode } from '../storage/recovery-state.js'
import type { WatchdogCode, WatchdogSnapshot } from './watchdog.js'

export type HealthPhase = 'starting' | 'reconciling' | 'ready' | 'stopping'
export type HealthReason = WatchdogCode | 'restore_only' | 'storage_unavailable' | 'watchdog_unavailable'

export interface HostReadiness {
  readonly ready: boolean
  readonly phase: HealthPhase
}

export interface HostHealthSnapshot extends HostReadiness {
  readonly live: true
  readonly degraded: readonly { readonly code: HealthReason; readonly count: number }[]
}

export interface HealthOptions {
  readonly readRecoveryMode: () => RecoveryMode
  readonly readWarmReconciliation?: () => boolean
  readonly readWatchdog?: () => WatchdogSnapshot
}

/** Process liveness and execution readiness do not depend on provider health. */
export function createHealth(options: HealthOptions) {
  let lifecycle: HealthPhase = 'starting'
  const liveness = () => ({ live: true } as const)

  function project(includeDegradation: boolean): HostHealthSnapshot {
    let phase = lifecycle
    if (phase === 'starting' || phase === 'stopping') return { ...liveness(), ready: false, phase, degraded: [] }
    const degraded: { code: HealthReason; count: number }[] = []
    try {
      const mode = options.readRecoveryMode()
      if (mode !== 'normal') phase = 'reconciling'
      if (includeDegradation && mode === 'restore') degraded.push({ code: 'restore_only', count: 1 })
    } catch {
      phase = 'reconciling'
      if (includeDegradation) degraded.push({ code: 'storage_unavailable', count: 1 })
    }
    try {
      const watchdog = includeDegradation || !options.readWarmReconciliation ? options.readWatchdog?.() : undefined
      if (options.readWarmReconciliation?.() ?? watchdog?.reconciling) phase = 'reconciling'
      if (includeDegradation && watchdog) degraded.push(...watchdog.degraded)
    } catch {
      if (includeDegradation) degraded.push({ code: 'watchdog_unavailable', count: 1 })
    }
    return { ...liveness(), ready: phase === 'ready', phase, degraded }
  }

  return Object.freeze({
    beginReconciliation() { if (lifecycle === 'starting') lifecycle = 'reconciling' },
    markStarted() { if (lifecycle !== 'stopping') lifecycle = 'ready' },
    stop() { lifecycle = 'stopping' },
    liveness,
    readiness(): HostReadiness {
      const { ready, phase } = project(false)
      return { ready, phase }
    },
    snapshot(): HostHealthSnapshot { return project(true) },
  })
}
