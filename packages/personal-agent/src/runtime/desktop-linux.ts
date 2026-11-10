import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { DesktopWait } from './desktop.js'
import type { ResourceLease, ResourceLeases } from './resource-leases.js'

const request = z.strictObject({ method: z.literal('getCapabilities'), params: z.strictObject({}) })
const permissions = z.object({
  x11: z.boolean(), wayland: z.boolean(), wayland_enabled: z.boolean(),
  atspi: z.boolean(), xsend_event: z.boolean(),
})
const envelope = z.object({ isError: z.literal(false).optional(), structuredContent: permissions })

/** Readiness only: SDK 0.28.0 has no Linux OS-lock probe. Never admit capture or input. */
export function createLinuxDesktopReadiness(
  leases: ResourceLeases, lease: ResourceLease, native: () => ToolDefinition | undefined,
) {
  if (lease.target.kind !== 'desktop') throw new Error('A Linux probe requires the desktop resource')
  const pinned = native()
  let wait: DesktopWait = 'driver_unavailable'
  const tool: ToolDefinition = {
    name: 'dshpa_desktop',
    description: 'Check Linux native desktop readiness. Native observation and input are not enabled.',
    parameters: { type: 'object', additionalProperties: false, required: ['method', 'params'], properties: {
      method: { type: 'string', enum: ['getCapabilities'] },
      params: { type: 'object', additionalProperties: false, properties: {} },
    } },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(raw, execution) {
      if (!request.safeParse(raw).success) return { ok: false, code: 'permission_denied' }
      const admitted = await leases.run(lease, execution.signal, async signal => {
        wait = 'driver_unavailable'
        if (pinned && pinned === native() && pinned.name === 'cua_driver_native__check_permissions') {
          try {
            // The pinned Linux catalog accepts {} only. Never request permissions or expose raw bus addresses.
            const result = envelope.safeParse(await pinned.execute({}, { ...execution, name: pinned.name, signal }))
            signal.throwIfAborted()
            if (result.success) {
              const status = result.data.structuredContent
              wait = status.wayland || status.wayland_enabled ? 'unsupported_desktop'
                : !status.x11 || !status.atspi || !status.xsend_event ? 'permission_required'
                : 'session_state_unavailable'
            }
          } catch { /* Missing/malformed/failed native capability checks remain unavailable. */ }
        }
        // desktop_unlocked is a capture-scope grant, not an OS lock-screen observation.
        return { ok: false, code: wait } as const
      })
      return admitted.ok ? admitted.value : admitted
    },
  }
  return { tool, waiting: () => wait, probes: () => [{ method: 'getCapabilities', params: {} }] }
}
