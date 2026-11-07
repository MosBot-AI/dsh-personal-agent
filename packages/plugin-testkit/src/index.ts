import assert from 'node:assert/strict'
import {
  mediaCapabilitiesSchema, mediaHandleSchema, memorySnapshotSchema,
  type MediaProvider, type MemoryAccess, type MemoryActiveRecord, type MemoryProvider,
  type MemorySnapshot, type ProviderPin, type ProviderResult,
} from '@mosbot-ai/dshpa-plugin-api'

export interface MemoryRoundTripFixture {
  readonly access: MemoryAccess
  readonly active: MemoryActiveRecord
  readonly forget: MemoryActiveRecord
  readonly forgottenAt: string
  readonly activeQuery: string
  readonly forgottenQuery: string
}

function value<T>(result: ProviderResult<T>, operation: string): T {
  if (!result.ok) assert.fail(`${operation} failed with ${result.code}`)
  return result.value
}

function normalized(snapshot: MemorySnapshot) {
  return { ...snapshot, records: [...snapshot.records].sort((left, right) => left.id.localeCompare(right.id)) }
}

/** Run against two isolated, empty scopes. The fixture writes and forgets synthetic records. */
export async function assertMemorySnapshotRoundTrip(
  source: MemoryProvider,
  target: MemoryProvider,
  fixture: MemoryRoundTripFixture,
  signal: AbortSignal = new AbortController().signal,
): Promise<MemorySnapshot> {
  const { access, active, forget, forgottenAt, activeQuery, forgottenQuery } = fixture
  assert.notEqual(active.id, forget.id)
  for (const record of [active, forget]) {
    assert.deepEqual(value(await source.upsert({ access, record, expectedRevision: null }, signal), 'memory upsert'), record)
    assert.deepEqual(value(await source.read({ access, recordId: record.id }, signal), 'memory read'), record)
  }
  const hits = value(await source.search({ access, query: activeQuery, limit: 10 }, signal), 'memory search')
  const hit = hits.find(item => item.recordId === active.id)
  assert.equal(hit?.revision, active.revision)
  assert.deepEqual(hit?.sourceEventIds, active.sourceEventIds)
  const tombstone = value(await source.forget({ access, recordId: forget.id, expectedRevision: forget.revision, forgottenAt }, signal), 'memory forget')
  assert.equal(tombstone.state, 'forgotten')
  assert.equal(tombstone.id, forget.id)
  assert.equal(tombstone.revision, forget.revision + 1)
  assert.equal(tombstone.forgottenAt, forgottenAt)
  assert.deepEqual(tombstone.sourceEventIds, forget.sourceEventIds)
  assert.equal('value' in tombstone, false)

  const snapshot = memorySnapshotSchema.parse(value(await source.exportSnapshot({ access }, signal), 'memory export'))
  assert.deepEqual(snapshot.access, access)
  assert.equal(snapshot.records.length, 2)
  assert.deepEqual(snapshot.records.find(record => record.id === active.id), active)
  assert.deepEqual(snapshot.records.find(record => record.id === forget.id), tombstone)
  assert.equal(value(await target.importSnapshot({ access, snapshot }, signal), 'memory import').count, snapshot.records.length)
  const imported = memorySnapshotSchema.parse(value(await target.exportSnapshot({ access }, signal), 'imported memory export'))
  assert.deepEqual(normalized(imported), normalized(snapshot))
  assert.deepEqual(value(await target.read({ access, recordId: active.id }, signal), 'imported active record read'), active)
  assert.deepEqual(value(await target.read({ access, recordId: forget.id }, signal), 'imported tombstone read'), tombstone)
  assert.equal(value(await target.search({ access, query: forgottenQuery, limit: 10 }, signal), 'imported memory search')
    .some(item => item.recordId === forget.id), false)
  return imported
}

/** Check the fixture labeling before a consumer uses any mock output. */
export function assertMockMedia(provider: Pick<MediaProvider, 'capabilities'>): void {
  const capabilities = mediaCapabilitiesSchema.parse(provider.capabilities)
  assert.equal(capabilities.mock, true)
  assert.ok(capabilities.destinations.every(destination => destination.kind === 'local'))
}

export function assertPinnedMediaHandle(raw: unknown, expected: ProviderPin<'media'>) {
  const handle = mediaHandleSchema.parse(raw)
  assert.deepEqual(handle.provider, expected)
  return handle
}
