import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { skillProjectLimit, skillSpecSchema, skillVersionLimit, type SkillSpec } from '../context/skill-contract.js'
import { sha256DigestSchema, type OwnerId, type ProfileId, type ProjectId } from '../domain/model.js'
import { StorageError, transaction } from './schema.js'

type SkillScope = { ownerId: OwnerId; profileId: ProfileId; projectId: ProjectId }
type UseFeedback = 'accepted' | 'correction'
const headerSchema = z.strictObject({
  skillId: z.uuid(), latest: z.int().positive().max(skillVersionLimit),
  active: z.int().positive().max(skillVersionLimit).nullable(), selection: z.int().nonnegative(),
})
const revisionSchema = z.strictObject({
  revision: z.int().positive(), digest: sha256DigestSchema, policyVersion: z.string(),
  spec: z.string(), evaluation: z.string().nullable(), approved: z.union([z.literal(0), z.literal(1)]),
  rollbacks: z.int().nonnegative(),
})
const useSchema = z.strictObject({
  revision: z.int().positive(), digest: sha256DigestSchema, feedback: z.enum(['accepted', 'correction']).nullable(),
})

function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const decoded = schema.safeParse(value)
  if (!decoded.success) throw new StorageError('corrupt', 'Invalid reviewed skill record')
  return decoded.data
}

function decodeJson<T>(schema: z.ZodType<T>, value: string): T {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw new StorageError('corrupt', 'Invalid reviewed skill JSON')
  }
  return decode(schema, parsed)
}

export function createSkillLedger(
  access: <T>(operation: (db: DatabaseSync) => T) => T, scope: SkillScope,
) {
  const binding = [scope.ownerId, scope.profileId, scope.projectId] as const
  const scopeWhere = 'owner_id = ? AND profile_id = ? AND project_id = ?'
  const header = (db: DatabaseSync, skillId: string) => {
    const row = db.prepare(`SELECT id AS skillId, latest, active, selection FROM reviewed_skills WHERE ${scopeWhere} AND id = ?`)
      .get(...binding, skillId)
    return row === undefined ? undefined : decode(headerSchema, row)
  }
  return {
    list: () => access(db => db.prepare(`SELECT id AS skillId, latest, active, selection FROM reviewed_skills
      WHERE ${scopeWhere} ORDER BY rowid DESC LIMIT ?`).all(...binding, skillProjectLimit).map(row => decode(headerSchema, row))),
    header: (id: string) => access(db => header(db, id)),
    read: (id: string, version: number) => access(db => {
      if (!header(db, id)) return undefined
      const row = db.prepare(`SELECT version AS revision, digest, policy_version AS policyVersion, spec, evaluation, approved, rollbacks
        FROM skill_revisions WHERE skill_id = ? AND version = ?`).get(id, version)
      if (!row) return undefined
      const revision = decode(revisionSchema, row)
      const spec = decodeJson(skillSpecSchema, revision.spec)
      const evaluation = revision.evaluation === null ? null : decodeJson(z.array(z.boolean()).length(spec.fixtures.length), revision.evaluation)
      const counts = db.prepare(`SELECT count(*) FILTER (WHERE feedback = 'accepted') AS accepted,
        count(*) FILTER (WHERE feedback = 'correction') AS corrections FROM skill_uses WHERE skill_id = ? AND version = ?`).get(id, version)
      return { ...revision, spec, evaluation, approved: revision.approved === 1,
        ...decode(z.strictObject({ accepted: z.int().nonnegative(), corrections: z.int().nonnegative() }), counts) }
    }),
    propose: (id: string, previous: number, digest: string, policy: string, spec: SkillSpec) => access(db => transaction(db, () => {
      const current = header(db, id)
      if ((current?.latest ?? 0) !== previous || previous >= skillVersionLimit) return false
      const version = previous + 1
      if (!current) {
        const count = db.prepare(`SELECT count(*) AS total FROM reviewed_skills WHERE ${scopeWhere}`).get(...binding)
        if (Number(count?.total) >= skillProjectLimit) return false
        db.prepare('INSERT INTO reviewed_skills (id, owner_id, profile_id, project_id, latest) VALUES (?, ?, ?, ?, ?)')
          .run(id, ...binding, version)
      } else db.prepare('UPDATE reviewed_skills SET latest = ? WHERE id = ?').run(version, id)
      db.prepare('INSERT INTO skill_revisions (skill_id, version, digest, policy_version, spec) VALUES (?, ?, ?, ?, ?)')
        .run(id, version, digest, policy, JSON.stringify(spec))
      return true
    })),
    evaluate: (id: string, version: number, cases: boolean[]) => access(db => {
      if (!header(db, id)) return
      db.prepare('UPDATE skill_revisions SET evaluation = ? WHERE skill_id = ? AND version = ?')
        .run(JSON.stringify(cases), id, version)
    }),
    select: (id: string, version: number, expectedSelection: number, rollback: boolean) => access(db => transaction(db, () => {
      const current = header(db, id)
      if (!current || current.selection !== expectedSelection) return false
      db.prepare('UPDATE reviewed_skills SET active = ?, selection = selection + 1 WHERE id = ?').run(version, id)
      db.prepare('UPDATE skill_revisions SET approved = 1, rollbacks = rollbacks + ? WHERE skill_id = ? AND version = ?')
        .run(rollback ? 1 : 0, id, version)
      return true
    })),
    use: (id: string, version: number, runId: string, digest: string) => access(db => transaction(db, () => {
      if (header(db, id)?.active !== version) return undefined
      db.prepare(`INSERT INTO skill_uses (skill_id, version, id, input_digest) VALUES (?, ?, ?, ?)
        ON CONFLICT (skill_id, id) DO NOTHING`).run(id, version, runId, digest)
      return decode(useSchema, db.prepare('SELECT version AS revision, input_digest AS digest, feedback FROM skill_uses WHERE skill_id = ? AND id = ?')
        .get(id, runId))
    })),
    feedback: (id: string, version: number, runId: string, value: UseFeedback) => access(db => {
      if (!header(db, id)) return false
      return db.prepare(`UPDATE skill_uses SET feedback = ? WHERE skill_id = ? AND version = ? AND id = ?
        AND (feedback IS NULL OR feedback = ?)`).run(value, id, version, runId, value).changes === 1
    }),
  }
}
