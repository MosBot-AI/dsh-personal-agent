import { describe, expect, it, vi } from 'vitest'
import { desktopApplication, desktopApplicationSchema, linuxApplication, linuxApplicationIdSchema, taskIdSchema } from '../../packages/personal-agent/src/domain/model.js'
import type { IdentityBoundary, OwnerIdentity } from '../../packages/personal-agent/src/policy/identity.js'
import type { WorkStore } from '../../packages/personal-agent/src/storage/store.js'
import type { WorkState } from '../../packages/personal-agent/src/domain/transitions.js'
import { createDesktopControl, desktopConfigSchema } from '../../packages/personal-agent/src/runtime/desktop-control.js'
import { createResourceLeases } from '../../packages/personal-agent/src/runtime/resource-leases.js'

describe('platform-specific desktop target authority', () => {
  it.each(['chromium', 'kde4-konqbrowser', 'org.xfce.Mousepad', 'my_editor'])('preserves exact Linux ID %s', id => {
    expect(linuxApplicationIdSchema.parse(id)).toBe(id)
    const key = linuxApplication(id)
    expect(desktopApplicationSchema.parse(key)).toBe(`linux:${id}`)
    expect(desktopApplication({ capabilities: [`dshpa-desktop:${key}`] })).toBe(key)
    expect(desktopConfigSchema.parse({ linuxApplications: [id] }).linuxApplications).toEqual([id])
  })

  it.each(['', '../editor', 'editor.desktop', '/usr/bin/editor', 'editor --new', 'a;b', 'a\\b', 'a\nb', '.hidden', 'a..b', 'linux:editor', 'a'.repeat(251)])('rejects non-canonical Linux ID %j', id => {
    expect(linuxApplicationIdSchema.safeParse(id).success).toBe(false)
    expect(desktopConfigSchema.safeParse({ linuxApplications: [id] }).success).toBe(false)
    expect(desktopApplicationSchema.safeParse(`linux:${id}`).success).toBe(false)
  })

  it('keeps macOS keys separate and rejects duplicates without normalization', () => {
    expect(desktopConfigSchema.safeParse({ applications: ['chromium'] }).success).toBe(false)
    expect(desktopConfigSchema.safeParse({ applications: ['linux:org.example.Editor'] }).success).toBe(false)
    expect(desktopConfigSchema.safeParse({ linuxApplications: ['chromium', 'chromium'] }).success).toBe(false)
    const config = desktopConfigSchema.parse({ applications: ['org.example.Editor'], linuxApplications: ['org.example.Editor'] })
    expect(config.applications).toEqual(['org.example.Editor'])
    expect(linuxApplication(config.linuxApplications[0]!)).not.toBe(config.applications[0])
    expect(desktopApplication({ capabilities: ['dshpa-desktop:org.example.Editor'] })).toBe('org.example.Editor')
    expect(desktopApplication({ capabilities: ['dshpa-desktop:Linux:chromium'] })).toBeUndefined()
  })

  it('rejects Linux acquisition before lease reservation, provider calls or store reads', async () => {
    const reserve = vi.fn(() => () => {})
    const leases = createResourceLeases({ reserve })
    const owner = { ownerId: 'owner', profileId: 'profile' } as OwnerIdentity
    const token = {}
    const native = vi.fn()
    const getWork = vi.fn()
    const control = createDesktopControl({
      config: desktopConfigSchema.parse({ linuxApplications: ['chromium'] }), leases,
      identity: { resolveOwner: (value: unknown) => value === token ? owner : undefined } as IdentityBoundary,
      store: { getWork } as unknown as WorkStore,
      native, nativeBrowser: vi.fn(),
    })
    try {
      expect(control.targets).toEqual([{ application: 'linux:chromium', unavailableReason: 'linux_binding_unavailable' }])
      expect(control.acquire(owner, token, { ownerId: owner.ownerId, profileId: owner.profileId, taskId: taskIdSchema.parse('task') },
        {} as WorkState, 'linux:chromium')).toEqual({ ok: false, code: 'linux_binding_unavailable' })
      expect(control.activity(owner)).toEqual([])
      expect(reserve).not.toHaveBeenCalled()
      expect(native).not.toHaveBeenCalled()
      expect(getWork).not.toHaveBeenCalled()
    } finally { await control.close() }
  })
})
