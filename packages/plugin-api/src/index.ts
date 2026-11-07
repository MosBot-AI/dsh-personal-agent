import type { z } from 'zod'
import type { CapabilityKind, MaybePromise, ProviderInstance, ProviderManifest, ProviderPin, ProviderResult } from './common.js'
import type { MediaProvider } from './media.js'
import type { MemoryProvider, MemoryRetrievalProvider } from './memory.js'
import type { CreationWorkflowProvider } from './workflow.js'

export * from './common.js'
export * from './media.js'
export * from './memory.js'
export * from './workflow.js'

export interface ProviderByKind {
  'memory': MemoryProvider
  'memory-retrieval': MemoryRetrievalProvider
  'media': MediaProvider
  'creation-workflow': CreationWorkflowProvider
}

export interface ProviderStartContext<K extends CapabilityKind> {
  readonly pin: ProviderPin<K>
  readonly signal: AbortSignal
}

/** A definition describes an implementation. The host assigns its exact configuration pin. */
export interface ProviderDefinition<K extends CapabilityKind, Config> {
  readonly manifest: ProviderManifest<K>
  readonly configSchema: z.ZodType<Config>
  /** Optional synchronous semantic validation of an already parsed configuration. */
  validate?(config: Config): ProviderResult<void>
  start(config: Config, context: ProviderStartContext<K>): MaybePromise<ProviderResult<ProviderByKind[K]>>
}

export function defineProvider<K extends CapabilityKind, Config>(definition: ProviderDefinition<K, Config>): ProviderDefinition<K, Config> {
  return definition
}

export interface ProviderRegistration<K extends CapabilityKind> {
  readonly ready: Promise<ProviderResult<ProviderPin<K>>>
  dispose(): Promise<void>
}

/** The registrar exposes no provider instances, authority tables or unscoped invocation. */
export interface PluginRegistrar {
  register<K extends CapabilityKind, Config>(
    definition: ProviderDefinition<K, Config>, instance: ProviderInstance, config: unknown,
  ): ProviderRegistration<K>
}
