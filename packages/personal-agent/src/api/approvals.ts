import type { InboxApproval } from '../inbox/protocol.js'
import type { PendingApproval } from '../policy/dispatch.js'
import type { IdentityBoundary, OwnerToken } from '../policy/identity.js'
import type { WorkStore } from '../storage/store.js'
import type { MobileDeviceLedger, MobileDeviceScope } from './devices.js'

export function projectApproval({ approval, action, version, mobileDeviceId }: PendingApproval): InboxApproval {
  return {
    id: approval.id, taskId: approval.taskId, version, digest: approval.action.payloadDigest,
    expiresAt: approval.expiresAt, kind: action.kind, accountId: action.accountId, resourceRef: action.resourceRef,
    ...(action.recipient === undefined ? {} : { recipient: action.recipient }),
    ...(mobileDeviceId === undefined ? {} : { mobileDeviceId }),
    dataScope: action.dataScope,
    preview: JSON.stringify(action.payload, null, 2),
  }
}

/** Mobile credentials can act only on reviews assigned through the local owner inbox. */
export function createMobileApprovals(scope: MobileDeviceScope, devices: MobileDeviceLedger, identity: IdentityBoundary,
  store: WorkStore, gate: ReturnType<WorkStore['createActionGate']>) {
  function bindDevice(deviceId: string): OwnerToken | undefined {
    // The identity boundary checks that this exact device is currently enrolled.
    return identity.bindOwner({ ...scope, deviceId, clientId: 'dshpa-mobile-web', sessionId: deviceId })
  }

  function withDevice<T>(credential: unknown, use: (token: OwnerToken) => T) {
    const device = devices.authenticate(credential)
    const token = device && bindDevice(device.deviceId)
    if (!token) return { ok: false, code: 'unauthorized' } as const
    try { return use(token) }
    finally { identity.release(token) }
  }

  const pending = (token: OwnerToken) => gate.pending(token, store.listInboxWork(scope).map(({ task }) => task.id))
  return Object.freeze({
    assign(fence: unknown, localOwner: unknown, deviceId: string) {
      if (!devices.verifiedDevices().some(device => device.deviceId === deviceId)) {
        return { ok: false, code: 'permission_denied' } as const
      }
      const target = bindDevice(deviceId)
      if (!target) return { ok: false, code: 'permission_denied' } as const
      try { return gate.assignMobileReview(fence, localOwner, target) }
      finally { identity.release(target) }
    },
    list(credential: unknown) {
      return withDevice(credential, token => ({
        ok: true as const,
        approvals: pending(token).map(projectApproval),
      }))
    },
    revision(credential: unknown) {
      return withDevice(credential, token => ({
        ok: true as const, value: JSON.stringify(pending(token).map(({ approval, version }) => [approval.id, version])),
      }))
    },
    respond(credential: unknown, response: unknown) {
      return withDevice(credential, token => {
        const result = gate.respond(response, token)
        if (result.ok) return { ok: true, status: result.status } as const
        // Do not disclose whether an approval outside the assigned set exists.
        return result.code === 'permission_denied' || result.code === 'not_found'
          ? { ok: false, code: 'not_found' } as const : result
      })
    },
  })
}

export type MobileApprovals = ReturnType<typeof createMobileApprovals>
