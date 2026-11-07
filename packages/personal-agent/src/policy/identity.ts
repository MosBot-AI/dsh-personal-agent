import { z } from 'zod'
import {
  accountIdSchema,
  clientIdSchema,
  deviceIdSchema,
  ownerIdSchema,
  profileIdSchema,
  sessionIdSchema,
  sourceInstanceIdSchema,
  type Profile,
  type ProfileId,
  type UtcInstant,
} from '../domain/model.js'

const ownership = { ownerId: ownerIdSchema, profileId: profileIdSchema }
const ownerMetadataSchema = z.strictObject({
  ...ownership,
  deviceId: deviceIdSchema,
  clientId: clientIdSchema,
  sessionId: sessionIdSchema,
})
const sourceMetadataSchema = z.strictObject({
  ...ownership,
  sourceInstanceId: sourceInstanceIdSchema,
  accountId: accountIdSchema,
})

type Verification = { policyVersion: string; verifiedAt: UtcInstant }
export type OwnerIdentity = Readonly<z.infer<typeof ownerMetadataSchema> & Verification & { role: 'owner' }>
export type SourceIdentity = Readonly<z.infer<typeof sourceMetadataSchema> & Verification & { role: 'source' }>

declare const ownerTokenBrand: unique symbol
declare const sourceTokenBrand: unique symbol
export type OwnerToken = { readonly [ownerTokenBrand]: true }
export type SourceToken = { readonly [sourceTokenBrand]: true }

export interface IdentityBoundary {
  bindOwner(authenticatedMetadata: unknown): OwnerToken | undefined
  bindSource(authenticatedMetadata: unknown): SourceToken | undefined
  resolveOwner(token: unknown): OwnerIdentity | undefined
  resolveSource(token: unknown): SourceIdentity | undefined
  release(token: OwnerToken | SourceToken): void
  currentProfile(profileId: ProfileId): Profile | undefined
}

function exactAssociation<T extends { verifiedAt: UtcInstant }>(entries: readonly T[], matches: (entry: T) => boolean) {
  const candidates = entries.filter(matches)
  return candidates.length === 1 ? candidates[0] : undefined
}

/** The host gives binders only to adapters that have authenticated the metadata independently of content. */
export function createIdentityBoundary(readProfile: (id: ProfileId) => Profile | undefined): IdentityBoundary {
  const owners = new WeakMap<object, OwnerIdentity>()
  const sources = new WeakMap<object, SourceIdentity>()

  function profileFor(id: ProfileId): Profile | undefined {
    const profile = readProfile(id)
    return profile?.id === id ? profile : undefined
  }

  function ownerAssociation(profile: Profile, identity: z.infer<typeof ownerMetadataSchema>) {
    if (profile.ownerId !== identity.ownerId) return undefined
    return exactAssociation(profile.verifiedDevices, device => device.deviceId === identity.deviceId)
  }

  function sourceAssociation(profile: Profile, identity: z.infer<typeof sourceMetadataSchema>) {
    if (profile.ownerId !== identity.ownerId) return undefined
    return exactAssociation(profile.verifiedAccounts, account =>
      account.sourceInstanceId === identity.sourceInstanceId && account.accountId === identity.accountId)
  }

  return Object.freeze<IdentityBoundary>({
    bindOwner(authenticatedMetadata) {
      const result = ownerMetadataSchema.safeParse(authenticatedMetadata)
      if (!result.success) return undefined
      const profile = profileFor(result.data.profileId)
      if (!profile) return undefined
      const association = ownerAssociation(profile, result.data)
      if (!association) return undefined
      const identity = Object.freeze<OwnerIdentity>({
        ...result.data,
        role: 'owner',
        policyVersion: profile.policyVersion,
        verifiedAt: association.verifiedAt,
      })
      const token = Object.freeze({}) as OwnerToken
      owners.set(token, identity)
      return token
    },
    bindSource(authenticatedMetadata) {
      const result = sourceMetadataSchema.safeParse(authenticatedMetadata)
      if (!result.success) return undefined
      const profile = profileFor(result.data.profileId)
      if (!profile) return undefined
      const association = sourceAssociation(profile, result.data)
      if (!association) return undefined
      const identity = Object.freeze<SourceIdentity>({
        ...result.data,
        role: 'source',
        policyVersion: profile.policyVersion,
        verifiedAt: association.verifiedAt,
      })
      const token = Object.freeze({}) as SourceToken
      sources.set(token, identity)
      return token
    },
    resolveOwner(token) {
      if (typeof token !== 'object' || token === null) return undefined
      const identity = owners.get(token)
      if (!identity) return undefined
      const profile = profileFor(identity.profileId)
      if (profile?.policyVersion === identity.policyVersion
        && ownerAssociation(profile, identity)?.verifiedAt === identity.verifiedAt) return identity
      owners.delete(token)
      return undefined
    },
    resolveSource(token) {
      if (typeof token !== 'object' || token === null) return undefined
      const identity = sources.get(token)
      if (!identity) return undefined
      const profile = profileFor(identity.profileId)
      if (profile?.policyVersion === identity.policyVersion
        && sourceAssociation(profile, identity)?.verifiedAt === identity.verifiedAt) return identity
      sources.delete(token)
      return undefined
    },
    release(token) {
      owners.delete(token)
      sources.delete(token)
    },
    currentProfile(profileId) {
      const profile = profileFor(profileId)
      return profile === undefined ? undefined : structuredClone(profile)
    },
  })
}
