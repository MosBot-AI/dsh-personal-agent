import { randomUUID } from 'node:crypto'

export type ResourceTarget =
  | { readonly kind: 'desktop' }
  | { readonly kind: 'browser'; readonly profileId: string; readonly tabId?: string }

type LeasePhase = 'automation' | 'human' | 'draining'
type LeaseFailure = 'stale_lease' | 'resource_busy' | 'operation_aborted' | 'operation_failed'
export type LeaseResult<T> = { ok: true; value: T } | { ok: false; code: LeaseFailure }

export interface ResourceLease {
  readonly id: string
  readonly target: ResourceTarget
  readonly expiresAt: number
}

export interface ResourceLeaseState {
  readonly phase: LeasePhase
  readonly inFlight: boolean
}

interface LeaseOptions {
  readonly lifetimeMs: number
  readonly isCurrent: () => boolean
}

interface Entry {
  readonly lease: ResourceLease
  readonly controller: AbortController
  readonly options: LeaseOptions
  readonly releaseReservation?: () => void
  timer?: ReturnType<typeof setTimeout>
  phase: LeasePhase
  active?: Promise<unknown>
  browserTab?: string
}

const fail = (code: LeaseFailure) => ({ ok: false, code }) as const
const maxLifetimeMs = 30 * 60_000

function conflicts(left: ResourceTarget, right: ResourceTarget): boolean {
  if (left.kind === 'desktop' || right.kind === 'desktop') return left.kind === right.kind
  return left.profileId === right.profileId
    && (left.tabId === undefined || right.tabId === undefined || left.tabId === right.tabId)
}

function stillCurrent(options: LeaseOptions): boolean {
  try { return options.isCurrent() === true } catch { return false }
}

/** Trusted host leases. Public controls resolve opaque IDs to these host-owned objects after authentication. */
export function createResourceLeases({
  now = Date.now, reserve,
}: {
  now?: () => number
  reserve?: (target: ResourceTarget) => (() => void) | undefined
} = {}) {
  const entries = new Map<ResourceLease, Entry>()
  let closed = false

  function remove(entry: Entry): void {
    clearTimeout(entry.timer)
    entry.releaseReservation?.()
    entries.delete(entry.lease)
  }

  function retire(entry: Entry): void {
    entry.phase = 'draining'
    clearTimeout(entry.timer)
    entry.controller.abort()
    if (entry.active === undefined && entries.has(entry.lease)) remove(entry)
  }

  function find(lease: ResourceLease): Entry | undefined {
    const entry = entries.get(lease)
    if (!entry || entry.phase === 'draining') return entry
    if (now() >= entry.lease.expiresAt || !stillCurrent(entry.options)) retire(entry)
    return entries.get(lease)
  }

  function mint(target: ResourceTarget, options: LeaseOptions, releaseReservation?: () => void): Entry {
    const lease = Object.freeze({ id: randomUUID(), target: Object.freeze({ ...target }), expiresAt: now() + options.lifetimeMs })
    const entry: Entry = { lease, options, releaseReservation, controller: new AbortController(), phase: 'automation' }
    entry.timer = setTimeout(() => retire(entry), options.lifetimeMs)
    entry.timer.unref()
    entries.set(lease, entry)
    return entry
  }

  function valid(options: LeaseOptions): boolean {
    return !closed && Number.isInteger(options.lifetimeMs) && options.lifetimeMs > 0
      && options.lifetimeMs <= maxLifetimeMs && stillCurrent(options)
  }

  return Object.freeze({
    acquire(target: ResourceTarget, options: LeaseOptions): LeaseResult<ResourceLease> {
      if (!valid(options)) return fail('stale_lease')
      for (const lease of entries.keys()) {
        if (conflicts(lease.target, target) && find(lease)) return fail('resource_busy')
      }
      const reservation = reserve?.(target)
      if (reserve && !reservation) return fail('resource_busy')
      return { ok: true, value: mint(target, options, reservation).lease }
    },
    signal(lease: ResourceLease): AbortSignal {
      return find(lease)?.controller.signal ?? AbortSignal.abort()
    },
    inspect(lease: ResourceLease): ResourceLeaseState | undefined {
      const entry = find(lease)
      return entry && { phase: entry.phase, inFlight: entry.active !== undefined }
    },
    pinBrowserTab(lease: ResourceLease, tabId: string): boolean {
      const entry = find(lease)
      if (lease.target.kind !== 'browser' || entry?.phase !== 'automation' || !entry.active || !tabId
        || (lease.target.tabId !== undefined && lease.target.tabId !== tabId)
        || (entry.browserTab !== undefined && entry.browserTab !== tabId)) return false
      entry.browserTab = tabId
      return true
    },
    ownsBrowserTab(lease: ResourceLease, tabId: string): boolean {
      const entry = find(lease)
      return entry?.phase === 'automation' && entry.browserTab === tabId
    },
    async run<T>(lease: ResourceLease, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<LeaseResult<T>> {
      const entry = find(lease)
      if (entry?.phase !== 'automation') return fail('stale_lease')
      if (entry.active) return fail('resource_busy')
      const scoped = AbortSignal.any([signal, entry.controller.signal])
      const pending = Promise.resolve().then(async (): Promise<LeaseResult<T>> => {
        if (find(lease)?.phase !== 'automation' || scoped.aborted) return fail('operation_aborted')
        try {
          const value = await operation(scoped)
          return find(lease)?.phase === 'automation' && !scoped.aborted
            ? { ok: true, value } : fail('operation_aborted')
        } catch {
          return find(lease)?.phase === 'automation' && !scoped.aborted
            ? fail('operation_failed') : fail('operation_aborted')
        }
      })
      entry.active = pending
      try { return await pending } finally {
        entry.active = undefined
        if (entries.get(lease)?.phase === 'draining') remove(entry)
      }
    },
    takeover(lease: ResourceLease): boolean {
      const entry = find(lease)
      if (entry?.phase === 'human') return true
      if (entry?.phase !== 'automation') return false
      entry.phase = 'human'
      entry.controller.abort()
      return true
    },
    resume(lease: ResourceLease, options: LeaseOptions): LeaseResult<ResourceLease> {
      const entry = find(lease)
      if (entry?.phase !== 'human' || !valid(options)) return fail('stale_lease')
      if (entry.active) return fail('resource_busy')
      clearTimeout(entry.timer)
      entries.delete(lease)
      return { ok: true, value: mint(lease.target, options, entry.releaseReservation).lease }
    },
    release(lease: ResourceLease): boolean {
      const entry = find(lease)
      if (!entry) return false
      retire(entry)
      return true
    },
    async close(): Promise<void> {
      closed = true
      const pending: Promise<unknown>[] = []
      for (const entry of entries.values()) {
        if (entry.active) pending.push(entry.active)
        retire(entry)
      }
      await Promise.allSettled(pending)
    },
  })
}

export type ResourceLeases = ReturnType<typeof createResourceLeases>
