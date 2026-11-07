import { Service, type Context } from '@deepseek-ai/cordis'
import {
  CAPABILITY_API_VERSION, capabilityKindSchema, mediaCapabilitiesSchema, memoryCapabilitiesSchema,
  memoryRetrievalCapabilitiesSchema, providerHealthSchema, providerInstanceSchema, providerManifestSchema,
  providerPinSchema, providerResultSchema, sameProviderPin, workflowCapabilitiesSchema,
  type CapabilityKind, type MaybePromise, type PluginRegistrar, type ProviderByKind, type ProviderDefinition,
  type ProviderFailureCode, type ProviderHealth, type ProviderInstance, type ProviderPin, type ProviderRegistration,
  type ProviderResult,
} from '@mosbot-ai/dshpa-plugin-api'
import { z } from 'zod'

type Provider = ProviderByKind[CapabilityKind]
type Capabilities<K extends CapabilityKind> = ProviderByKind[K]['capabilities']

export interface CapabilityMetadata<K extends CapabilityKind = CapabilityKind> {
  readonly pin: ProviderPin<K>
  readonly capabilities: Capabilities<K>
}

interface Entry {
  readonly pin: ProviderPin
  readonly controller: AbortController
  readonly resolveReady: (result: ProviderResult<ProviderPin>) => void
  readonly active: Set<Promise<void>>
  state: 'starting' | 'ready' | 'closing'
  started: Promise<void>
  disposing?: Promise<void>
  provider?: Provider
  capabilities?: Capabilities<CapabilityKind>
  drain?: () => unknown
  stop?: () => unknown
}

const MAX_LIVE = 256
const MAX_PINNED = 4_096
const capabilities = {
  memory: memoryCapabilitiesSchema,
  'memory-retrieval': memoryRetrievalCapabilitiesSchema,
  media: mediaCapabilitiesSchema,
  'creation-workflow': workflowCapabilitiesSchema,
} as const
const operations = {
  memory: ['read', 'search', 'upsert', 'supersede', 'forget', 'exportSnapshot', 'importSnapshot'],
  'memory-retrieval': ['search'],
  media: ['submit', 'inspect', 'cancel', 'collect'],
  'creation-workflow': ['run'],
} as const
const resultSchema = providerResultSchema(z.unknown())
const validationSchema = providerResultSchema(z.undefined())
const fail = (code: ProviderFailureCode) => ({ ok: false, code } as const)
const ok = <T>(value: T) => ({ ok: true, value } as const)

function pinKey(pin: ProviderPin): string {
  return JSON.stringify([pin.kind, pin.instanceId, pin.configRevision])
}

function refused<K extends CapabilityKind>(code: ProviderFailureCode): ProviderRegistration<K> {
  return Object.freeze({ ready: Promise.resolve(fail(code)), dispose: () => Promise.resolve() })
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function method(value: Record<string, unknown>, key: string): (() => unknown) | undefined {
  try {
    const callback = value[key]
    return typeof callback === 'function' ? () => callback.call(value) : undefined
  } catch {
    return undefined
  }
}

function envelope<T>(value: unknown): ProviderResult<T> {
  const parsed = resultSchema.safeParse(value)
  if (!parsed.success || (parsed.data.ok && !Object.hasOwn(parsed.data, 'value'))) return fail('invalid_result')
  return parsed.data as ProviderResult<T>
}

/** Internal authority-neutral registry. Policy consumers own every provider invocation. */
export function createCapabilityRegistry() {
  const entries = new Map<string, Entry>()
  const published = new Set<string>()
  const selections = new Map<CapabilityKind, ProviderPin>()
  let closed = false
  let closing: Promise<void> | undefined

  function disposeEntry(entry: Entry): Promise<void> {
    if (entry.disposing) return entry.disposing
    entry.state = 'closing'
    entry.resolveReady(fail('cancelled'))
    entry.disposing = Promise.resolve().then(async () => {
      await entry.started
      const drain = Promise.resolve().then(() => entry.drain?.())
      const [drained] = await Promise.allSettled([drain, ...entry.active])
      let stopped = true
      try {
        await entry.stop?.()
      } catch {
        stopped = false
      } finally {
        entry.provider = undefined
        entry.capabilities = undefined
        entry.drain = undefined
        entry.stop = undefined
      }
      if (!stopped || drained?.status === 'rejected') throw new Error('Capability provider cleanup failed')
      const key = pinKey(entry.pin)
      if (entries.get(key) === entry) entries.delete(key)
    })
    entry.controller.abort()
    return entry.disposing
  }

  function register<K extends CapabilityKind, C>(
    definition: ProviderDefinition<K, C>, instance: ProviderInstance, rawConfig: unknown,
  ): ProviderRegistration<K> {
    if (closed) return refused('provider_unavailable')
    if (!object(definition) || !object(definition.manifest)) return refused('invalid_input')
    if (typeof definition.manifest.apiVersion === 'number' && definition.manifest.apiVersion !== CAPABILITY_API_VERSION) {
      return refused('incompatible_version')
    }
    if (!capabilityKindSchema.safeParse(definition.manifest.kind).success) return refused('unsupported_capability')
    const manifest = providerManifestSchema.safeParse(definition.manifest)
    const identity = providerInstanceSchema.safeParse(instance)
    if (!manifest.success || !identity.success || typeof definition.start !== 'function') return refused('invalid_input')
    const { kind, pluginId, pluginVersion } = manifest.data
    const pin = Object.freeze({ ...identity.data, kind, pluginId, pluginVersion })
    const key = pinKey(pin)
    if (entries.has(key) || published.has(key)) return refused('duplicate_instance')
    let config: C
    try {
      const decoded = definition.configSchema.safeParse(structuredClone(rawConfig))
      if (!decoded.success) return refused('invalid_config')
      config = decoded.data
      if (definition.validate !== undefined) {
        const validation = definition.validate(config)
        const checked = validationSchema.safeParse(validation)
        if (!checked.success || !checked.data.ok) return refused('invalid_config')
      }
    } catch {
      return refused('invalid_config')
    }
    // Schema refinements and validation are provider code and may reenter.
    if (closed) return refused('provider_unavailable')
    if (entries.has(key) || published.has(key)) return refused('duplicate_instance')
    if (entries.size >= MAX_LIVE || published.size >= MAX_PINNED) return refused('busy')
    const controller = new AbortController()
    const ready = Promise.withResolvers<ProviderResult<ProviderPin>>()
    const entry: Entry = { pin, controller, resolveReady: ready.resolve, active: new Set(),
      state: 'starting', started: Promise.resolve() }
    entries.set(key, entry)
    entry.started = Promise.resolve().then(async () => {
      if (closed || controller.signal.aborted) return
      try {
        const raw: unknown = await definition.start(config, { pin: pin as ProviderPin<K>, signal: controller.signal })
        if (object(raw) && raw.ok === true && object(raw.value)) {
          // A malformed success can still own an instance that needs cleanup.
          entry.drain = method(raw.value, 'drain')
          entry.stop = method(raw.value, 'stop')
        }
        const result = envelope<Provider>(raw)
        if (!result.ok) {
          ready.resolve(result)
          return
        }
        const candidate = result.value
        if (!object(candidate)) {
          ready.resolve(fail('invalid_result'))
          return
        }
        const declared = capabilities[kind].safeParse(candidate.capabilities)
        if (!declared.success || !entry.drain || !entry.stop || typeof candidate.health !== 'function'
          || operations[kind].some(name => typeof candidate[name] !== 'function')) {
          ready.resolve(fail('invalid_result'))
          return
        }
        if (closed || controller.signal.aborted) return
        entry.provider = candidate
        entry.capabilities = declared.data
        entry.state = 'ready'
        published.add(key)
        ready.resolve(ok(pin))
      } catch {
        ready.resolve(fail('provider_unavailable'))
      }
    }).finally(() => {
      if (entry.state !== 'ready') void disposeEntry(entry).catch(() => undefined)
    })
    return Object.freeze({ ready: ready.promise as Promise<ProviderResult<ProviderPin<K>>>, dispose: () => disposeEntry(entry) })
  }

  function available(pin: ProviderPin): ProviderResult<Entry> {
    const parsed = providerPinSchema.safeParse(pin)
    if (!parsed.success) return fail('invalid_input')
    const entry = entries.get(pinKey(parsed.data))
    return !closed && entry?.state === 'ready' && sameProviderPin(entry.pin, parsed.data)
      ? ok(entry) : fail('provider_unavailable')
  }

  function inspect<K extends CapabilityKind>(pin: ProviderPin<K>): ProviderResult<CapabilityMetadata<K>> {
    const found = available(pin)
    if (!found.ok) return found
    return ok({ pin: found.value.pin as ProviderPin<K>, capabilities: structuredClone(found.value.capabilities) as Capabilities<K> })
  }

  function select<K extends CapabilityKind>(pin: ProviderPin<K>): ProviderResult<ProviderPin<K>> {
    const found = available(pin)
    if (!found.ok) return found
    const exact = found.value.pin as ProviderPin<K>
    selections.set(exact.kind, exact)
    return ok(exact)
  }

  function selected<K extends CapabilityKind>(kind: K): ProviderResult<ProviderPin<K>> {
    if (!capabilityKindSchema.safeParse(kind).success) return fail('unsupported_capability')
    const pin = selections.get(kind) as ProviderPin<K> | undefined
    if (!pin) return fail('not_found')
    const found = available(pin)
    return found.ok ? ok(pin) : found
  }

  async function run<K extends CapabilityKind, T>(
    pin: ProviderPin<K>, callback: (provider: ProviderByKind[K], signal: AbortSignal) => MaybePromise<ProviderResult<T>>,
    signal: AbortSignal, thrown: ProviderFailureCode,
  ): Promise<ProviderResult<T>> {
    if (signal.aborted) return fail('cancelled')
    const found = available(pin)
    if (!found.ok) return found
    const entry = found.value
    const settled = Promise.withResolvers<void>()
    entry.active.add(settled.promise)
    try {
      return await callback(entry.provider as ProviderByKind[K], signal)
    } catch {
      return fail(thrown)
    } finally {
      entry.active.delete(settled.promise)
      settled.resolve()
    }
  }

  function invoke<K extends CapabilityKind, T>(
    pin: ProviderPin<K>, callback: (provider: ProviderByKind[K], signal: AbortSignal) => MaybePromise<ProviderResult<T>>,
    signal = new AbortController().signal,
  ): Promise<ProviderResult<T>> {
    return run(pin, async (provider, current) => envelope<T>(await callback(provider, current)), signal, 'uncertain')
  }

  function health(pin: ProviderPin, signal = new AbortController().signal): Promise<ProviderResult<ProviderHealth>> {
    return run(pin, async (provider, current) => {
      const result = providerHealthSchema.safeParse(await provider.health(current))
      return result.success ? ok(result.data) : fail('invalid_result')
    }, signal, 'provider_unavailable')
  }

  function close(): Promise<void> {
    if (closing) return closing
    closed = true
    const owned = [...entries.values()]
    closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(owned.map(disposeEntry))
      if (results.some(result => result.status === 'rejected')) throw new Error('Capability provider cleanup failed')
    })
    return closing
  }

  const registrar: PluginRegistrar = Object.freeze({ register })
  return Object.freeze({ registrar, inspect, select, selected, invoke, health, close })
}

export type CapabilityRegistry = ReturnType<typeof createCapabilityRegistry>

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshpaPlugins: PluginRegistrar
  }
}

const registries = new WeakMap<Context, CapabilityRegistry>()

export function capabilityRegistryFor(ctx: Context): CapabilityRegistry | undefined {
  return registries.get(ctx.root)
}

export function installCapabilityPlugins(ctx: Context): void {
  const root = ctx.root
  if (registries.has(root)) throw new Error('The capability registry is already installed')
  const registry = createCapabilityRegistry()
  class RegistrarService extends Service implements PluginRegistrar {
    constructor(context: Context) { super(context, 'dshpaPlugins') }

    register<K extends CapabilityKind, C>(definition: ProviderDefinition<K, C>, instance: ProviderInstance, config: unknown) {
      let registration!: ProviderRegistration<K>
      const release = this.ctx.effect(() => {
        registration = registry.registrar.register(definition, instance, config)
        return registration.dispose
      }, 'dshpa: provider registration')
      return Object.freeze({ ready: registration.ready, dispose() {
        const drained = registration.dispose()
        return Promise.resolve(release()).then(() => drained)
      } })
    }
  }
  ctx.effect(() => {
    registries.set(root, registry)
    return async () => {
      await registry.close()
      registries.delete(root)
    }
  }, 'dshpa: capability registry')
  new RegistrarService(ctx)
}
