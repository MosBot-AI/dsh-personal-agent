import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  memoryActiveRecordSchema, type MemoryAccess, type MemoryActiveRecord, type MemoryProvider, type ProviderResult,
} from '@mosbot-ai/dshpa-plugin-api'
import { assertMemorySnapshotRoundTrip } from '@mosbot-ai/dshpa-plugin-testkit'
import { MEMORY_DATABASE_FILENAME } from '../../packages/memory-sqlite/src/database.js'
import { openMemoryProvider } from '../../packages/memory-sqlite/src/index.js'

const at = '2026-11-07T10:00:00.000Z'
const earlier = '2026-11-07T08:00:00.000Z'
const changedAt = '2026-11-07T09:00:00.000Z'
const later = '2026-11-07T11:00:00.000Z'
const access: MemoryAccess = { ownerId: 'owner-fixture', profileId: 'profile-fixture', scope: { kind: 'project', projectId: 'project-fixture' } }
const other: MemoryAccess = { ...access, scope: { kind: 'project', projectId: 'other-project' } }
const signal = new AbortController().signal

function value<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new Error(`Memory provider fixture failed: ${result.code}`)
  return result.value
}

function active(id: string, text: string, scope = access, overrides: Partial<MemoryActiveRecord> = {}) {
  return memoryActiveRecordSchema.parse({ ...scope, id, state: 'active', revision: 1, origin: 'explicit', confidence: 1,
    sourceEventIds: [`source-${id}`], validFrom: earlier, value: { kind: 'fact', text }, ...overrides })
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-memory-provider-'))
  const providers = new Set<MemoryProvider>()
  onTestFinished(async () => {
    try {
      for (const provider of providers) await provider.stop()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  return {
    directory,
    open(path = directory) {
      const provider = value(openMemoryProvider(path, () => at))
      providers.add(provider)
      return provider
    },
  }
}

describe('independent SQLite memory provider', () => {
  it('round trips canonical revisions, source IDs and contentless tombstones in independent SQLite stores', async () => {
    const f = fixture()
    const source = f.open(join(f.directory, 'source'))
    const target = f.open(join(f.directory, 'target'))
    await assertMemorySnapshotRoundTrip(source, target, {
      access, active: active('active', 'Owner preference'), forget: active('forgotten', 'Retire this private fact'),
      forgottenAt: at, activeQuery: 'preference', forgottenQuery: 'private fact',
    })
    const snapshot = value(await target.exportSnapshot({ access }, signal))
    expect(await target.importSnapshot({ access, snapshot }, signal)).toEqual({ ok: false, code: 'conflict' })
    await target.stop()
    expect(await f.open(join(f.directory, 'target')).exportSnapshot({ access }, signal)).toEqual({ ok: true, value: snapshot })
  })

  it('normalizes bilingual keyword matching, filters validity, and keeps scope exact', async () => {
    const { open } = fixture()
    const provider = open()
    const records = [
      active('confirmed', 'Preference ＣＯＬＯＲ 蓝色。'),
      active('future', 'color 蓝色', access, { validFrom: later }),
      active('expired', 'color 蓝色', access, { validUntil: at }),
      active('candidate', 'color 蓝色', access, { origin: 'inferred', confidence: 0.4 }),
      active('different-project', 'color 蓝色', other),
      active('different-owner', 'color 蓝色', { ...access, ownerId: 'other-owner' }),
    ]
    for (const record of records) {
      const scope = { ownerId: record.ownerId, profileId: record.profileId, scope: record.scope }
      value(await provider.upsert({ access: scope, record, expectedRevision: null }, signal))
    }
    const hits = value(await provider.search({ access, query: 'Ｃｏｌｏｒ　蓝色', limit: 8 }, signal))
    expect(hits.map(hit => hit.recordId)).toEqual(['candidate', 'confirmed'])
    expect(value(await provider.read({ access, recordId: 'candidate' }, signal))).toMatchObject({ origin: 'inferred', confidence: 0.4 })
    for (const unrelated of [other, { ...access, profileId: 'other-profile' },
      { ...access, scope: { kind: 'task', taskId: 'project-fixture' } } as const]) {
      expect(await provider.read({ access: unrelated, recordId: 'confirmed' }, signal)).toEqual({ ok: true, value: null })
    }
  })

  it('replays exact lost mutation acknowledgments after cold reopen without reviving superseded or forgotten bytes', async () => {
    const f = fixture()
    const priorText = 'EXACT OLD FACT REMOVE FROM CURRENT DATABASE'
    const initial = active('original', priorText, access, { validUntil: '2026-11-07T08:30:00.000Z' })
    const first = { access, record: initial, expectedRevision: null }
    const second = { access, record: { ...initial, revision: 2, confidence: 0.9 }, expectedRevision: 1 }
    let provider = f.open()
    expect(value(await provider.upsert(first, signal))).toEqual(initial)
    await provider.stop()
    provider = f.open()
    expect(value(await provider.upsert(first, signal))).toEqual(initial)
    expect(value(await provider.upsert(second, signal))).toEqual(second.record)
    expect(value(await provider.upsert(second, signal))).toEqual(second.record)
    expect(await provider.upsert(first, signal)).toEqual({ ok: false, code: 'conflict' })

    const replacement = active('replacement', 'Corrected fact', access, { validFrom: changedAt })
    const correction = { access, recordId: initial.id, expectedRevision: 2, replacement }
    const prior = value(await provider.supersede(correction, signal))
    expect(prior).toMatchObject({ state: 'superseded', revision: 3, supersededBy: replacement.id,
      validUntil: initial.validUntil, value: initial.value })
    await provider.stop()
    expect(readFileSync(join(f.directory, MEMORY_DATABASE_FILENAME)).includes(priorText)).toBe(true)
    provider = f.open()
    expect(value(await provider.supersede(correction, signal))).toEqual(prior)
    expect(await provider.supersede({ ...correction, replacement: { ...replacement, confidence: 0.2 } }, signal))
      .toEqual({ ok: false, code: 'conflict' })
    expect(value(await provider.search({ access, query: 'OLD FACT', limit: 8 }, signal))).toEqual([])

    const forget = { access, recordId: initial.id, expectedRevision: prior.revision, forgottenAt: at }
    const tombstone = value(await provider.forget(forget, signal))
    expect(tombstone).toMatchObject({ state: 'forgotten', revision: 4, sourceEventIds: initial.sourceEventIds })
    expect('value' in tombstone).toBe(false)
    await provider.stop()
    expect(readFileSync(join(f.directory, MEMORY_DATABASE_FILENAME)).includes(priorText)).toBe(false)
    provider = f.open()
    expect(value(await provider.forget(forget, signal))).toEqual(tombstone)
    expect(await provider.forget({ ...forget, forgottenAt: later }, signal)).toEqual({ ok: false, code: 'conflict' })
    expect(await provider.upsert(first, signal)).toEqual({ ok: false, code: 'conflict' })
    expect(value(await provider.read({ access, recordId: replacement.id }, signal))).toEqual(replacement)
  })

  it('rolls back a late snapshot import failure and supports a clean retry', async () => {
    const f = fixture()
    const provider = f.open()
    const unrelated = active('existing', 'Existing record survives.', other)
    value(await provider.upsert({ access: other, record: unrelated, expectedRevision: null }, signal))
    const db = new DatabaseSync(join(f.directory, MEMORY_DATABASE_FILENAME))
    try {
      db.exec(`CREATE TRIGGER memory_fixture_fail BEFORE INSERT ON memory_records
        WHEN NEW.id = 'two' BEGIN SELECT RAISE(ABORT, 'fixture late failure'); END;`)
      const snapshot = { version: 1 as const, access, records: [active('one', 'One'), active('two', 'Two')] }
      expect(await provider.importSnapshot({ access, snapshot }, signal)).toEqual({ ok: false, code: 'conflict' })
      expect(value(await provider.exportSnapshot({ access }, signal)).records).toEqual([])
      expect(value(await provider.read({ access: other, recordId: unrelated.id }, signal))).toEqual(unrelated)
      db.exec('DROP TRIGGER memory_fixture_fail; BEGIN IMMEDIATE;')
      expect(await provider.importSnapshot({ access, snapshot }, signal)).toEqual({ ok: false, code: 'busy' })
      db.exec('ROLLBACK')
      expect(value(await provider.importSnapshot({ access, snapshot }, signal))).toEqual({ count: 2 })
      expect(value(await provider.exportSnapshot({ access }, signal))).toEqual(snapshot)
    } finally {
      db.close()
    }
  })

  it('opens only private owned files and drains admission without losing records', async () => {
    const f = fixture()
    const provider = f.open()
    const record = active('drain', 'Retained on unload')
    value(await provider.upsert({ access, record, expectedRevision: null }, signal))
    const file = join(f.directory, MEMORY_DATABASE_FILENAME)
    if (process.getuid) {
      expect(statSync(f.directory).mode & 0o777).toBe(0o700)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
    const controller = new AbortController()
    controller.abort()
    expect(await provider.read({ access, recordId: record.id }, controller.signal)).toEqual({ ok: false, code: 'cancelled' })
    expect(await provider.health(signal)).toEqual({ status: 'ready' })
    await provider.drain()
    expect(await provider.health(signal)).toEqual({ status: 'unavailable' })
    expect(await provider.read({ access, recordId: record.id }, signal)).toEqual({ ok: false, code: 'provider_unavailable' })
    await provider.stop()
    await provider.stop()

    const linked = join(f.directory, 'linked-db')
    mkdirSync(linked, { mode: 0o700 })
    linkSync(file, join(linked, MEMORY_DATABASE_FILENAME))
    expect(openMemoryProvider(linked)).toEqual({ ok: false, code: 'invalid_config' })
    rmSync(linked, { recursive: true, force: true })
    if (process.platform !== 'win32') {
      const symlink = join(f.directory, 'linked-dir')
      symlinkSync(f.directory, symlink)
      expect(openMemoryProvider(symlink)).toEqual({ ok: false, code: 'invalid_config' })
      chmodSync(file, 0o644)
      expect(openMemoryProvider(f.directory)).toEqual({ ok: false, code: 'invalid_config' })
      chmodSync(file, 0o600)
    }
    const foreignDirectory = join(f.directory, 'foreign')
    mkdirSync(foreignDirectory, { mode: 0o700 })
    const foreignPath = join(foreignDirectory, MEMORY_DATABASE_FILENAME)
    writeFileSync(foreignPath, '', { mode: 0o600 })
    const foreign = new DatabaseSync(foreignPath)
    try { foreign.exec('CREATE TABLE foreign_data (value TEXT)') } finally { foreign.close() }
    const foreignBytes = readFileSync(foreignPath)
    expect(openMemoryProvider(foreignDirectory)).toEqual({ ok: false, code: 'invalid_config' })
    expect(readFileSync(foreignPath)).toEqual(foreignBytes)
    expect(await f.open().read({ access, recordId: record.id }, signal)).toEqual({ ok: true, value: record })
  })
})
