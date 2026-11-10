import { describe, expect, it, vi } from 'vitest'
import { createLinuxDesktopReadiness } from '../../packages/personal-agent/src/runtime/desktop-linux.js'
import { createResourceLeases } from '../../packages/personal-agent/src/runtime/resource-leases.js'

type ToolDefinition = NonNullable<ReturnType<Parameters<typeof createLinuxDesktopReadiness>[2]>>
type ToolRunContext = Parameters<ToolDefinition['execute']>[1]

const ready = { x11: true, wayland: false, wayland_enabled: false, atspi: true, xsend_event: true }
const probe = { method: 'getCapabilities', params: {} }
function fixture(result: unknown) {
  const leases = createResourceLeases()
  const acquired = leases.acquire({ kind: 'desktop' }, { lifetimeMs: 30_000, isCurrent: () => true })
  if (!acquired.ok) throw new Error(acquired.code)
  const execute = vi.fn(async () => result)
  let native = { name: 'cua_driver_native__check_permissions', execute } as unknown as ToolDefinition
  const workflow = createLinuxDesktopReadiness(leases, acquired.value, () => native)
  const execution = { name: 'dshpa_desktop', signal: new AbortController().signal } as ToolRunContext
  return { leases, lease: acquired.value, workflow, execute,
    replace: () => { native = { ...native } },
    run: (args: unknown = probe) => workflow.tool.execute(args, execution) }
}

describe('Linux native readiness admission', () => {
  it('uses strict empty native arguments and never treats capture grants as OS unlock evidence', async () => {
    const f = fixture({ structuredContent: { ...ready, desktop_unlocked: true, desktop_capture_authorized: true,
      dbus_session_bus_address: 'private-address' } })
    try {
      expect(await f.run()).toEqual({ ok: false, code: 'session_state_unavailable' })
      expect(f.execute).toHaveBeenCalledWith({}, expect.objectContaining({ name: 'cua_driver_native__check_permissions' }))
      expect(f.workflow.waiting()).toBe('session_state_unavailable')
      expect(await f.run({ method: 'click', params: {} })).toEqual({ ok: false, code: 'permission_denied' })
      expect(await f.run({ method: 'getState', params: {} })).toEqual({ ok: false, code: 'permission_denied' })
      expect(await f.run({ method: 'getCapabilities', params: { prompt: true } })).toEqual({ ok: false, code: 'permission_denied' })
      expect(f.execute).toHaveBeenCalledTimes(1)
    } finally { await f.leases.close() }
  })

  it.each([
    [{ structuredContent: { ...ready, wayland: true } }, 'unsupported_desktop'],
    [{ structuredContent: { ...ready, wayland_enabled: true } }, 'unsupported_desktop'],
    [{ structuredContent: { ...ready, x11: false } }, 'permission_required'],
    [{ structuredContent: { ...ready, atspi: false } }, 'permission_required'],
    [{ structuredContent: { ...ready, xsend_event: false } }, 'permission_required'],
    [{ structuredContent: {} }, 'driver_unavailable'],
    [{ isError: true, structuredContent: ready }, 'driver_unavailable'],
    [{ content: [{ type: 'text', text: JSON.stringify(ready) }] }, 'driver_unavailable'],
  ])('fails closed for unsupported or unverified evidence %j', async (result, code) => {
    const f = fixture(result)
    try { expect(await f.run()).toEqual({ ok: false, code }) }
    finally { await f.leases.close() }
  })

  it('pins provider identity and fences takeover before any native call', async () => {
    const f = fixture({ structuredContent: ready })
    try {
      f.replace()
      expect(await f.run()).toEqual({ ok: false, code: 'driver_unavailable' })
      expect(f.execute).not.toHaveBeenCalled()
      expect(f.leases.takeover(f.lease)).toBe(true)
      expect(await f.run()).toEqual({ ok: false, code: 'stale_lease' })
      expect(f.execute).not.toHaveBeenCalled()
    } finally { await f.leases.close() }
  })

  it('discards an in-flight capability response after takeover', async () => {
    const f = fixture(undefined)
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<unknown>()
    f.execute.mockImplementation(async () => { entered.resolve(); return response.promise })
    try {
      const pending = f.run()
      await entered.promise
      expect(f.leases.takeover(f.lease)).toBe(true)
      response.resolve({ structuredContent: ready })
      expect(await pending).toEqual({ ok: false, code: 'operation_aborted' })
      expect(f.workflow.waiting()).toBe('driver_unavailable')
      expect(f.execute).toHaveBeenCalledTimes(1)
    } finally { await f.leases.close() }
  })

  it('does not retry a refused native probe', async () => {
    const f = fixture(undefined)
    f.execute.mockRejectedValue(new Error('refused'))
    try {
      expect(await f.run()).toEqual({ ok: false, code: 'driver_unavailable' })
      expect(f.execute).toHaveBeenCalledTimes(1)
    } finally { await f.leases.close() }
  })
})
