import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished } from 'vitest'
import { utcInstantSchema } from '../../packages/personal-agent/src/domain/model.js'
import { mediaServiceConfigSchema } from '../../packages/personal-agent/src/media/jobs.js'
import { DATABASE_FILENAME, QUARANTINE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { APPLICATION_ID, SCHEMA_VERSION, transaction } from '../../packages/personal-agent/src/storage/schema.js'
import { restoreWorkStoreBackup } from '../../packages/personal-agent/src/storage/restore.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'
import { accepted, comfyFixture, mediaRequest } from '../media/fixture.js'
import { createAttempt } from '../media/work-fixture.js'
import { migration001 } from '../../packages/personal-agent/src/storage/migrations/001.js'
import { migration002 } from '../../packages/personal-agent/src/storage/migrations/002.js'
import { migration003 } from '../../packages/personal-agent/src/storage/migrations/003.js'
import { migration004 } from '../../packages/personal-agent/src/storage/migrations/004.js'
import { migration005 } from '../../packages/personal-agent/src/storage/migrations/005.js'
import { migration006 } from '../../packages/personal-agent/src/storage/migrations/006.js'
import { migration007 } from '../../packages/personal-agent/src/storage/migrations/007.js'
import { migration008 } from '../../packages/personal-agent/src/storage/migrations/008.js'
import { migration009 } from '../../packages/personal-agent/src/storage/migrations/009.js'
import { migration010 } from '../../packages/personal-agent/src/storage/migrations/010.js'
import { migration011 } from '../../packages/personal-agent/src/storage/migrations/011.js'
import { migration012 } from '../../packages/personal-agent/src/storage/migrations/012.js'
import { migration013 } from '../../packages/personal-agent/src/storage/migrations/013.js'
import { migration014 } from '../../packages/personal-agent/src/storage/migrations/014.js'
import { migration015 } from '../../packages/personal-agent/src/storage/migrations/015.js'
import { migration016 } from '../../packages/personal-agent/src/storage/migrations/016.js'

const commonMigrations = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008, migration009, migration010, migration011, migration012, migration013]
const at = utcInstantSchema.parse('2026-11-09T10:00:00.000Z')
const variants = ['v13', 'mobile-v14', 'mobile-v15', 'media-v14'] as const
type Variant = typeof variants[number]
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

function read<T>(path: string, inspect: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return inspect(db) } finally { db.close() }
}

/** Construct the old schema from its real DDL, then copy compatible seed rows. */
async function oldFixture(variant: Variant) {
  const fixture = await comfyFixture()
  const { registry, pin } = await fixture.register()
  const source = join(fixture.directory, 'seed')
  const seed = openWorkStore(source)
  const access = createAttempt(seed, variant)
  const config = mediaServiceConfigSchema.parse({ providers: { image: pin } })
  const jobs = seed.createMediaJobs(registry, config, { current: () => true, artifactAllowed: () => false })
  const request = { ...mediaRequest(), access }
  const ref = { access, operationId: request.operationId }
  const paired = seed.mobileDevices(access, () => at)
  const invitation = paired.begin('Existing phone')
  if (!invitation.ok) throw new Error(invitation.code)
  const enrollment = paired.enroll(invitation.pairingCode)
  if (!enrollment.ok) throw new Error(enrollment.code)
  accepted(jobs.enqueue(request))
  await jobs.step()
  const status = accepted(jobs.inspect(ref))
  expect(status.state).toBe('rendering')
  await jobs.close()
  seed.close()
  onTestFinished(() => registry.close())

  const directory = join(fixture.directory, 'old')
  mkdirSync(directory, { mode: 0o700 })
  const path = join(directory, DATABASE_FILENAME)
  writeFileSync(path, '', { mode: 0o600 })
  const version = variant === 'v13' ? 13 : variant === 'mobile-v15' ? 15 : 14
  const db = new DatabaseSync(path)
  try {
    commonMigrations.forEach(migration => db.exec(migration))
    if (variant.startsWith('mobile')) db.exec(migration014)
    if (variant === 'mobile-v15') db.exec(migration015)
    // Original media migration 014 has exactly the DDL now preserved as 016.
    if (variant === 'media-v14') db.exec(migration016)
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${version}`)
    db.prepare('ATTACH DATABASE ? AS seed').run(join(source, DATABASE_FILENAME))
    transaction(db, () => {
      db.exec('PRAGMA defer_foreign_keys = ON')
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
      for (const { name } of tables) {
        const columns = db.prepare(`PRAGMA table_xinfo('${name}')`).all().filter(column => column.hidden === 0)
          .map(column => `"${column.name}"`).join(', ')
        db.exec(`DELETE FROM "${name}"; INSERT INTO "${name}" (${columns}) SELECT ${columns} FROM seed."${name}"`)
      }
    })
    db.exec('DETACH DATABASE seed')
    expect(db.prepare('PRAGMA foreign_key_check').get()).toBeUndefined()
  } finally { db.close() }
  return { fixture, directory, path, version, access, config, registry, status, ref, enrollment }
}

it.each(variants)('upgrades %s with intact work, authority rules and a readable pre-upgrade backup', async variant => {
  const f = await oldFixture(variant)
  const before = read(f.path, db => ['projects', 'tasks', 'attempts'].map(table => db.prepare(`SELECT * FROM ${table}`).all()))
  const media = variant === 'media-v14' ? read(f.path, db => db.prepare('SELECT * FROM media_jobs').all()) : []
  const store = openWorkStore(f.directory)
  onTestFinished(() => store.close())
  expect(read(f.path, db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(SCHEMA_VERSION)
  expect(read(f.path, db => ['projects', 'tasks', 'attempts'].map(table => db.prepare(`SELECT * FROM ${table}`).all()))).toEqual(before)
  expect(read(f.path, db => db.prepare('SELECT * FROM media_jobs').all())).toEqual(media)
  expect(store.mediaLeaseHeld()).toBe(variant === 'media-v14')
  if (variant.startsWith('mobile')) {
    expect(store.mobileDevices(f.access, () => at).authenticate(f.enrollment.credential)).toEqual(f.enrollment.device)
  }
  const backup = f.path + `.v${f.version}.bak`
  expect(read(backup, db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(f.version)
  const backupHash = hash(backup)
  const restoredDirectory = join(f.fixture.directory, 'restored')
  restoreWorkStoreBackup(backup, restoredDirectory)
  const restored = openWorkStore(restoredDirectory)
  try {
    expect(restored.recoveryMode()).toBe('restore')
    expect(restored.canDispatch()).toBe(false)
    expect(restored.mobileDevices(f.access, () => at).authenticate(f.enrollment.credential)).toBeUndefined()
    expect(restored.mobileDevices(f.access, () => at).list()).toEqual([])
    expect(restored.mediaLeaseHeld()).toBe(variant === 'media-v14')
    expect(read(join(restoredDirectory, DATABASE_FILENAME), db => db.prepare('SELECT * FROM media_jobs').all())).toEqual(media)
    expect(hash(backup)).toBe(backupHash)
  } finally { restored.close() }
  if (variant === 'media-v14') {
    const jobs = store.createMediaJobs(f.registry, f.config, { current: () => true, artifactAllowed: () => false })
    try {
      expect(accepted(jobs.inspect(f.ref))).toEqual(f.status)
      accepted(jobs.cancel(f.ref))
      await jobs.step()
      expect(accepted(jobs.inspect(f.ref)).state).toBe('cancelled')
      expect(store.mediaLeaseHeld()).toBe(false)
      expect(f.fixture.submissions).toHaveLength(1)
    } finally { await jobs.close() }
  }
})

it('rejects an unrecognized media-v14 shape without relabeling or quarantining the source', async () => {
  const f = await oldFixture('media-v14')
  const db = new DatabaseSync(f.path)
  try { db.exec('DROP INDEX media_single_lease') } finally { db.close() }
  const original = hash(f.path)
  expect(() => openWorkStore(f.directory)).toThrowError(expect.objectContaining({ code: 'unsupported_schema' }))
  expect(hash(f.path)).toBe(original)
  expect(existsSync(join(f.directory, QUARANTINE_FILENAME))).toBe(false)
  expect(existsSync(f.path + '.v14.bak')).toBe(false)
})

it('rolls a failed v15 upgrade back and retains the exact source rows and private backup', async () => {
  const f = await oldFixture('mobile-v15')
  const db = new DatabaseSync(f.path)
  try { db.exec("CREATE TABLE media_jobs (marker TEXT); INSERT INTO media_jobs VALUES ('preserve')") } finally { db.close() }
  expect(() => openWorkStore(f.directory)).toThrowError(expect.objectContaining({ code: 'migration_failed' }))
  expect(read(f.path, db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(15)
  expect(read(f.path, db => db.prepare('SELECT marker FROM media_jobs').get()?.marker)).toBe('preserve')
  expect(read(f.path + '.v15.bak', db => db.prepare('SELECT marker FROM media_jobs').get()?.marker)).toBe('preserve')
})
