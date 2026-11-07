import { z } from 'zod'

export const CAPABILITY_API_VERSION = 1 as const
export const capabilityKindSchema = z.enum(['memory', 'memory-retrieval', 'media', 'creation-workflow'])
export type CapabilityKind = z.infer<typeof capabilityKindSchema>

export const capabilityIdSchema = z.string().min(1).max(256).regex(/^[^\s\p{Cc}]+$/u)
export const capabilityRevisionSchema = z.int().positive()
export const capabilityGenerationSchema = z.int().nonnegative()
export const capabilityInstantSchema = z.iso.datetime({ precision: 3 })
const pluginIdSchema = z.string().max(214).regex(/^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/)
const semverSchema = z.string().max(80).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i)

export const providerManifestSchema = z.strictObject({
  kind: capabilityKindSchema,
  pluginId: pluginIdSchema,
  pluginVersion: semverSchema,
  apiVersion: z.literal(CAPABILITY_API_VERSION),
})
export type ProviderManifest<K extends CapabilityKind = CapabilityKind> = Readonly<
  Omit<z.infer<typeof providerManifestSchema>, 'kind'> & { kind: K }
>

export const providerInstanceSchema = z.strictObject({
  instanceId: capabilityIdSchema,
  configRevision: capabilityRevisionSchema,
})
export type ProviderInstance = Readonly<z.infer<typeof providerInstanceSchema>>

export const providerPinSchema = providerInstanceSchema.extend(providerManifestSchema.omit({ apiVersion: true }).shape)
export type ProviderPin<K extends CapabilityKind = CapabilityKind> = Readonly<
  Omit<z.infer<typeof providerPinSchema>, 'kind'> & { kind: K }
>

export function sameProviderPin(a: ProviderPin, b: ProviderPin): boolean {
  return a.kind === b.kind && a.instanceId === b.instanceId && a.pluginId === b.pluginId
    && a.pluginVersion === b.pluginVersion && a.configRevision === b.configRevision
}

const networkOriginSchema = z.string().max(512).refine(value => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}, 'Expected a canonical HTTP or HTTPS origin')

export const capabilityDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local') }),
  z.strictObject({ kind: z.literal('network'), origin: networkOriginSchema }),
])
export type CapabilityDestination = z.infer<typeof capabilityDestinationSchema>

export const capabilityDisclosureSchema = z.strictObject({
  mock: z.boolean(),
  destinations: z.array(capabilityDestinationSchema).min(1).max(16).refine(destinations =>
    new Set(destinations.map(destination => destination.kind === 'local' ? 'local' : destination.origin)).size === destinations.length),
})

export const providerFailureCodeSchema = z.enum([
  'invalid_input', 'invalid_config', 'incompatible_version', 'duplicate_instance', 'unsupported_capability',
  'provider_unavailable', 'invalid_result', 'cancelled', 'permission_denied', 'not_found', 'busy', 'rate_limited',
  'conflict', 'uncertain', 'internal',
])
export type ProviderFailureCode = z.infer<typeof providerFailureCodeSchema>
export const providerFailureSchema = z.strictObject({ ok: z.literal(false), code: providerFailureCodeSchema })
export type ProviderFailure = z.infer<typeof providerFailureSchema>
export type ProviderResult<T> = { readonly ok: true; readonly value: T } | ProviderFailure

export function providerResultSchema<S extends z.ZodType>(value: S) {
  return z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value }), providerFailureSchema])
}

export const providerHealthSchema = z.strictObject({
  status: z.enum(['ready', 'degraded', 'unavailable']),
  reason: z.enum(['offline', 'configuration', 'capacity', 'dependency', 'unknown']).optional(),
})
export type ProviderHealth = z.infer<typeof providerHealthSchema>
export type MaybePromise<T> = T | Promise<T>

export interface ProviderLifecycle {
  health(signal: AbortSignal): MaybePromise<ProviderHealth>
  /** Release or quiesce provider-owned activity before stop. */
  drain(): MaybePromise<void>
  stop(): MaybePromise<void>
}

/** Configuration can point to a credential using opaque metadata. */
export const credentialRefSchema = z.strictObject({ id: capabilityIdSchema, backend: pluginIdSchema })
export type CredentialRef = z.infer<typeof credentialRefSchema>
