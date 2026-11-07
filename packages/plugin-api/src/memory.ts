import { z } from 'zod'
import {
  capabilityDisclosureSchema, capabilityIdSchema, capabilityInstantSchema, capabilityRevisionSchema,
  type MaybePromise, type ProviderLifecycle, type ProviderResult,
} from './common.js'

const SNAPSHOT_VERSION = 1
const MAX_SNAPSHOT_RECORDS = 512
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
const MAX_SEARCH_RESULTS = 64
const revisableMemoryRevisionSchema = capabilityRevisionSchema.max(Number.MAX_SAFE_INTEGER - 1)

export const memoryScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('profile') }),
  z.strictObject({ kind: z.literal('project'), projectId: capabilityIdSchema }),
  z.strictObject({ kind: z.literal('task'), taskId: capabilityIdSchema }),
])
export type MemoryScope = z.infer<typeof memoryScopeSchema>

export const memoryAccessSchema = z.strictObject({
  ownerId: capabilityIdSchema,
  profileId: capabilityIdSchema,
  scope: memoryScopeSchema,
})
export type MemoryAccess = z.infer<typeof memoryAccessSchema>

export function sameMemoryAccess(a: MemoryAccess, b: MemoryAccess): boolean {
  if (a.ownerId !== b.ownerId || a.profileId !== b.profileId) return false
  if (a.scope.kind === 'project') return b.scope.kind === 'project' && a.scope.projectId === b.scope.projectId
  if (a.scope.kind === 'task') return b.scope.kind === 'task' && a.scope.taskId === b.scope.taskId
  return b.scope.kind === 'profile'
}

const sourceEventIdsSchema = z.array(capabilityIdSchema).min(1).max(64).refine(ids => new Set(ids).size === ids.length)
const memoryValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fact'), text: z.string().min(1).max(16_384).refine(text => text.trim().length > 0) }),
  z.strictObject({ kind: z.literal('reference'), ref: capabilityIdSchema }),
])
const memoryRecordBaseSchema = memoryAccessSchema.extend({
  id: capabilityIdSchema,
  revision: capabilityRevisionSchema,
  sourceEventIds: sourceEventIdsSchema,
  validFrom: capabilityInstantSchema,
  validUntil: capabilityInstantSchema.optional(),
  origin: z.enum(['explicit', 'inferred']),
  confidence: z.number().min(0).max(1),
}).refine(record => record.validUntil === undefined || record.validUntil >= record.validFrom,
  { path: ['validUntil'], error: 'Memory validity ends before it starts' })

export const memoryActiveRecordSchema = memoryRecordBaseSchema.safeExtend({
  state: z.literal('active'),
  value: memoryValueSchema,
})
export const memorySupersededRecordSchema = memoryRecordBaseSchema.safeExtend({
  state: z.literal('superseded'),
  value: memoryValueSchema,
  supersededBy: capabilityIdSchema,
}).refine(record => record.supersededBy !== record.id, { path: ['supersededBy'], error: 'A record cannot supersede itself' })
export const memoryTombstoneSchema = memoryRecordBaseSchema.safeExtend({
  state: z.literal('forgotten'),
  forgottenAt: capabilityInstantSchema,
})
export const memoryRecordSchema = z.discriminatedUnion('state', [
  memoryActiveRecordSchema, memorySupersededRecordSchema, memoryTombstoneSchema,
])
export type MemoryRecord = z.infer<typeof memoryRecordSchema>
export type MemoryActiveRecord = z.infer<typeof memoryActiveRecordSchema>
export type MemorySupersededRecord = z.infer<typeof memorySupersededRecordSchema>
export type MemoryTombstone = z.infer<typeof memoryTombstoneSchema>

export const memoryHitSchema = z.strictObject({
  recordId: capabilityIdSchema,
  revision: capabilityRevisionSchema,
  score: z.number().min(0).max(1),
  sourceEventIds: sourceEventIdsSchema,
})
export type MemoryHit = z.infer<typeof memoryHitSchema>
export const memorySearchResultsSchema = z.array(memoryHitSchema).max(MAX_SEARCH_RESULTS)
  .refine(hits => new Set(hits.map(hit => hit.recordId)).size === hits.length)

export const memorySnapshotSchema = z.strictObject({
  version: z.literal(SNAPSHOT_VERSION),
  access: memoryAccessSchema,
  records: z.array(memoryRecordSchema).max(MAX_SNAPSHOT_RECORDS),
}).refine(snapshot => snapshot.records.every(record => sameMemoryAccess(snapshot.access, record)),
  { path: ['records'], error: 'Snapshot records must have exactly the snapshot scope' })
  .refine(snapshot => new Set(snapshot.records.map(record => record.id)).size === snapshot.records.length,
    { path: ['records'], error: 'Snapshot record IDs must be unique' })
  .refine(snapshot => Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_SNAPSHOT_BYTES,
    { path: ['records'], error: 'Snapshot exceeds the byte limit' })
export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>

const accessRequestSchema = z.strictObject({ access: memoryAccessSchema })
export const memoryReadRequestSchema = accessRequestSchema.extend({ recordId: capabilityIdSchema })
export const memorySearchRequestSchema = accessRequestSchema.extend({
  query: z.string().min(1).max(4_096).refine(query => query.trim().length > 0),
  limit: z.int().min(1).max(MAX_SEARCH_RESULTS),
})
export const memoryUpsertRequestSchema = accessRequestSchema.extend({
  record: memoryActiveRecordSchema,
  expectedRevision: revisableMemoryRevisionSchema.nullable(),
}).refine(request => sameMemoryAccess(request.access, request.record)
  && request.record.revision === (request.expectedRevision ?? 0) + 1,
  { path: ['record'], error: 'Expected a matching scope and successor revision' })
export const memorySupersedeRequestSchema = memoryReadRequestSchema.extend({
  expectedRevision: revisableMemoryRevisionSchema,
  replacement: memoryActiveRecordSchema,
}).refine(request => sameMemoryAccess(request.access, request.replacement)
  && request.replacement.id !== request.recordId && request.replacement.revision === 1,
  { path: ['replacement'], error: 'Expected a new replacement record in the same scope' })
export const memoryForgetRequestSchema = memoryReadRequestSchema.extend({
  expectedRevision: revisableMemoryRevisionSchema,
  forgottenAt: capabilityInstantSchema,
})
export const memoryExportRequestSchema = accessRequestSchema
export const memoryImportRequestSchema = accessRequestSchema.extend({ snapshot: memorySnapshotSchema })
  .refine(request => sameMemoryAccess(request.access, request.snapshot.access),
    { path: ['snapshot'], error: 'Import requires the exact snapshot scope' })
export const memoryImportResultSchema = z.strictObject({ count: z.int().nonnegative().max(MAX_SNAPSHOT_RECORDS) })

export type MemoryReadRequest = z.infer<typeof memoryReadRequestSchema>
export type MemorySearchRequest = z.infer<typeof memorySearchRequestSchema>
export type MemoryUpsertRequest = z.infer<typeof memoryUpsertRequestSchema>
export type MemorySupersedeRequest = z.infer<typeof memorySupersedeRequestSchema>
export type MemoryForgetRequest = z.infer<typeof memoryForgetRequestSchema>
export type MemoryExportRequest = z.infer<typeof memoryExportRequestSchema>
export type MemoryImportRequest = z.infer<typeof memoryImportRequestSchema>
export type MemoryImportResult = z.infer<typeof memoryImportResultSchema>

export const memoryRetrievalCapabilitiesSchema = capabilityDisclosureSchema
export const memoryCapabilitiesSchema = capabilityDisclosureSchema.extend({ snapshotVersion: z.literal(SNAPSHOT_VERSION) })
export type MemoryRetrievalCapabilities = z.infer<typeof memoryRetrievalCapabilitiesSchema>
export type MemoryCapabilities = z.infer<typeof memoryCapabilitiesSchema>

/** A retrieval-only provider supplies candidates; the core resolves records and rechecks exclusions. */
export interface MemoryRetrievalProvider extends ProviderLifecycle {
  readonly capabilities: MemoryRetrievalCapabilities
  search(request: MemorySearchRequest, signal: AbortSignal): MaybePromise<ProviderResult<MemoryHit[]>>
}

export interface MemoryProvider extends MemoryRetrievalProvider {
  readonly capabilities: MemoryCapabilities
  read(request: MemoryReadRequest, signal: AbortSignal): MaybePromise<ProviderResult<MemoryRecord | null>>
  upsert(request: MemoryUpsertRequest, signal: AbortSignal): MaybePromise<ProviderResult<MemoryActiveRecord>>
  supersede(request: MemorySupersedeRequest, signal: AbortSignal): MaybePromise<ProviderResult<MemorySupersededRecord>>
  forget(request: MemoryForgetRequest, signal: AbortSignal): MaybePromise<ProviderResult<MemoryTombstone>>
  exportSnapshot(request: MemoryExportRequest, signal: AbortSignal): MaybePromise<ProviderResult<MemorySnapshot>>
  importSnapshot(request: MemoryImportRequest, signal: AbortSignal): MaybePromise<ProviderResult<MemoryImportResult>>
}
