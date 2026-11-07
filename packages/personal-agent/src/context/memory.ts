import {
  capabilityIdSchema, capabilityInstantSchema, capabilityRevisionSchema, memoryActiveRecordSchema,
  memoryForgetRequestSchema, memoryRecordSchema, memoryScopeSchema, memorySearchRequestSchema, memorySearchResultsSchema,
  memorySupersedeRequestSchema, memorySupersededRecordSchema, memoryTombstoneSchema, memoryUpsertRequestSchema,
  providerPinSchema, providerResultSchema, sameMemoryAccess,
  type MemoryAccess, type MemoryActiveRecord, type MemoryCapabilities, type MemoryHit, type MemoryProvider, type MemoryRecord, type MemoryScope,
  type MaybePromise, type ProviderFailureCode, type ProviderResult,
} from '@mosbot-ai/dshpa-plugin-api'
import { z } from 'zod'
import type { InboxResponse } from '../inbox/protocol.js'
import type { IdentityBoundary, OwnerIdentity } from '../policy/identity.js'
import type { CapabilityRegistry } from '../runtime/capability-registry.js'
import { expectedMemoryProofs, memoryRecordProof, memoryValueDigest, sameMemoryLedgerProof,
  type MemoryCommandReceipt } from '../storage/memory.js'
import type { WorkStore } from '../storage/store.js'

const provider = providerPinSchema.extend({ kind: z.literal('memory') })
export const localMemoryConfigSchema = z.strictObject({ provider })
const scoped = { scope: memoryScopeSchema }
const command = { ...scoped, commandId: capabilityIdSchema }
const edit = { ...command, text: z.string().min(1).max(16_384).refine(text => text.trim().length > 0),
  validUntil: capabilityInstantSchema.optional() }
const target = { recordId: capabilityIdSchema, expectedRevision: capabilityRevisionSchema.max(Number.MAX_SAFE_INTEGER - 1) }
export const memoryRequestSchemas = [
  z.strictObject({ type: z.literal('memory_search'), ...scoped, query: z.string().trim().max(4_096), limit: z.int().min(1).max(25).default(10) }),
  z.strictObject({ type: z.literal('memory_inspect'), ...scoped, recordId: capabilityIdSchema }),
  z.strictObject({ type: z.literal('memory_remember'), ...edit }),
  z.strictObject({ type: z.literal('memory_correct'), ...edit, ...target }),
  z.strictObject({ type: z.literal('memory_forget'), ...command, ...target }),
] as const
const requestSchema = z.discriminatedUnion('type', memoryRequestSchemas)
type MemoryRequest = z.infer<typeof requestSchema>
type Mutation = Extract<MemoryRequest, { commandId: string }>

const callTimeoutMs = 5_000
const fail = (code: ProviderFailureCode) => ({ ok: false, code } as const)

function accessFor(owner: OwnerIdentity, scope: MemoryScope): MemoryAccess {
  return { ownerId: owner.ownerId, profileId: owner.profileId, scope }
}

function records(records: readonly MemoryActiveRecord[]): InboxResponse {
  return { ok: true, kind: 'memory_records', confirmed: records.filter(record => record.origin === 'explicit'),
    inferred: records.filter(record => record.origin === 'inferred') }
}

function change(receipt: MemoryCommandReceipt): InboxResponse {
  const record = receipt.proposed ?? receipt.previous
  if (!record) return fail('internal')
  return { ok: true, kind: 'memory_change', state: receipt.status, recordId: record.id,
    revision: receipt.kind === 'forget' ? record.revision + 1 : record.revision }
}

function normalize(text: string): string { return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() }

function localProvider(capabilities: MemoryCapabilities): boolean {
  return !capabilities.mock && capabilities.destinations.every(destination => destination.kind === 'local')
}

/** Owner operations resolve facts through a trusted ledger and an independently mounted local provider. */
export function createLocalMemory(options: {
  store: WorkStore
  registry: CapabilityRegistry
  identity: IdentityBoundary
  config: z.infer<typeof localMemoryConfigSchema>
  now?: () => string
}) {
  const { store, registry, identity } = options
  const pin = options.config.provider
  const now = options.now ?? (() => new Date().toISOString())

  function allowed(token: unknown, access: MemoryAccess): boolean {
    const owner = identity.resolveOwner(token)
    return owner !== undefined && owner.ownerId === access.ownerId && owner.profileId === access.profileId
      && store.canDispatch() && store.hasMemoryScope(access)
  }

  async function call<S extends z.ZodType>(token: unknown, access: MemoryAccess, signal: AbortSignal, schema: S,
    invoke: (provider: MemoryProvider, signal: AbortSignal) => MaybePromise<unknown>): Promise<ProviderResult<z.output<S>>> {
    if (signal.aborted) return fail('cancelled')
    if (!allowed(token, access)) return fail('permission_denied')
    const inspected = registry.inspect(pin)
    if (!inspected.ok) return inspected
    if (!localProvider(inspected.value.capabilities)) return fail('permission_denied')
    const pending = registry.invoke(pin, async (active, callSignal) => {
      if (!allowed(token, access)) return fail('permission_denied')
      const result = await invoke(active, callSignal)
      if (callSignal.aborted) return fail('cancelled')
      if (!allowed(token, access) || !registry.inspect(pin).ok) return fail('permission_denied')
      const parsed = providerResultSchema(schema).safeParse(result)
      return parsed.success ? parsed.data as ProviderResult<z.output<S>> : fail('invalid_result')
    }, signal)
    const aborted = Promise.withResolvers<ReturnType<typeof fail>>()
    const onAbort = () => aborted.resolve(fail('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    try { return await Promise.race([pending, aborted.promise]) }
    finally { signal.removeEventListener('abort', onAbort) }
  }

  async function read(token: unknown, access: MemoryAccess, recordId: string, signal: AbortSignal):
  Promise<ProviderResult<MemoryRecord | null>> {
    const result = await call(token, access, signal, memoryRecordSchema.nullable(),
      (active, current) => active.read({ access: structuredClone(access), recordId }, current))
    if (!result.ok || result.value === null) return result
    return result.value.id === recordId && sameMemoryAccess(access, result.value) ? result : fail('invalid_result')
  }

  function publishable(access: MemoryAccess, record: MemoryActiveRecord): boolean {
    const ledger = store.getMemoryRecord(access, record.id)
    return ledger !== undefined && sameMemoryLedgerProof(ledger, memoryRecordProof(record))
      && record.sourceEventIds.every(id => store.hasMemorySource(access, id))
  }

  async function inspect(token: unknown, access: MemoryAccess, id: string, signal: AbortSignal): Promise<InboxResponse> {
    if (store.getMemoryRecord(access, id)?.state !== 'active') return records([])
    const result = await read(token, access, id, signal)
    if (!result.ok) return result
    if (!allowed(token, access)) return fail('permission_denied')
    return records(result.value?.state === 'active' && publishable(access, result.value) ? [result.value] : [])
  }

  async function search(token: unknown, access: MemoryAccess, request: Extract<MemoryRequest, { type: 'memory_search' }>,
    signal: AbortSignal): Promise<InboxResponse> {
    const { query, limit } = request
    const known = store.listMemoryRecords(access, { limit: 64 }).items
    if (known.length === 0) return records([])
    let ids = known.map(record => record.id)
    let hints: Map<string, MemoryHit> | undefined
    if (query) {
      const input = memorySearchRequestSchema.parse({ access, query, limit: 64 })
      const hits = await call(token, access, signal, memorySearchResultsSchema,
        (active, current) => active.search(structuredClone(input), current))
      if (!hits.ok) return hits
      hints = new Map(hits.value.map(hit => [hit.recordId, hit]))
      ids = [...hints.keys()]
    }
    const result: MemoryActiveRecord[] = []
    const at = now()
    const terms = normalize(query).split(' ')
    for (const id of ids) {
      if (store.getMemoryRecord(access, id)?.state !== 'active') continue
      const found = await read(token, access, id, signal)
      if (!found.ok) return found
      const record = found.value
      if (record?.state !== 'active' || !publishable(access, record)) continue
      const hint = hints?.get(id)
      if (hint && (hint.revision !== record.revision || hint.sourceEventIds.length !== record.sourceEventIds.length
        || !hint.sourceEventIds.every(source => record.sourceEventIds.includes(source)))) continue
      const text = normalize(record.value.kind === 'fact' ? record.value.text : record.value.ref)
      if (query && (record.validFrom > at || (record.validUntil !== undefined && at >= record.validUntil)
        || !terms.every(term => text.includes(term)))) continue
      result.push(record)
      if (result.length >= limit) break
    }
    if (!allowed(token, access)) return fail('permission_denied')
    return records(result.filter(record => publishable(access, record)))
  }

  async function mutate(token: unknown, owner: OwnerIdentity, access: MemoryAccess, request: Mutation,
    signal: AbortSignal): Promise<InboxResponse> {
    if (signal.aborted) return fail('cancelled')
    const kind = request.type === 'memory_remember' ? 'remember' : request.type === 'memory_correct' ? 'correct' : 'forget'
    const inspected = registry.inspect(pin)
    if (kind !== 'forget' && inspected.ok && !localProvider(inspected.value.capabilities)) return fail('permission_denied')
    const value = 'text' in request ? { kind: 'fact' as const, text: request.text } : undefined
    const reserved = store.reserveMemoryCommand(owner, { access, pin, commandId: request.commandId, kind, at: now(),
      ...('recordId' in request ? { recordId: request.recordId, expectedRevision: request.expectedRevision } : {}),
      ...('validUntil' in request && request.validUntil !== undefined ? { validUntil: request.validUntil } : {}),
      ...(value === undefined ? {} : { digest: memoryValueDigest(value) }),
    })
    if (!reserved.ok) return reserved
    const { receipt } = reserved
    if (receipt.status === 'completed') return change(receipt)

    const previous = receipt.previous
    const proposed = receipt.proposed
    const ids = [previous?.id, proposed?.id].filter(id => id !== undefined)
    const expected = expectedMemoryProofs(receipt)
    async function readback() {
      const current = new Map<string, MemoryRecord>()
      for (const id of ids) {
        const result = await read(token, access, id, signal)
        if (!result.ok) return undefined
        if (result.value) current.set(id, result.value)
      }
      return current
    }
    function settle(current: Map<string, MemoryRecord>) {
      const verified = identity.resolveOwner(token)
      if (signal.aborted || current.size !== ids.length || !verified || !allowed(token, access)) return undefined
      const proofs = [...current.values()].map(memoryRecordProof)
      if (!proofs.every((proof, index) => expected[index] && sameMemoryLedgerProof(expected[index], proof))) return undefined
      const finished = store.finishMemoryCommand(verified, { access, commandId: receipt.commandId, pin, proofs })
      return finished.ok ? change(finished.receipt) : undefined
    }

    // A provider rollback can change the preimage even when the ID and revision match.
    const before = await readback()
    if (!before) return change(receipt)
    const recovered = settle(before)
    if (recovered) return recovered
    const prior = previous && before.get(previous.id)
    if ((previous && (!prior || !sameMemoryLedgerProof(previous, memoryRecordProof(prior))))
      || (proposed && before.has(proposed.id))) return change(receipt)

    if (kind === 'forget' && previous) {
      const input = memoryForgetRequestSchema.parse({ access, recordId: previous.id,
        expectedRevision: previous.revision, forgottenAt: receipt.at })
      await call(token, access, signal, memoryTombstoneSchema, (active, current) => active.forget(structuredClone(input), current))
    } else if (value && proposed) {
      const replacement = memoryActiveRecordSchema.parse({ ...access, id: proposed.id, revision: proposed.revision, state: 'active', value,
        origin: proposed.origin, confidence: proposed.confidence, sourceEventIds: proposed.sourceEventIds,
        validFrom: proposed.validFrom, ...(proposed.validUntil === undefined ? {} : { validUntil: proposed.validUntil }) })
      if (previous) {
        const input = memorySupersedeRequestSchema.parse({ access, recordId: previous.id, expectedRevision: previous.revision, replacement })
        await call(token, access, signal, memorySupersededRecordSchema, (active, current) => active.supersede(structuredClone(input), current))
      } else {
        const input = memoryUpsertRequestSchema.parse({ access, record: replacement, expectedRevision: null })
        await call(token, access, signal, memoryActiveRecordSchema, (active, current) => active.upsert(structuredClone(input), current))
      }
    }

    // A lost response still reconciles when the pinned provider proves every reserved record.
    const after = await readback()
    return (after && settle(after)) ?? change(receipt)
  }

  return Object.freeze({
    async handle(token: unknown, raw: unknown, transportSignal?: AbortSignal): Promise<InboxResponse> {
      const owner = identity.resolveOwner(token)
      if (!owner) return fail('permission_denied')
      const parsed = requestSchema.safeParse(raw)
      if (!parsed.success) return fail('invalid_input')
      const request = parsed.data
      if (!store.canDispatch()) return { ok: false, code: 'recovery_required' }
      const access = accessFor(owner, request.scope)
      if (!store.hasMemoryScope(access)) return fail('not_found')
      const timeout = AbortSignal.timeout(callTimeoutMs)
      const signal = transportSignal ? AbortSignal.any([timeout, transportSignal]) : timeout
      switch (request.type) {
        case 'memory_inspect': return inspect(token, access, request.recordId, signal)
        case 'memory_search': return search(token, access, request, signal)
        default: return mutate(token, owner, access, request, signal)
      }
    },
  })
}

export type LocalMemory = ReturnType<typeof createLocalMemory>
