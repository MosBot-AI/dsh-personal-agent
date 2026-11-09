import { describe, expect, it, vi } from 'vitest'
import { bindDesktopWorkflow } from '../../packages/personal-agent/src/runtime/desktop.js'
import { createResourceLeases, type LeaseResult } from '../../packages/personal-agent/src/runtime/resource-leases.js'

const desktop = { kind: 'desktop' } as const
const ownerGrant = { lifetimeMs: 30_000, isCurrent: () => true }
const signal = () => new AbortController().signal

function value<T>(result: LeaseResult<T>): T {
  if (!result.ok) throw new Error(result.code)
  return result.value
}

describe('desktop and browser resource leases', () => {
  it('holds the physical reservation through takeover and makes continuation use a fresh lease', async () => {
    const release = vi.fn()
    const leases = createResourceLeases({ reserve: () => release })
    const lease = value(leases.acquire(desktop, ownerGrant))
    const entered = Promise.withResolvers<AbortSignal>()
    const drain = Promise.withResolvers<string>()
    const pending = leases.run(lease, signal(), async scoped => {
      entered.resolve(scoped)
      return drain.promise
    })
    const scoped = await entered.promise
    const forbidden = vi.fn(async () => 'must never run')
    expect(leases.takeover(lease)).toBe(true)
    expect(scoped.aborted).toBe(true)
    expect(leases.inspect(lease)).toEqual({ phase: 'human', inFlight: true })
    expect(await leases.run(lease, signal(), forbidden)).toEqual({ ok: false, code: 'stale_lease' })
    expect(leases.acquire(desktop, ownerGrant)).toEqual({ ok: false, code: 'resource_busy' })
    expect(leases.resume(lease, ownerGrant)).toEqual({ ok: false, code: 'resource_busy' })
    expect(release).not.toHaveBeenCalled()
    drain.resolve('late native success')
    expect(await pending).toEqual({ ok: false, code: 'operation_aborted' })
    const fresh = value(leases.resume(lease, ownerGrant))
    expect(fresh.id).not.toBe(lease.id)
    expect(leases.inspect(lease)).toBeUndefined()
    expect(await leases.run({ ...fresh }, signal(), forbidden)).toEqual({ ok: false, code: 'stale_lease' })
    expect(forbidden).not.toHaveBeenCalled()
    await leases.close()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rejects input after expiry or authority changes and drains before releasing a shared slot', async () => {
    let now = 100
    let current = true
    const leases = createResourceLeases({ now: () => now })
    try {
      const lease = value(leases.acquire(desktop, { ...ownerGrant, isCurrent: () => current }))
      const invoke = vi.fn(async () => 'unexpected action')
      const pending = leases.run(lease, signal(), invoke)
      now = lease.expiresAt
      expect(await pending).toEqual({ ok: false, code: 'operation_aborted' })
      expect(invoke).not.toHaveBeenCalled()
      expect(leases.inspect(lease)).toBeUndefined()
      const latest = value(leases.acquire(desktop, { ...ownerGrant, isCurrent: () => current }))
      current = false
      expect(await leases.run(latest, signal(), invoke)).toEqual({ ok: false, code: 'stale_lease' })
      expect(leases.inspect(latest)).toBeUndefined()
    } finally { await leases.close() }
  })

  it('serializes the desktop, and a browser profile lock covers all its tabs', async () => {
    const leases = createResourceLeases()
    const tab = (profileId: string, tabId?: string) => ({ kind: 'browser', profileId, tabId }) as const
    try {
      const profileA = value(leases.acquire(tab('A'), ownerGrant))
      expect(leases.acquire(tab('A', '1'), ownerGrant)).toEqual({ ok: false, code: 'resource_busy' })
      const tabB = value(leases.acquire(tab('B', '1'), ownerGrant))
      expect(leases.acquire(tab('B', '1'), ownerGrant)).toEqual({ ok: false, code: 'resource_busy' })
      expect(leases.acquire(tab('B'), ownerGrant)).toEqual({ ok: false, code: 'resource_busy' })
      expect(leases.acquire(tab('B', '2'), ownerGrant)).toMatchObject({ ok: true })
      expect(leases.acquire(desktop, ownerGrant)).toMatchObject({ ok: true })
      expect(leases.release(profileA)).toBe(true)
      expect(leases.acquire(tab('A', '1'), ownerGrant)).toMatchObject({ ok: true })
      expect(leases.release(tabB)).toBe(true)
    } finally { await leases.close() }
  })
})

describe('desktop provider admission', () => {
  const app = 'com.apple.TextEdit'
  const selection = { method: 'getApp', params: { selector: app } }
  const probe = { method: 'getCapabilities', params: {} }
  const observation = { method: 'getState', params: { appHandle: 'native-app', windowId: 7 } }
  const click = { method: 'click', params: { appHandle: 'native-app', snapshotId: 'snapshot-1', elementIndex: 1 } }
  const probed = { platform: 'macos', sessionLocked: false, permissions: { accessibility: true, screenRecording: false },
    methods: ['getApp', 'getState', 'click', 'setValue'] }
  const selected = { appHandle: 'native-app', pid: 42, bundleId: app }
  const observed = { appHandle: 'native-app', pid: 42, windowId: 7, snapshotId: 'snapshot-1' }
  const nativeValue = (value: unknown) => vi.fn(async () => ({ isError: false as const, value }))

  it('binds the selected app and exact fresh AX observation before input', async () => {
    const leases = createResourceLeases()
    const lease = value(leases.acquire(desktop, ownerGrant))
    const workflow = bindDesktopWorkflow(leases, lease, app)
    const unknown = nativeValue({})
    try {
      expect(await workflow.dispatch(selection, signal(), unknown)).toEqual({ ok: false, code: 'driver_unavailable' })
      expect(await workflow.dispatch(probe, signal(), nativeValue(probed))).toMatchObject({ ok: true })
      expect(await workflow.dispatch({ ...selection, params: { selector: 'com.apple.Terminal' } }, signal(), unknown))
        .toEqual({ ok: false, code: 'permission_denied' })
      expect(await workflow.dispatch(selection, signal(), nativeValue(selected))).toMatchObject({ ok: true })
      expect(await workflow.dispatch(click, signal(), unknown)).toEqual({ ok: false, code: 'observation_required' })
      expect(await workflow.dispatch(observation, signal(), nativeValue(observed))).toMatchObject({ ok: true })
      expect(await workflow.dispatch({ method: 'pressKey', params: { appHandle: 'native-app', key: 'cmd+space' } }, signal(), unknown))
        .toEqual({ ok: false, code: 'permission_denied' })
      expect(await workflow.dispatch(click, signal(), nativeValue({ dispatched: true, verified: false }))).toMatchObject({ ok: true })
      expect(await workflow.dispatch(click, signal(), unknown)).toEqual({ ok: false, code: 'observation_required' })
      expect(unknown).not.toHaveBeenCalled()
    } finally { await leases.close() }
  })

  it('waits on native lock and permission evidence and discards stale observations at continuation', async () => {
    const leases = createResourceLeases()
    const lease = value(leases.acquire(desktop, ownerGrant))
    const first = bindDesktopWorkflow(leases, lease, app)
    try {
      expect(await first.dispatch(probe, signal(), nativeValue({ ...probed, sessionLocked: null })))
        .toEqual({ ok: false, code: 'screen_locked' })
      expect(await first.dispatch(probe, signal(), nativeValue({ ...probed, permissions: { ...probed.permissions, accessibility: false } })))
        .toEqual({ ok: false, code: 'permission_required' })
      await first.dispatch(probe, signal(), nativeValue(probed))
      await first.dispatch(selection, signal(), nativeValue(selected))
      await first.dispatch(observation, signal(), nativeValue(observed))
      expect(await first.dispatch(click, signal(), async () => ({ isError: true, code: 'SESSION_LOCKED' })))
        .toEqual({ ok: false, code: 'screen_locked' })
      expect(first.status().wait).toBe('screen_locked')
      expect(leases.takeover(lease)).toBe(true)
      const second = bindDesktopWorkflow(leases, value(leases.resume(lease, ownerGrant)), app)
      const unknown = nativeValue({})
      expect(await first.dispatch(probe, signal(), unknown)).toEqual({ ok: false, code: 'stale_lease' })
      expect(await second.dispatch(click, signal(), unknown)).toEqual({ ok: false, code: 'driver_unavailable' })
      expect(unknown).not.toHaveBeenCalled()
    } finally { await leases.close() }
  })
})
