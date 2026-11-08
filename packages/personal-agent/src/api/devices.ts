import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { deviceIdSchema, ownerIdSchema, profileIdSchema, utcInstantSchema, type UtcInstant } from '../domain/model.js'
import { dispatchPermitted, recoveryMode } from '../storage/recovery-state.js'
import { transaction } from '../storage/schema.js'

const pairingLifetimeMs = 5 * 60_000
const deviceLifetimeMs = 30 * 24 * 60 * 60_000
const maximumDevices = 16
const maximumPending = 4

const secretSchema = z.string().regex(/^[a-zA-Z0-9_-]{43}$/u)
const labelSchema = z.string().trim().min(1).max(80).refine(label => !/\p{Cc}/u.test(label))
const scopeSchema = z.object({ ownerId: ownerIdSchema, profileId: profileIdSchema })
export type MobileDeviceScope = z.infer<typeof scopeSchema>
const viewSchema = z.object({
  deviceId: deviceIdSchema,
  label: labelSchema,
  state: z.enum(['pending', 'active', 'revoked']),
  expiresAt: utcInstantSchema,
  enrolledAt: utcInstantSchema.nullable(),
})
const admittedSchema = viewSchema.extend({ state: z.literal('active'), enrolledAt: utcInstantSchema })
type DatabaseAccess = <T>(operation: (db: DatabaseSync) => T) => T

const fields = 'id AS deviceId, label, state, expires_at AS expiresAt, enrolled_at AS enrolledAt'
const byScope = 'owner_id = ? AND profile_id = ?'
const active = "state = 'active' AND expires_at > ?"
const generateSecret = () => randomBytes(32).toString('base64url')
const digest = (kind: 'pair' | 'device', secret: string) => createHash('sha256').update(kind + ':' + secret).digest('hex')
const fail = <C extends string>(code: C) => ({ ok: false, code } as const)

/** Only trusted host adapters supply scope. The browser supplies a secret, never its own identity. */
export function createMobileDeviceLedger(dbAccess: DatabaseAccess, inputScope: MobileDeviceScope,
  now: () => UtcInstant = () => utcInstantSchema.parse(new Date().toISOString())) {
  const scope = scopeSchema.parse(inputScope)
  const key = [scope.ownerId, scope.profileId] as const
  const expires = (from: UtcInstant, lifetimeMs: number) => utcInstantSchema.parse(new Date(Date.parse(from) + lifetimeMs).toISOString())

  function begin(inputLabel: unknown) {
    const label = labelSchema.safeParse(inputLabel)
    if (!label.success) return fail('invalid_input')
    return dbAccess(db => transaction(db, () => {
      if (!dispatchPermitted(db)) return fail('recovery_required')
      const at = now()
      db.prepare(`DELETE FROM mobile_devices WHERE ${byScope} AND (state = 'revoked' OR expires_at <= ?)`).run(...key, at)
      const counts = db.prepare(`SELECT count(*) AS total, count(*) FILTER (WHERE state = 'pending') AS pending
        FROM mobile_devices WHERE ${byScope}`).get(...key)!
      if (Number(counts.total) >= maximumDevices || Number(counts.pending) >= maximumPending) return fail('capacity')
      const deviceId = deviceIdSchema.parse('mobile-' + randomUUID())
      const pairingCode = generateSecret()
      const expiresAt = expires(at, pairingLifetimeMs)
      db.prepare(`INSERT INTO mobile_devices (id, owner_id, profile_id, label, state, secret_hash, issued_at, expires_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).run(deviceId, ...key, label.data, digest('pair', pairingCode), at, expiresAt)
      return { ok: true, deviceId, pairingCode, expiresAt } as const
    }))
  }

  function enroll(input: unknown) {
    const code = secretSchema.safeParse(input)
    if (!code.success) return fail('invalid_pairing')
    return dbAccess(db => transaction(db, () => {
      if (!dispatchPermitted(db)) return fail('invalid_pairing')
      const at = now()
      const credential = generateSecret()
      const row = db.prepare(`UPDATE mobile_devices SET state = 'active', secret_hash = ?, enrolled_at = ?, expires_at = ?
        WHERE ${byScope} AND state = 'pending' AND secret_hash = ? AND expires_at > ?
        RETURNING ${fields}`).get(digest('device', credential), at, expires(at, deviceLifetimeMs), ...key, digest('pair', code.data), at)
      if (!row) return fail('invalid_pairing')
      return { ok: true, device: admittedSchema.parse(row), credential } as const
    }))
  }

  function authenticate(input: unknown) {
    const credential = secretSchema.safeParse(input)
    if (!credential.success) return undefined
    return dbAccess(db => {
      if (recoveryMode(db) === 'restore') return undefined
      const row = db.prepare(`SELECT ${fields} FROM mobile_devices WHERE ${byScope} AND ${active} AND secret_hash = ?`)
        .get(...key, now(), digest('device', credential.data))
      return row && admittedSchema.parse(row)
    })
  }

  function revoke(input: unknown): boolean {
    const id = deviceIdSchema.safeParse(input)
    if (!id.success) return false
    return dbAccess(db => db.prepare(`UPDATE mobile_devices SET state = 'revoked', secret_hash = NULL
      WHERE ${byScope} AND id = ? AND state <> 'revoked'`).run(...key, id.data).changes === 1)
  }

  return Object.freeze({
    begin, enroll, authenticate, revoke,
    list() {
      return dbAccess(db => db.prepare(`SELECT ${fields} FROM mobile_devices WHERE ${byScope} AND expires_at > ?
        ORDER BY issued_at DESC, id`).all(...key, now()).map(row => viewSchema.parse(row)))
    },
    verifiedDevices() {
      return dbAccess(db => {
        if (recoveryMode(db) === 'restore') return []
        return db.prepare(`SELECT ${fields} FROM mobile_devices WHERE ${byScope} AND ${active}`)
          .all(...key, now()).map(row => {
            const { deviceId, enrolledAt: verifiedAt } = admittedSchema.parse(row)
            return { deviceId, verifiedAt }
          })
      })
    },
  })
}

export type MobileDeviceLedger = ReturnType<typeof createMobileDeviceLedger>
