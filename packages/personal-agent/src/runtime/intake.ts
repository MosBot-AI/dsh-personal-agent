import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  generationSchema, nonEmptyTextSchema, projectIdSchema, sourceEventIdSchema, sourceEventSchema,
  taskIdSchema, utcInstantSchema, versionSchema, type SourceEvent, type UtcInstant,
} from '../domain/model.js'
import type { IdentityBoundary } from '../policy/identity.js'
import type { RoutingAuthority } from './subscriptions.js'

const key = nonEmptyTextSchema.max(512)
const classification = nonEmptyTextSchema.max(256)
const target = z.strictObject({ taskId: taskIdSchema.max(512), expectedVersion: versionSchema, generation: generationSchema })
const routingBodySchema = z.strictObject({
  kind: z.enum(['event', 'candidate']),
  projectId: projectIdSchema.max(512),
  text: nonEmptyTextSchema.max(8_192),
  dataScope: z.array(classification).min(1).max(16).refine(labels => new Set(labels).size === labels.length),
  target: target.optional(),
  waitReference: key.optional(),
})
const adapterEventSchema = routingBodySchema.extend({
  externalEventId: key,
  externalRevision: key,
  threadId: key,
  occurredAt: utcInstantSchema,
  actorKind: z.enum(['person', 'service']),
  externalActorId: key,
  url: z.url({ protocol: /^https?$/u }).max(2_048).optional(),
})
const storedBodySchema = routingBodySchema.extend({
  accountVerifiedAt: utcInstantSchema,
  policyVersion: nonEmptyTextSchema,
})
export type RoutingBody = z.infer<typeof routingBodySchema>

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Only a source token issued to an independently authenticated adapter can admit an external event. */
export function authenticateEvent(identity: IdentityBoundary, token: unknown, input: unknown, at: UtcInstant) {
  const source = identity.resolveSource(token)
  if (!source) return { ok: false, code: 'permission_denied' } as const
  const decoded = adapterEventSchema.safeParse(input)
  if (!decoded.success) return { ok: false, code: 'invalid_input' } as const
  const {
    externalEventId, externalRevision, threadId, occurredAt, actorKind, externalActorId, url, ...content
  } = decoded.data
  if (occurredAt > at || (content.kind === 'candidate' && content.waitReference !== undefined)) {
    return { ok: false, code: 'invalid_input' } as const
  }
  const { ownerId, profileId, sourceInstanceId, accountId, policyVersion, verifiedAt } = source
  const actor = { kind: actorKind, externalActorId, accountId }
  const body = {
    kind: content.kind, projectId: content.projectId, text: content.text, dataScope: [...content.dataScope].sort(),
    ...(content.target === undefined ? {} : { target: content.target }),
    ...(content.waitReference === undefined ? {} : { waitReference: content.waitReference }),
  }
  const provenance = url === undefined ? {} : { url }
  const id = sourceEventIdSchema.parse(`routing-${digest([sourceInstanceId, externalEventId, externalRevision])}`)
  const event = sourceEventSchema.parse({
    id, ownerId, profileId, sourceInstanceId, externalEventId, externalRevision, threadId, occurredAt, receivedAt: at,
    actor, body: { ...body, accountVerifiedAt: verifiedAt, policyVersion }, provenance,
  })
  return { ok: true, event, body, authority: { policyVersion, verifiedAt },
    digest: digest([ownerId, profileId, threadId, occurredAt, actor, body, provenance]) } as const
}

/** Recheck the source association across queue waits and Worker handbacks. */
export function currentRoutingBody(identity: IdentityBoundary, event: SourceEvent, authority: RoutingAuthority): RoutingBody | undefined {
  const parsed = storedBodySchema.safeParse(event.body)
  const { accountId } = event.actor
  if (!parsed.success || !accountId || !event.threadId || event.actor.deviceId !== undefined) return undefined
  const { accountVerifiedAt, policyVersion, ...body } = parsed.data
  if (accountVerifiedAt !== authority.verifiedAt || policyVersion !== authority.policyVersion) return undefined
  const profile = identity.currentProfile(event.profileId)
  if (profile?.ownerId !== event.ownerId || profile.policyVersion !== authority.policyVersion) return undefined
  const matches = profile.verifiedAccounts.filter(account =>
    account.sourceInstanceId === event.sourceInstanceId && account.accountId === accountId)
  return matches.length === 1 && matches[0]?.verifiedAt === authority.verifiedAt ? body : undefined
}
