import type { Context } from '@deepseek-ai/cordis'
import {
  CAPABILITY_API_VERSION, memorySnapshotSchema, sameMemoryAccess,
  type MemoryAccess, type MemoryProvider, type MemoryRecord, type PluginRegistrar,
  type ProviderDefinition, type ProviderFailureCode, type ProviderResult,
} from '@mosbot-ai/dshpa-plugin-api'
import { z } from 'zod'

const configSchema = z.strictObject({ maxRecords: z.int().min(2).max(512).default(128) })
const mountSchema = configSchema.extend({
  instanceId: z.string().min(1).max(120).default('example-memory'),
  configRevision: z.int().positive().default(1),
})

const ok = <T>(value: T): ProviderResult<T> => ({ ok: true, value })
const fail = (code: ProviderFailureCode): ProviderResult<never> => ({ ok: false, code })

function scopeKey({ ownerId, profileId, scope }: MemoryAccess): string {
  return JSON.stringify([ownerId, profileId, scope.kind,
    scope.kind === 'project' ? scope.projectId : scope.kind === 'task' ? scope.taskId : null])
}

function recordKey(access: MemoryAccess, id: string): string {
  return JSON.stringify([scopeKey(access), id])
}

function makeProvider(maxRecords: number): MemoryProvider {
  let open = true
  const records = new Map<string, MemoryRecord>()
  const get = (access: MemoryAccess, id: string) => records.get(recordKey(access, id))
  const inScope = (access: MemoryAccess) => [...records.values()].filter(record => sameMemoryAccess(record, access))
  const save = <T extends MemoryRecord>(record: T) => {
    records.set(recordKey(record, record.id), structuredClone(record))
    return ok(structuredClone(record))
  }
  const unavailable = (signal: AbortSignal) => signal.aborted ? fail('cancelled') : !open ? fail('provider_unavailable') : undefined

  return {
    capabilities: { mock: false, destinations: [{ kind: 'local' }], snapshotVersion: 1 },
    health: () => ({ status: open ? 'ready' : 'unavailable' }),
    drain() { open = false },
    stop() { open = false; records.clear() },
    read({ access, recordId }, signal) {
      return unavailable(signal) ?? ok(structuredClone(get(access, recordId) ?? null))
    },
    search({ access, query, limit }, signal) {
      const unavailableResult = unavailable(signal)
      if (unavailableResult) return unavailableResult
      const term = query.toLowerCase()
      return ok(inScope(access).flatMap(record => {
        if (record.state !== 'active') return []
        const value = record.value.kind === 'fact' ? record.value.text : record.value.ref
        return value.toLowerCase().includes(term) ? [{ recordId: record.id, revision: record.revision,
          score: 1, sourceEventIds: [...record.sourceEventIds] }] : []
      }).sort((left, right) => left.recordId.localeCompare(right.recordId)).slice(0, limit))
    },
    upsert({ access, record, expectedRevision }, signal) {
      const unavailableResult = unavailable(signal)
      if (unavailableResult) return unavailableResult
      if (!sameMemoryAccess(access, record)) return fail('permission_denied')
      const previous = get(access, record.id)
      if (previous) {
        if (previous.state !== 'active' || expectedRevision !== previous.revision || record.revision !== previous.revision + 1) return fail('conflict')
      } else {
        if (expectedRevision !== null || record.revision !== 1) return fail('conflict')
        if (records.size >= maxRecords) return fail('busy')
      }
      return save(record)
    },
    supersede({ access, recordId, expectedRevision, replacement }, signal) {
      const unavailableResult = unavailable(signal)
      if (unavailableResult) return unavailableResult
      if (!sameMemoryAccess(access, replacement)) return fail('permission_denied')
      const previous = get(access, recordId)
      if (!previous) return fail('not_found')
      if (previous.state !== 'active' || previous.revision !== expectedRevision || replacement.id === recordId
        || get(access, replacement.id) || replacement.revision !== 1 || !Number.isSafeInteger(previous.revision + 1) || replacement.validFrom <= previous.validFrom
        || (previous.validUntil !== undefined && replacement.validFrom > previous.validUntil)) return fail('conflict')
      if (records.size >= maxRecords) return fail('busy')
      save(replacement)
      return save({ ...previous, state: 'superseded', revision: previous.revision + 1,
        validUntil: replacement.validFrom, supersededBy: replacement.id })
    },
    forget({ access, recordId, expectedRevision, forgottenAt }, signal) {
      const unavailableResult = unavailable(signal)
      if (unavailableResult) return unavailableResult
      const previous = get(access, recordId)
      if (!previous) return fail('not_found')
      if (previous.revision !== expectedRevision) return fail('conflict')
      if (previous.state === 'forgotten') return ok(structuredClone(previous))
      if (forgottenAt < previous.validFrom || !Number.isSafeInteger(previous.revision + 1)) return fail('invalid_input')
      const { id, ownerId, profileId, scope, sourceEventIds, validFrom, validUntil, origin, confidence } = previous
      return save({ id, ownerId, profileId, scope, sourceEventIds, validFrom, ...(validUntil === undefined ? {} : { validUntil }),
        origin, confidence, state: 'forgotten', revision: previous.revision + 1, forgottenAt })
    },
    exportSnapshot({ access }, signal) {
      const unavailableResult = unavailable(signal)
      if (unavailableResult) return unavailableResult
      const parsed = memorySnapshotSchema.safeParse({ version: 1, access, records: inScope(access) })
      return parsed.success ? ok(parsed.data) : fail('busy')
    },
    importSnapshot({ access, snapshot }, signal) {
      const unavailableResult = unavailable(signal)
      if (unavailableResult) return unavailableResult
      const parsed = memorySnapshotSchema.safeParse(snapshot)
      if (!parsed.success) return fail('invalid_input')
      if (!sameMemoryAccess(access, parsed.data.access)) return fail('permission_denied')
      if (inScope(access).length !== 0) return fail('conflict')
      if (records.size + parsed.data.records.length > maxRecords) return fail('busy')
      for (const record of parsed.data.records) save(record)
      return ok({ count: parsed.data.records.length })
    },
  }
}

export const definition: ProviderDefinition<'memory', z.output<typeof configSchema>> = {
  manifest: { kind: 'memory', pluginId: 'example-memory-local', pluginVersion: '0.0.0', apiVersion: CAPABILITY_API_VERSION },
  configSchema,
  start(config) { return ok(makeProvider(config.maxRecords)) },
}

export const inject = ['dshpaPlugins']

export function apply(ctx: Context & { readonly dshpaPlugins: PluginRegistrar }, raw: unknown): void {
  const { instanceId, configRevision, ...config } = mountSchema.parse(raw ?? {})
  ctx.effect(() => {
    const registration = ctx.dshpaPlugins.register(definition, { instanceId, configRevision }, config)
    return () => registration.dispose()
  }, 'dshpa: example local memory provider')
}
