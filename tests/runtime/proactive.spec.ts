import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { attemptIdSchema, mandateRefSchema, profileSchema, projectIdSchema, projectSchema, taskIdSchema, utcInstantSchema } from '../../packages/personal-agent/src/domain/model.js'
import type { ProactiveMode } from '../../packages/personal-agent/src/domain/proactive.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import { createProactive } from '../../packages/personal-agent/src/runtime/proactive.js'
import { createRouter, type RoutingAssessor } from '../../packages/personal-agent/src/runtime/router.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'

const origin = Date.parse('2026-11-08T10:00:00.000Z')
const sourceInstanceId = 'verified-source'
const accountId = 'verified-account'
const taskId = taskIdSchema.parse('goal-anchor')
const projectId = 'goal-project'
const threadId = 'goal-thread'
const ruleId = 'delivery-readiness'
const draft = { title: 'Project update', projectId, taskId, sourceInstanceId, accountId, threadId,
  query: 'ready 发布', freshForMs: 30_000, cooldownMs: 1000, dedupeMs: 60_000 }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dshpa-proactive-test-'))
  const store = openWorkStore(root)
  let time = origin
  const now = () => utcInstantSchema.parse(new Date(time).toISOString())
  let profile = profileSchema.parse({ id: 'observe-profile', ownerId: 'observe-owner', policyVersion: 'observe-policy',
    verifiedAccounts: [{ sourceInstanceId, accountId, verifiedAt: now() }],
    verifiedDevices: [{ deviceId: 'owner-device', verifiedAt: now() }] })
  const scope = { ownerId: profile.ownerId, profileId: profile.id }
  const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
  const ownerToken = identity.bindOwner({ ...scope, deviceId: 'owner-device', clientId: 'client', sessionId: 'session' })
  const owner = identity.resolveOwner(ownerToken)
  const source = identity.bindSource({ ...scope, sourceInstanceId, accountId })
  assert.ok(owner && source)
  const project = projectSchema.parse({ ...scope, id: projectId, kind: 'goal', title: 'Release readiness', purpose: 'Prepare a sourced brief.',
    status: 'active', successCriteria: ['Confirm readiness.'], resourceRefs: [], planRevision: 1, milestones: [] })
  store.insertProject(project)
  const work = store.applyCommand({ type: 'work.create', commandId: 'anchor', payload: { projectId: project.id,
    requestedOutcome: 'Review a private brief.', constraints: [], acceptance: { criteria: ['Review evidence.'], requiresArtifact: true, requiresReceipt: false } } },
  { actor: owner, at: now(), projectId: project.id, newTaskId: taskId, newAttempt: { id: attemptIdSchema.parse('goal-attempt'),
    mandate: mandateRefSchema.parse({ ...scope, id: 'goal-mandate', policyVersion: owner.policyVersion }) } })
  assert.ok(work.ok, JSON.stringify(work))
  const attention = store.createAttention({ now })
  let budget = true
  let hold: Promise<void> | undefined
  const assess = vi.fn<RoutingAssessor>(async batch => {
    await hold
    return batch.map(item => ({ id: item.id, kind: 'propose_task', summary: 'Review the scoped source.' }))
  })
  const proactive = createProactive({ store, identity, scope, attention, assess, canAssess: () => budget,
    assessmentDataScope: ['team'], now })
  const router = createRouter({ store, identity, proactive: proactive.consider, now })
  onTestFinished(async () => {
    router.close()
    await proactive.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  function state() {
    const result = proactive.handle({ type: 'proactive_state' })
    assert.ok(result.ok && result.kind === 'proactive_state')
    return result
  }
  function policy(mode: ProactiveMode, quietHours: { start: string; end: string } | null = null) {
    expect(attention.configure(scope, { mode, quietHours, timeZone: 'UTC', urgentRules: [] }, attention.policy(scope).version))
      .toMatchObject({ ok: true })
    proactive.invalidate()
  }
  function enable(mode: ProactiveMode, grant?: string) {
    return proactive.handle({ type: 'proactive_mode', ruleId, expectedVersion: state().rules[0]!.version, mode, grant })
  }
  function receive(id: string, text: string, extra = {}) {
    return router.receive(source, { kind: 'candidate', projectId, threadId, externalEventId: id, externalRevision: '1',
      occurredAt: now(), actorKind: 'person', externalActorId: 'source-actor', text, dataScope: ['team'], ...extra })
  }
  async function propose(id: string, expected: 'proposed' | 'prepared' | 'surfaced') {
    time += 2000
    expect(receive(id, `ready 发布 ${id}`)).toMatchObject({ ok: true })
    return vi.waitFor(() => {
      const latest = state().candidates[0]
      assert.ok(latest)
      expect(latest.status).toBe(expected)
      return latest
    }, { interval: 5, timeout: 1000 })
  }
  return {
    state, policy, enable, receive, propose, proactive, attention, assess, scope, store, now, router,
    setTime: (value: number) => { time = value }, budget: (value: boolean) => { budget = value }, hold: (value: Promise<void>) => { hold = value },
    revoke() { profile = { ...profile, verifiedAccounts: [] } },
  }
}

describe('goal-bound proactive work', () => {
  it('replays and stages a 100-event stream with quiet preparation and a shared notification cap', async () => {
    const f = fixture()
    expect(f.proactive.handle({ type: 'proactive_save_rule', ruleId, expectedVersion: null, draft })).toMatchObject({ ok: true })
    expect(f.enable('observe')).toEqual({ ok: false, code: 'replay_required' })
    f.receive('sample', 'ready 发布 sample')
    expect(f.assess).not.toHaveBeenCalled()
    const replay = f.proactive.handle({ type: 'proactive_replay', ruleId, expectedVersion: f.state().rules[0]!.version })
    expect(replay).toMatchObject({ rules: [{ replay: { matched: 1, examined: 1 } }] })
    expect(f.enable('observe')).toMatchObject({ ok: true })
    f.policy('observe')

    // 20 useful candidates, 75 noise, a same-event replay, a content repeat,
    // one cooldown rejection, one stale source and one disallowed label.
    const proposals = [await f.propose('proposal-0', 'proposed')]
    expect(f.receive('proposal-0', 'ready 发布 proposal-0')).toMatchObject({ duplicate: true })
    expect(f.receive('same-content', 'ready 发布 proposal-0')).toMatchObject({ disposition: { reason: 'proactive-duplicate_content' } })
    expect(f.receive('cooldown', 'ready 发布 during cooldown')).toMatchObject({ disposition: { reason: 'proactive-cooldown' } })
    expect(f.receive('stale', 'ready 发布 stale', { occurredAt: new Date(origin - 60_000).toISOString() }))
      .toMatchObject({ disposition: { reason: 'proactive-stale_source' } })
    expect(f.receive('secret', 'ready 发布 confidential', { dataScope: ['private'] }))
      .toMatchObject({ disposition: { reason: 'proactive-disclosure_denied' } })
    for (let i = 0; i < 75; i++) f.receive(`noise-${i}`, 'No match for this unrelated event.')
    for (let i = 1; i < 20; i++) proposals.push(await f.propose(`proposal-${i}`, 'proposed'))
    expect(f.assess).toHaveBeenCalledTimes(20)
    expect(f.proactive.notices()).toEqual([])
    expect(f.enable('prepare', 'read_source')).toEqual({ ok: false, code: 'observation_required' })
    for (const [i, candidate] of proposals.entries()) {
      expect(f.proactive.handle({ type: 'proactive_feedback', candidateId: candidate.id, useful: i < 14 })).toMatchObject({ ok: true })
    }
    expect(f.enable('prepare')).toEqual({ ok: false, code: 'observation_required' })
    expect(f.enable('prepare', 'read_source')).toMatchObject({ ok: true })
    f.policy('prepare')
    const brief = await f.propose('private-brief', 'prepared')
    expect(f.proactive.handle({ type: 'proactive_artifact', candidateId: brief.id })).toMatchObject({ text: 'Review the scoped source.' })
    assert.ok(brief.artifactId)
    expect(f.store.artifacts.read({ ...f.scope, taskId }, brief.artifactId)?.artifact.visibility).toBe('private')
    expect(f.attention.snapshot(f.scope).unsolicitedUsed).toBe(0)
    expect(f.enable('act', 'surface_private_brief')).toEqual({ ok: false, code: 'preparation_required' })
    f.proactive.handle({ type: 'proactive_feedback', candidateId: brief.id, useful: true })
    expect(f.enable('act', 'surface_private_brief')).toMatchObject({ ok: true })
    f.policy('act')
    for (let i = 0; i < 3; i++) await f.propose(`notice-${i}`, 'surfaced')
    expect((await f.propose('capped', 'prepared')).reason).toBe('daily_limit')
    expect(f.proactive.notices()).toHaveLength(3)
    expect(f.attention.snapshot(f.scope).unsolicitedUsed).toBe(3)
    f.setTime(Date.parse('2026-11-09T23:00:00.000Z'))
    f.policy('act', { start: '22:00', end: '08:00' })
    expect((await f.propose('quiet', 'prepared')).reason).toBe('quiet_hours')
    expect(f.proactive.notices()).toEqual([])
    f.revoke()
    expect(f.proactive.handle({ type: 'proactive_artifact', candidateId: brief.id })).toEqual({ ok: false, code: 'source_unavailable' })
  })

  it('skips unavailable budgets and discards an in-flight assessment after policy changes', async () => {
    const f = fixture()
    f.proactive.handle({ type: 'proactive_save_rule', ruleId, expectedVersion: null, draft })
    f.receive('sample', 'ready 发布 sample')
    f.proactive.handle({ type: 'proactive_replay', ruleId, expectedVersion: f.state().rules[0]!.version })
    f.enable('observe')
    f.policy('observe')
    f.budget(false)
    expect(f.receive('denied', 'ready 发布 denied')).toMatchObject({ disposition: { reason: 'proactive-budget_unavailable' } })
    expect(f.assess).not.toHaveBeenCalled()
    f.budget(true)
    const gate = Promise.withResolvers<void>()
    f.hold(gate.promise)
    try {
      f.receive('pending', 'ready 发布 pending')
      await vi.waitFor(() => expect(f.assess).toHaveBeenCalledOnce())
      f.policy('off')
    } finally { gate.resolve() }
    await vi.waitFor(() => expect(f.state().candidates[0]).toMatchObject({ status: 'suppressed', reason: 'authority_changed' }))
    expect(f.proactive.notices()).toEqual([])
  })

  it('records a silent non-proposal and invalidates a rule when its goal revision changes', async () => {
    const f = fixture()
    f.proactive.handle({ type: 'proactive_save_rule', ruleId, expectedVersion: null, draft })
    f.receive('sample', 'ready 发布 sample')
    f.proactive.handle({ type: 'proactive_replay', ruleId, expectedVersion: f.state().rules[0]!.version })
    f.enable('observe')
    f.policy('observe')
    f.assess.mockImplementationOnce(async batch => batch.map(item => ({ kind: 'ignore', id: item.id })))
    f.receive('ignored', 'ready 发布 no useful evidence')
    await vi.waitFor(() => expect(f.state().candidates[0]).toMatchObject({ status: 'suppressed', reason: 'no_useful_suggestion' }))
    expect(f.proactive.notices()).toEqual([])
    const goal = projectIdSchema.parse(projectId)
    expect(f.store.saveProjectPlan(f.scope, { projectId: goal, commandId: 'new-goal', expectedRevision: 1, at: f.now(),
      rationale: 'Change the intended outcome.', draft: { title: 'Different goal', purpose: 'Review a different outcome.',
        successCriteria: ['Check the revised goal.'], priority: 'normal', milestones: [] },
    })).toMatchObject({ ok: true })
    f.setTime(origin + 5000)
    expect(f.receive('new-scope', 'ready 发布 changed goal')).toMatchObject({ disposition: { reason: 'proactive-rule_authority_changed' } })
    expect(f.assess).toHaveBeenCalledOnce()
    expect(f.state().rules[0]?.current).toBe(false)
    expect(f.proactive.handle({ type: 'proactive_save_rule', ruleId, expectedVersion: f.state().rules[0]!.version, draft }))
      .toMatchObject({ rules: [{ mode: 'off', current: true }] })
    expect(f.enable('observe')).toEqual({ ok: false, code: 'replay_required' })
  })
})
