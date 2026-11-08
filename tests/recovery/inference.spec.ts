import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, ownerIdSchema, profileIdSchema, projectSchema,
  taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'
import { createNativeProfile, nativeAgentRows, nativeProfileTimeoutMs, nativeSessionPersistenceRows } from '../contracts/native-profile.js'

const at = utcInstantSchema.parse('2026-11-08T02:00:00.000Z')
const scope = { ownerId: ownerIdSchema.parse('inference-owner'), profileId: profileIdSchema.parse('profile-a') }
const other = { ...scope, profileId: profileIdSchema.parse('profile-b') }
const a = { id: 'deploy-a', revision: 1 }
const b = { id: 'deploy-b', revision: 1 }
const c = { id: 'deploy-c', revision: 2 }
const pin = { id: 'routing', revision: 1 }
const policy = { ...pin, mode: 'automatic', maxSwitches: 2,
  pools: { fast: [a, b], balanced: [b, c], deep: [c] } }
const shared = { id: 'primary', revision: 1, accountId: 'provider-account', requestsPerMinute: 1, tokensPerMinute: 1024 }
const alternate = { ...shared, id: 'alternate', accountId: 'other-account' }
const price = { kind: 'known', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000,
  cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0, ceilingMicros: 20 } as const
const usage = { inputTokens: 2, outputTokens: 2 }

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(JSON.stringify(result))
  return result as Extract<T, { ok: true }>
}

function task(store: WorkStore, id: string, owner = scope) {
  const project = projectSchema.parse({
    ...owner, id: `project-${id}`, kind: 'project', title: 'Inference',
    purpose: 'Verify scoped inference.', resourceRefs: [], status: 'active',
    successCriteria: ['Verify the result.'], planRevision: 1, milestones: [],
  })
  store.insertProject(project)
  const actor = { ...owner, role: 'owner' as const, clientId: clientIdSchema.parse('fixture'),
    deviceId: deviceIdSchema.parse('device'), policyVersion: 'policy-1' }
  const ref = { ...owner, taskId: taskIdSchema.parse(`task-${id}`) }
  const { state } = ok(store.applyCommand({
    type: 'work.create', commandId: `create-${id}`, payload: {
      projectId: project.id, requestedOutcome: 'Use routed inference.', constraints: [],
      acceptance: { criteria: ['Verify the result.'], requiresArtifact: false, requiresReceipt: false },
    },
  }, {
    actor, at, projectId: project.id, newTaskId: ref.taskId,
    newAttempt: { id: attemptIdSchema.parse(`attempt-${id}`),
      mandate: mandateRefSchema.parse({ ...owner, id: `mandate-${id}`, policyVersion: actor.policyVersion }) },
  }))
  const started = ok(store.applyEvent(ref, { type: 'start', at, attemptId: state.attempt.id,
    generation: state.attempt.generation, expectedVersion: state.task.version, executor: 'routed-inference' }))
  return { ref, state: started.state }
}

function plan(work: ReturnType<typeof task>, deploy: typeof a, bucket = shared, suffix = deploy.id, previousAttemptId?: string) {
  const taskScope = { taskId: work.ref.taskId, taskAttemptId: work.state.attempt.id, generation: work.state.attempt.generation }
  const id = `${work.ref.taskId}-${suffix}`
  return {
    policy, bucket, maxAttempts: 3, unattended: true, expectedVersion: work.state.task.version,
    deployment: { ...deploy, provider: deploy.id, model: 'model', accountId: bucket.accountId, quotaBucketId: bucket.id,
      destination: { kind: 'local' }, capabilities: [], dataScope: ['work'], contextTokens: 4096,
      outputTokens: 1024, nativeEfforts: [], effort: {} },
    decision: { ...taskScope, id, kind: 'dispatch', deployment: deploy, policy: pin, decidedAt: at,
      acceptanceDigest: 'a'.repeat(64), requirements: { capabilities: [], dataScope: ['work'], inputTokens: 4, outputTokens: 4 },
      excluded: [], basis: previousAttemptId ? 'fallback' : 'rule' },
    attempt: { ...taskScope, id, deployment: deploy, accountId: bucket.accountId, quotaBucketId: bucket.id,
      decisionId: id, requestSeriesId: `series-${id}`, createdAt: at, status: 'planned', budgetReservationIds: [], previousAttemptId },
  }
}

function fixture(maxMicros = 100) {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-inference-'))
  let store = openWorkStore(directory)
  let clock = at
  const open = () => {
    const budget = store.createBudget({
      now: () => clock, pricingVersion: 'fixture-price',
      routes: [a, b, c].map(deploy => ({ provider: deploy.id, model: 'model', currency: 'USD', pricing: price })),
      limits: [{ currency: 'USD', ownerDayMicros: maxMicros, taskMicros: maxMicros,
        maxCallsPerDay: 16, maxCallsPerTask: 8, maxConcurrent: 8 }],
    })
    return { store, budget, ledger: store.createInferenceLedger({ now: () => clock, allowBoundedUnknown: true }) }
  }
  onTestFinished(() => { try { store.close() } finally { rmSync(directory, { recursive: true, force: true }) } })
  return { ...open(), directory, advance(ms: number) { clock = utcInstantSchema.parse(new Date(Date.parse(at) + ms).toISOString()) },
    reopen() { store.close(); store = openWorkStore(directory); return open() } }
}

describe('durable inference and quota claims', () => {
  it('claims quota and spend together and shares a provider bucket across deployment and profile aliases', async () => {
    const f = fixture()
    const one = task(f.store, 'one')
    const two = task(f.store, 'two', other)
    const left = plan(one, a)
    const right = plan(two, b)
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => f.ledger.begin(one.ref, left)),
      Promise.resolve().then(() => f.ledger.begin(two.ref, right)),
    ])
    expect(first).toMatchObject({ ok: true, reservation: { status: 'claimed' } })
    expect(second).toMatchObject({ ok: false, code: 'quota', quota: { reason: 'rate-limit' } })
    expect(f.ledger.get(two.ref, right.attempt.id)).toBeUndefined()
    expect(f.budget.snapshot(other).currencies).toEqual([])
    expect(f.ledger.get({ ...one.ref, profileId: other.profileId }, left.attempt.id)).toBeUndefined()
    f.advance(60_000)
    expect(f.ledger.begin(two.ref, right)).toMatchObject({ ok: true })
  })

  it('preserves a partial attempt and its uncertain fee after reopening, then admits a separate inference only once', () => {
    const f = fixture(40)
    const work = task(f.store, 'restart')
    const original = plan(work, a)
    const first = ok(f.ledger.begin(work.ref, original)).reservation
    expect(f.ledger.partial(work.ref, original.attempt.id)).toBe(true)
    f.advance(61_000)
    const cold = f.reopen()
    expect(cold.ledger.get(work.ref, original.attempt.id)).toMatchObject({
      status: 'interrupted', budgetStatus: 'uncertain', partial: true, budgetId: first.id,
    })
    expect(cold.budget.snapshot(scope).currencies).toContainEqual(expect.objectContaining({ uncertainMicros: 20 }))
    expect(cold.ledger.begin(work.ref, original)).toMatchObject({ ok: false, code: 'duplicate' })
    const wrong = plan(work, c, alternate, 'changed', original.attempt.id)
    expect(cold.ledger.begin(work.ref, { ...wrong, decision: { ...wrong.decision, acceptanceDigest: 'b'.repeat(64) } }))
      .toMatchObject({ ok: false, code: 'chain' })
    const next = plan(work, c, alternate, 'fallback', original.attempt.id)
    const second = ok(cold.ledger.begin(work.ref, next)).reservation
    expect(second.id).not.toBe(first.id)
    expect(cold.ledger.history(work.ref, next.attempt.id)).toMatchObject([
      { id: original.attempt.id, ordinal: 1, seriesId: original.attempt.requestSeriesId, status: 'interrupted' },
      { id: next.attempt.id, ordinal: 2, seriesId: next.attempt.requestSeriesId, status: 'streaming' },
    ])
    expect(cold.ledger.reconcileFee(work.ref, original.attempt.id, usage)).toBe(true)
    expect(cold.ledger.reconcileFee(work.ref, original.attempt.id, usage)).toBe(false)
    expect(cold.ledger.get(work.ref, original.attempt.id)).toMatchObject({ status: 'interrupted', budgetStatus: 'settled' })
    expect(cold.budget.settle(second, usage)).toBe(true)
    expect(cold.ledger.finish(work.ref, next.attempt.id)).toBe(true)
    expect(cold.store.getWork(work.ref)).toEqual(work.state)
  })

  it('rolls back the inference and quota claim if the paired spend row cannot be written', () => {
    const f = fixture()
    const work = task(f.store, 'rollback')
    const planned = plan(work, a)
    const db = new DatabaseSync(join(f.directory, DATABASE_FILENAME))
    try {
      db.exec(`CREATE TRIGGER reject_fixture_budget BEFORE INSERT ON budget_reservations
        BEGIN SELECT RAISE(ABORT, 'fixture budget insert failure'); END`)
      expect(() => f.ledger.begin(work.ref, planned)).toThrow(expect.objectContaining({ code: 'conflict' }))
      expect(f.ledger.get(work.ref, planned.attempt.id)).toBeUndefined()
      expect(f.budget.snapshot(scope).currencies).toEqual([])
      expect(f.ledger.quota(scope, shared, 8)).toEqual({ kind: 'ready', telemetry: 'unknown' })
      db.exec('DROP TRIGGER reject_fixture_budget')
      expect(f.ledger.begin(work.ref, planned)).toMatchObject({ ok: true })
    } finally { db.close() }
  })

  it('retains account exhaustion through a restart until authenticated quota readback clears it', () => {
    const f = fixture()
    const work = task(f.store, 'quota')
    const original = plan(work, a)
    const reservation = ok(f.ledger.begin(work.ref, original)).reservation
    expect(f.budget.uncertain(reservation)).toBe(true)
    expect(f.ledger.finish(work.ref, original.attempt.id, { reason: 'quota', scope: 'account' })).toBe(true)
    f.advance(600_000)
    const cold = f.reopen()
    const secondary = { ...shared, id: 'secondary' }
    expect(cold.ledger.quota(other, secondary, 8)).toMatchObject({ kind: 'wait', reason: 'quota' })
    const observedAt = new Date(Date.parse(at) + 600_000).toISOString()
    expect(cold.ledger.recordQuota(scope, shared.accountId, { bucket: { id: shared.id, revision: shared.revision }, observedAt, provenance: 'estimate',
      status: 'available', remainingRequests: 5 }, 'account')).toBe(false)
    expect(cold.ledger.recordQuota(scope, shared.accountId, { bucket: { id: shared.id, revision: shared.revision }, observedAt, provenance: 'provider',
      status: 'available', remainingRequests: 5 }, 'account')).toBe(true)
    expect(cold.ledger.quota(other, secondary, 8)).toEqual({ kind: 'ready', telemetry: 'unknown' })
  })

  it('leaves no inference row when the atomic Core spend ceiling wins the race', async () => {
    const f = fixture(20)
    const one = task(f.store, 'first')
    const two = task(f.store, 'second')
    const left = plan(one, a)
    const right = plan(two, c, alternate)
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => f.ledger.begin(one.ref, left)),
      Promise.resolve().then(() => f.ledger.begin(two.ref, right)),
    ])
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: false, code: 'budget_exceeded' })
    expect(f.ledger.get(two.ref, right.attempt.id)).toBeUndefined()
    expect(f.ledger.quota(scope, alternate, 8)).toMatchObject({ kind: 'ready' })
  })
})


it('uses a fresh native inference series across fallback and a persisted resource wait', () => {
  const profile = createNativeProfile({
    probe: fileURLToPath(new URL('./fixtures/routed-inference-probe.mjs', import.meta.url)),
    patchRows: [...nativeAgentRows, ...nativeSessionPersistenceRows],
  })
  try {
    const result = profile.run('routed-inference')
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('PA042_NATIVE_INFERENCE fallback wait receipts')
  } finally { profile.dispose() }
}, nativeProfileTimeoutMs + 1000)


it('recovers a real process exit during native output without resending the original request', () => {
  const profile = createNativeProfile({
    probe: fileURLToPath(new URL('./fixtures/routed-inference-probe.mjs', import.meta.url)),
    patchRows: [...nativeAgentRows, ...nativeSessionPersistenceRows],
  })
  try {
    const interrupted = profile.run('inference-crash')
    expect(interrupted.signal, interrupted.stderr).toBeNull()
    expect(interrupted.status, interrupted.stderr).toBe(86)
    const recovered = profile.run('inference-recover')
    expect(recovered.signal, recovered.stderr).toBeNull()
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stdout).toBe('PA042_NATIVE_INFERENCE recovered')
  } finally { profile.dispose() }
}, 2 * nativeProfileTimeoutMs + 1000)
