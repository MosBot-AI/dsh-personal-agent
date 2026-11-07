import type { SourceEvent } from '../domain/model.js'
import { ROUTINE_SOURCE } from '../domain/routines.js'
import type { IdentityBoundary } from '../policy/identity.js'
import { currentRoutingBody } from '../runtime/intake.js'
import type { WorkStore } from '../storage/store.js'

export const localInboxSource = 'dshpa-local-inbox'

export function contextSourceLabels(store: WorkStore, identity: IdentityBoundary, event: SourceEvent): readonly string[] | undefined {
  if (event.sourceInstanceId === ROUTINE_SOURCE && event.actor.kind === 'service') return []
  if (event.sourceInstanceId === localInboxSource) {
    const profile = identity.currentProfile(event.profileId)
    const devices = profile?.verifiedDevices.filter(device => device.deviceId === event.actor.deviceId && device.verifiedAt <= event.receivedAt)
    return profile?.ownerId === event.ownerId && event.actor.kind === 'person' && devices?.length === 1 ? [] : undefined
  }
  const routed = store.getRoutingEvent({ ownerId: event.ownerId, profileId: event.profileId, eventId: event.id })
  return routed && currentRoutingBody(identity, event, routed.receipt.authority)?.dataScope
}
