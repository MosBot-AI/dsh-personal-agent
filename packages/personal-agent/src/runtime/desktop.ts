import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { desktopApplicationSchema } from '../domain/model.js'
import type { ResourceLease, ResourceLeases } from './resource-leases.js'

const windowId = z.int().positive().max(2 ** 32 - 1)
const nativeId = z.string().min(1).max(256)
const appHandle = { appHandle: nativeId }
const element = { ...appHandle, snapshotId: nativeId, elementIndex: z.int().nonnegative() }

const requests = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('getCapabilities'), params: z.strictObject({}) }),
  z.strictObject({ method: z.literal('getApp'), params: z.strictObject({ selector: desktopApplicationSchema }) }),
  z.strictObject({ method: z.literal('getState'), params: z.strictObject({ ...appHandle, windowId: windowId.optional() }) }),
  z.strictObject({ method: z.literal('click'), params: z.strictObject(element) }),
  z.strictObject({ method: z.literal('setValue'), params: z.strictObject({ ...element, value: z.string().max(8_192) }) }),
])

const capabilities = z.object({
  platform: z.literal('macos'),
  sessionLocked: z.boolean().nullable(),
  permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean() }),
  methods: z.array(z.string()).max(64),
})
const selectedApplication = z.object({ ...appHandle, pid: z.int().positive(), bundleId: desktopApplicationSchema })
const state = z.object({ ...appHandle, pid: z.int().positive(), snapshotId: nativeId, windowId: windowId.nullable() })

export type DesktopWait = 'driver_unavailable' | 'screen_locked' | 'permission_required' | 'target_unavailable'
type NativeRequest = z.infer<typeof requests>
type NativeResult = { readonly isError: false; readonly value: unknown }
  | { readonly isError: true; readonly code?: string }
type DesktopFailure = DesktopWait | 'permission_denied' | 'observation_required'
  | 'stale_lease' | 'resource_busy' | 'operation_aborted' | 'operation_failed'
const error = (code: DesktopFailure) => ({ ok: false, code }) as const

const probeMethods = ['getApp', 'getState', 'click', 'setValue']
const environmentCodes: ReadonlyMap<string, DesktopWait> = new Map([
  ['PERMISSION_DENIED', 'permission_required'],
  ['APP_ACCESS_REQUIRED', 'permission_required'],
  ['APP_ACCESS_DENIED', 'permission_required'],
  ['APP_ACCESS_REVOKED', 'permission_required'],
  ['SESSION_LOCKED', 'screen_locked'],
  ['SESSION_UNAVAILABLE', 'screen_locked'],
  ['NATIVE_CLOSED', 'driver_unavailable'],
  ['NATIVE_EOF', 'driver_unavailable'],
  ['NATIVE_EXITED', 'driver_unavailable'],
  ['NATIVE_IO', 'driver_unavailable'],
  ['APP_UNAVAILABLE', 'target_unavailable'],
  ['WINDOW_UNAVAILABLE', 'target_unavailable'],
])

/** A new binding is created for every grant. The DSH provider still enforces its native application consent. */
export function bindDesktopWorkflow(leases: ResourceLeases, lease: ResourceLease, app: string) {
  const target = desktopApplicationSchema.parse(app)
  if (lease.target.kind !== 'desktop') throw new Error('A desktop workflow requires the desktop resource')
  let application: z.infer<typeof selectedApplication> | undefined
  let observed: z.infer<typeof state> | undefined
  let wait: DesktopWait | undefined = 'driver_unavailable'
  let screenRecording: boolean | undefined
  let probed = false
  let parked = false

  function unavailable(reason: DesktopWait) {
    application = undefined
    observed = undefined
    wait = reason
    if (probed) parked = true
    return error(reason)
  }

  return Object.freeze({
    application: target,
    status() {
      return { application: target, wait, screenRecording, lease: leases.inspect(lease) }
    },
    async dispatch(
      raw: unknown, signal: AbortSignal, invoke: (request: NativeRequest, signal: AbortSignal) => Promise<NativeResult>,
    ): Promise<{ ok: true; value: unknown } | ReturnType<typeof error>> {
      const decoded = requests.safeParse(raw)
      if (!decoded.success) return error('permission_denied')
      const request = decoded.data
      const admitted = await leases.run(lease, signal, async scoped => {
        if (parked && wait) return error(wait)
        if (request.method === 'getApp') {
          if (request.params.selector !== target) return error('permission_denied')
          application = undefined
          observed = undefined
        } else if (request.method !== 'getCapabilities') {
          if (wait) return error(wait)
          if (!application || request.params.appHandle !== application.appHandle) return error('permission_denied')
          if (request.method === 'getState') {
            observed = undefined
          } else {
            if (observed?.snapshotId !== request.params.snapshotId || observed.windowId === null) return error('observation_required')
            // A native action can change focus or the AX tree. Consume the observation before dispatch.
            observed = undefined
          }
        }
        if (request.method === 'getApp' && wait) return error(wait)
        const native = await invoke(request, scoped)
        scoped.throwIfAborted()
        if (native.isError) {
          const reason = native.code && environmentCodes.get(native.code)
          return reason ? unavailable(reason) : error('operation_failed')
        }

        if (request.method === 'getCapabilities') {
          const probe = capabilities.safeParse(native.value)
          if (!probe.success || !probeMethods.every(method => probe.data.methods.includes(method))) return unavailable('driver_unavailable')
          screenRecording = probe.data.permissions.screenRecording
          if (probe.data.sessionLocked !== false) return unavailable('screen_locked')
          if (!probe.data.permissions.accessibility) return unavailable('permission_required')
          wait = undefined
          probed = true
        } else if (request.method === 'getApp') {
          const selected = selectedApplication.safeParse(native.value)
          if (!selected.success || selected.data.bundleId !== target) return unavailable('target_unavailable')
          application = selected.data
        } else if (request.method === 'getState') {
          const current = state.safeParse(native.value)
          if (!current.success || current.data.appHandle !== application?.appHandle || current.data.pid !== application.pid
            || (request.params.windowId !== undefined && current.data.windowId !== request.params.windowId)) {
            return unavailable('target_unavailable')
          }
          observed = current.data
        }
        return { ok: true, value: native.value } as const
      })
      return admitted.ok ? admitted.value : admitted
    },
  })
}


/** Expose only the guarded subset. The caller pins the provider's live definition and refuses replacement. */
export function createDesktopTool(
  workflow: ReturnType<typeof bindDesktopWorkflow>,
  nativeTool: () => ToolDefinition | undefined,
): ToolDefinition {
  return {
    name: 'dshpa_desktop',
    description: `Select the approved macOS bundle ID ${workflow.application} with getApp. Use its appHandle with getState before each AX click or setValue. getCapabilities reports readiness.`,
    parameters: { type: 'object', additionalProperties: false, required: ['method', 'params'], properties: {
      method: { type: 'string', enum: ['getCapabilities', 'getApp', 'getState', 'click', 'setValue'] },
      params: { type: 'object', additionalProperties: false, properties: {
        selector: { type: 'string', description: 'Exact approved macOS bundle ID for getApp.' },
        appHandle: { type: 'string', description: 'Current handle from getApp.' },
        windowId: { type: 'integer', description: 'Optional exact window for getState.' },
        snapshotId: { type: 'string', description: 'Fresh getState snapshot ID for an AX action.' },
        elementIndex: { type: 'integer', description: 'Observed element index for click or setValue.' },
        value: { type: 'string', description: 'Text value for setValue.' },
      } },
    } },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      const result = await workflow.dispatch(args, execution.signal, async (request, signal) => {
        const native = nativeTool()
        if (!native || native.name !== 'cua') return { isError: true, code: 'NATIVE_CLOSED' }
        try {
          const value = await native.execute(request, { ...execution, name: native.name, signal })
          return { isError: false, value }
        } catch (cause) {
          const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
            ? cause.code : undefined
          return { isError: true, code }
        }
      })
      return result
    },
  }
}
