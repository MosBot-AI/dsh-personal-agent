import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import { proactiveCandidateSchema, proactiveRuleSchema, type ProactiveCandidate, type ProactiveRule } from '../domain/proactive.js'
import type { OwnerId, ProfileId } from '../domain/model.js'
import { dispatchPermitted } from './recovery-state.js'
import { StorageError, transaction } from './schema.js'

export type ProactiveScope = Readonly<{ ownerId: OwnerId; profileId: ProfileId }>
const MAX_RULES = 32
const MAX_CANDIDATES = 4096
const fail = <T extends string>(code: T) => ({ ok: false as const, code })
const parameters = (scope: ProactiveScope) => [scope.ownerId, scope.profileId] as const

export function proactiveRuleScope(draft: Pick<ProactiveRule['draft'], 'projectId' | 'sourceInstanceId' | 'accountId' | 'threadId'>): string {
  return JSON.stringify([draft.projectId, draft.sourceInstanceId, draft.accountId, draft.threadId])
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  try { if (typeof raw === 'string' && Buffer.byteLength(raw) <= 65536) return schema.parse(JSON.parse(raw)) } catch { /* Fail closed. */ }
  throw new StorageError('corrupt', 'Stored proactive evidence failed validation')
}

export function createProactiveLedger(access: <T>(operation: (db: DatabaseSync) => T) => T, scope: ProactiveScope) {
  const key = parameters(scope)
  function ruleAt(db: DatabaseSync, id: string) {
    const row = db.prepare('SELECT record FROM proactive_rules WHERE owner_id = ? AND profile_id = ? AND id = ?').get(...key, id)
    return row && parse(proactiveRuleSchema, row.record)
  }
  function candidateAt(db: DatabaseSync, id: string) {
    const row = db.prepare('SELECT record FROM proactive_candidates WHERE owner_id = ? AND profile_id = ? AND id = ?').get(...key, id)
    return row && parse(proactiveCandidateSchema, row.record)
  }
  function writeCandidate(db: DatabaseSync, candidate: ProactiveCandidate) {
    db.prepare('UPDATE proactive_candidates SET record = ? WHERE owner_id = ? AND profile_id = ? AND id = ?')
      .run(JSON.stringify(proactiveCandidateSchema.parse(candidate)), ...key, candidate.id)
  }

  return {
    rule: (id: string) => access(db => ruleAt(db, id)),
    ruleFor: (scopeKey: string) => access(db => {
      const row = db.prepare('SELECT record FROM proactive_rules WHERE owner_id = ? AND profile_id = ? AND scope_key = ?').get(...key, scopeKey)
      return row && parse(proactiveRuleSchema, row.record)
    }),
    rules: () => access(db => db.prepare('SELECT record FROM proactive_rules WHERE owner_id = ? AND profile_id = ? ORDER BY id LIMIT ?')
      .all(...key, MAX_RULES).map(row => parse(proactiveRuleSchema, row.record))),
    save(rule: ProactiveRule, expected: number | null) {
      return access(db => transaction(db, () => {
        if (!dispatchPermitted(db)) return fail('recovery_required')
        const previous = ruleAt(db, rule.id)
        if (expected === null && previous?.spec === rule.spec) return { ok: true as const, rule: previous }
        if ((previous?.version ?? null) !== expected) return fail('version_conflict')
        const scopeKey = proactiveRuleScope(rule.draft)
        if (db.prepare('SELECT 1 FROM proactive_rules WHERE owner_id = ? AND profile_id = ? AND scope_key = ? AND id <> ?')
          .get(...key, scopeKey, rule.id)) return fail('scope_conflict')
        if (!previous && Number(db.prepare('SELECT count(*) AS total FROM proactive_rules WHERE owner_id = ? AND profile_id = ?')
          .get(...key)?.total) >= MAX_RULES) return fail('capacity')
        db.prepare(`INSERT INTO proactive_rules (owner_id, profile_id, id, scope_key, record) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(owner_id, profile_id, id) DO UPDATE SET scope_key = excluded.scope_key, record = excluded.record`)
          .run(...key, rule.id, scopeKey, JSON.stringify(proactiveRuleSchema.parse(rule)))
        return { ok: true as const, rule }
      }))
    },
    counts(rule: ProactiveRule) {
      return access(db => {
        const row = db.prepare(`SELECT count(*) FILTER (WHERE json_type(record,'$.useful') IN ('true','false')) AS reviewed,
          count(*) FILTER (WHERE json_type(record,'$.useful') = 'true') AS useful,
          count(*) FILTER (WHERE json_type(record,'$.useful') = 'true' AND (record ->> '$.status') = 'prepared') AS prepared
          FROM proactive_candidates WHERE owner_id = ? AND profile_id = ? AND rule_id = ? AND spec = ?`)
          .get(...key, rule.id, rule.spec)
        return { reviewed: Number(row?.reviewed), useful: Number(row?.useful), prepared: Number(row?.prepared) }
      })
    },
    candidate: (id: string) => access(db => candidateAt(db, id)),
    candidates: () => access(db => db.prepare('SELECT record FROM proactive_candidates WHERE owner_id = ? AND profile_id = ? ORDER BY rowid DESC LIMIT 100')
      .all(...key).map(row => parse(proactiveCandidateSchema, row.record))),
    admit(rule: ProactiveRule, candidate: ProactiveCandidate, fingerprint: string) {
      return access(db => transaction(db, () => {
        if (!dispatchPermitted(db)) return fail('recovery_required')
        if (ruleAt(db, rule.id)?.version !== rule.version) return fail('version_conflict')
        if (candidateAt(db, candidate.id)) return fail('duplicate')
        if (Number(db.prepare('SELECT count(*) AS total FROM proactive_candidates WHERE owner_id = ? AND profile_id = ?')
          .get(...key)?.total) >= MAX_CANDIDATES) return fail('capacity')
        let next = candidate
        if (candidate.status === 'pending') {
          const now = Date.parse(candidate.at)
          const bound = (ms: number) => new Date(now - ms).toISOString()
          const dedupe = db.prepare(`SELECT 1 FROM proactive_candidates
            WHERE owner_id = ? AND profile_id = ? AND rule_id = ? AND spec = ? AND admitted_at >= ? AND fingerprint = ? LIMIT 1`)
            .get(...key, rule.id, rule.spec, bound(rule.draft.dedupeMs), fingerprint)
          const cooldown = db.prepare(`SELECT 1 FROM proactive_candidates
            WHERE owner_id = ? AND profile_id = ? AND rule_id = ? AND spec = ? AND admitted_at >= ? LIMIT 1`)
            .get(...key, rule.id, rule.spec, bound(rule.draft.cooldownMs))
          if (dedupe || cooldown) next = { ...candidate, status: 'suppressed', reason: dedupe ? 'duplicate_content' : 'cooldown' }
        }
        db.prepare(`INSERT INTO proactive_candidates (id, owner_id, profile_id, rule_id, event_id, spec, fingerprint, admitted_at, record)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(next.id, ...key, rule.id, next.eventId, rule.spec, fingerprint, next.status === 'pending' ? next.at : null,
            JSON.stringify(proactiveCandidateSchema.parse(next)))
        return { ok: true as const, candidate: next }
      }))
    },
    settle(id: string, result: Pick<ProactiveCandidate, 'status' | 'reason' | 'summary' | 'artifactId'>) {
      return access(db => transaction(db, () => {
        const candidate = candidateAt(db, id)
        if (!candidate || candidate.status !== 'pending') return false
        writeCandidate(db, { ...candidate, ...result })
        return true
      }))
    },
    feedback(id: string, useful: boolean) {
      return access(db => transaction(db, () => {
        if (!dispatchPermitted(db)) return fail('recovery_required')
        const candidate = candidateAt(db, id)
        if (!candidate || !['proposed', 'prepared', 'surfaced'].includes(candidate.status)) return fail('not_found')
        writeCandidate(db, { ...candidate, useful })
        return { ok: true as const }
      }))
    },
    recover() {
      return access(db => transaction(db, () => {
        const rows = db.prepare(`SELECT record FROM proactive_candidates WHERE owner_id = ? AND profile_id = ?
          AND (record ->> '$.status') = 'pending'`).all(...key)
        for (const row of rows) writeCandidate(db, { ...parse(proactiveCandidateSchema, row.record), status: 'suppressed', reason: 'interrupted' })
      }))
    },
  }
}

export type ProactiveLedger = ReturnType<typeof createProactiveLedger>
