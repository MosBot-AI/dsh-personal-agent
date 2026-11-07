import { isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import {
  CAPABILITY_API_VERSION, capabilityIdSchema, capabilityInstantSchema, memoryExportRequestSchema, memoryForgetRequestSchema,
  memoryImportRequestSchema, memoryReadRequestSchema, memoryRecordSchema, memorySearchRequestSchema, memorySnapshotSchema,
  memorySupersedeRequestSchema, memorySupersededRecordSchema, memoryTombstoneSchema, memoryUpsertRequestSchema, sameMemoryAccess,
  type MemoryAccess, type MemoryProvider, type MemoryRecord, type PluginRegistrar, type ProviderDefinition,
  type ProviderFailureCode, type ProviderResult,
} from '@mosbot-ai/dshpa-plugin-api'
import { z } from 'zod'
import { memoryFailure, MemoryStorageError, openMemoryDatabase, writeTransaction } from './database.js'

export const memorySqliteConfigSchema = z.strictObject({
  directory: z.string().refine(path => isAbsolute(path) && !path.includes('\0')),
})
const mountSchema = memorySqliteConfigSchema.extend({
  instanceId: capabilityIdSchema.default('local-memory'),
  configRevision: z.int().positive().default(1),
})
const MAX_RECORDS = 512

const ok = <T>(value: T): ProviderResult<T> => ({ ok: true, value })
const fail = (code: ProviderFailureCode): ProviderResult<never> => ({ ok: false, code })

function scopeKey({ ownerId, profileId, scope }: MemoryAccess): string {
  const scopeRef = scope.kind === 'project' ? scope.projectId : scope.kind === 'task' ? scope.taskId : null
  return JSON.stringify([ownerId, profileId, scope.kind, scopeRef])
}

function decode(access: MemoryAccess, id: unknown, raw: unknown): MemoryRecord {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 131_072) throw new MemoryStorageError('provider_unavailable')
  const result = memoryRecordSchema.safeParse(JSON.parse(raw))
  if (!result.success || !sameMemoryAccess(access, result.data) || result.data.id !== id) {
    throw new MemoryStorageError('provider_unavailable')
  }
  return result.data
}

function read(db: DatabaseSync, access: MemoryAccess, id: string): MemoryRecord | undefined {
  const row = db.prepare('SELECT record FROM memory_records WHERE scope_key = ? AND id = ?').get(scopeKey(access), id)
  return row && decode(access, id, row.record)
}

function list(db: DatabaseSync, access: MemoryAccess): MemoryRecord[] {
  const rows = db.prepare('SELECT id, record FROM memory_records WHERE scope_key = ? ORDER BY id LIMIT ?')
    .all(scopeKey(access), MAX_RECORDS + 1)
  if (rows.length > MAX_RECORDS) throw new MemoryStorageError('busy')
  return rows.map(row => decode(access, row.id, row.record))
}

function snapshot(db: DatabaseSync, access: MemoryAccess) {
  const parsed = memorySnapshotSchema.safeParse({ version: 1, access, records: list(db, access) })
  if (!parsed.success) throw new MemoryStorageError('busy')
  return parsed.data
}

function insert(db: DatabaseSync, record: MemoryRecord): void {
  db.prepare('INSERT INTO memory_records (scope_key, id, record) VALUES (?, ?, ?)')
    .run(scopeKey(record), record.id, JSON.stringify(record))
}

function update(db: DatabaseSync, record: MemoryRecord, priorRevision: number): void {
  const changed = db.prepare(`
    UPDATE memory_records SET record = ? WHERE scope_key = ? AND id = ? AND (record ->> '$.revision') = ?
  `).run(JSON.stringify(record), scopeKey(record), record.id, priorRevision)
  if (changed.changes !== 1) throw new MemoryStorageError('conflict')
}

function sameRecord(left: MemoryRecord, right: MemoryRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/** Open the independent canonical memory store using only the public provider contract. */
export function openMemoryProvider(directory: string, now = () => new Date().toISOString()): ProviderResult<MemoryProvider> {
  if (!memorySqliteConfigSchema.safeParse({ directory }).success) return fail('invalid_config')
  let db: DatabaseSync
  try { db = openMemoryDatabase(directory) } catch (error) { return fail(memoryFailure(error)) }
  let accepting = true

  function stop(): void {
    accepting = false
    if (db.isOpen) db.close()
  }

  function run<S extends z.ZodType, T>(schema: S, raw: unknown, signal: AbortSignal,
    operation: (request: z.output<S>) => ProviderResult<T>): ProviderResult<T> {
    if (signal.aborted) return fail('cancelled')
    if (!accepting || !db.isOpen) return fail('provider_unavailable')
    try {
      const parsed = schema.safeParse(raw)
      return parsed.success ? operation(parsed.data) : fail('invalid_input')
    } catch (error) {
      const code = memoryFailure(error)
      if (code === 'provider_unavailable' || db.isTransaction) {
        try { stop() } catch { /* Keep the unavailable state. */ }
      }
      return fail(code)
    }
  }

  const provider: MemoryProvider = {
    capabilities: { mock: false, destinations: [{ kind: 'local' }], snapshotVersion: 1 },
    health(signal) { return { status: accepting && db.isOpen && !signal.aborted ? 'ready' : 'unavailable' } },
    drain() { accepting = false },
    stop,
    read(input, signal) {
      return run(memoryReadRequestSchema, input, signal, ({ access, recordId }) => ok(read(db, access, recordId) ?? null))
    },
    search(input, signal) {
      return run(memorySearchRequestSchema, input, signal, ({ access, query, limit }) => {
        const term = normalized(query)
        const parts = [...new Set(term.split(' '))]
        if (!term || parts.length > 64) return fail('invalid_input')
        const at = capabilityInstantSchema.parse(now())
        const hits = list(db, access).flatMap(record => {
          if (record.state !== 'active' || record.validFrom > at || (record.validUntil !== undefined && record.validUntil <= at)) return []
          const text = normalized(record.value.kind === 'fact' ? record.value.text : record.value.ref)
          if (!parts.every(part => text.includes(part))) return []
          return [{ recordId: record.id, revision: record.revision, score: text.includes(term) ? 1 : 0.75,
            sourceEventIds: record.sourceEventIds }]
        })
        return ok(hits.sort((left, right) => right.score - left.score).slice(0, limit))
      })
    },
    upsert(input, signal) {
      return run(memoryUpsertRequestSchema, input, signal, ({ access, record, expectedRevision }) => writeTransaction(db, () => {
        if (record.validUntil === undefined) delete record.validUntil
        const prior = read(db, access, record.id)
        if (prior?.state === 'active' && sameRecord(prior, record)) return ok(prior)
        if (!prior && expectedRevision === null) insert(db, record)
        else if (prior?.state === 'active' && prior.revision === expectedRevision) update(db, record, prior.revision)
        else return fail('conflict')
        snapshot(db, access)
        return ok(record)
      }))
    },
    supersede(input, signal) {
      return run(memorySupersedeRequestSchema, input, signal, request => writeTransaction(db, () => {
        const { access, recordId, expectedRevision, replacement } = request
        const prior = read(db, access, recordId)
        if (!prior) return fail('not_found')
        const existing = read(db, access, replacement.id)
        if (prior.state === 'superseded' && prior.revision === expectedRevision + 1 && prior.supersededBy === replacement.id
          && existing?.state === 'active' && sameRecord(existing, replacement)) return ok(prior)
        if (prior.state !== 'active' || prior.revision !== expectedRevision || existing || replacement.validFrom <= prior.validFrom) {
          return fail('conflict')
        }
        const validUntil = prior.validUntil && prior.validUntil < replacement.validFrom ? prior.validUntil : replacement.validFrom
        const old = memorySupersededRecordSchema.parse({ ...prior, state: 'superseded', revision: prior.revision + 1,
          supersededBy: replacement.id, validUntil })
        insert(db, replacement)
        update(db, old, prior.revision)
        snapshot(db, access)
        return ok(old)
      }))
    },
    forget(input, signal) {
      return run(memoryForgetRequestSchema, input, signal, request => writeTransaction(db, () => {
        const { access, recordId, expectedRevision, forgottenAt } = request
        const prior = read(db, access, recordId)
        if (!prior) return fail('not_found')
        if (prior.state === 'forgotten') {
          return prior.revision === expectedRevision + 1 && prior.forgottenAt === forgottenAt ? ok(prior) : fail('conflict')
        }
        if (prior.revision !== expectedRevision) return fail('conflict')
        const { id, ownerId, profileId, scope, sourceEventIds, validFrom, validUntil, origin, confidence } = prior
        const tombstone = memoryTombstoneSchema.parse({ id, ownerId, profileId, scope, sourceEventIds, validFrom,
          ...(validUntil === undefined ? {} : { validUntil }),
          origin, confidence, state: 'forgotten', revision: prior.revision + 1, forgottenAt })
        update(db, tombstone, prior.revision)
        snapshot(db, access)
        return ok(tombstone)
      }))
    },
    exportSnapshot(input, signal) {
      return run(memoryExportRequestSchema, input, signal, ({ access }) => ok(snapshot(db, access)))
    },
    importSnapshot(input, signal) {
      return run(memoryImportRequestSchema, input, signal, ({ access, snapshot: source }) => writeTransaction(db, () => {
        if (db.prepare('SELECT 1 FROM memory_records WHERE scope_key = ? LIMIT 1').get(scopeKey(access))) return fail('conflict')
        for (const record of source.records) insert(db, record)
        return ok({ count: source.records.length })
      }))
    },
  }
  return ok(Object.freeze(provider))
}

export const definition: ProviderDefinition<'memory', z.output<typeof memorySqliteConfigSchema>> = {
  manifest: { kind: 'memory', pluginId: '@mosbot-ai/dshpa-memory-sqlite', pluginVersion: '0.0.0', apiVersion: CAPABILITY_API_VERSION },
  configSchema: memorySqliteConfigSchema,
  start(config, { signal }) { return signal.aborted ? fail('cancelled') : openMemoryProvider(config.directory) },
}

export const inject = ['dshpaPlugins']

export function apply(ctx: Context & { readonly dshpaPlugins: PluginRegistrar }, raw: unknown): void {
  const { instanceId, configRevision, ...config } = mountSchema.parse(raw)
  ctx.effect(() => {
    const registration = ctx.dshpaPlugins.register(definition, { instanceId, configRevision }, config)
    return () => registration.dispose()
  }, 'dshpa: SQLite memory provider')
}
