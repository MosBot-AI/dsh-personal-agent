import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, ownerIdSchema, profileIdSchema,
  projectSchema, taskIdSchema, utcInstantSchema, type UtcInstant,
} from '../../packages/personal-agent/src/domain/model.js'
import { budgetConfigSchema, type BudgetConfig } from '../../packages/personal-agent/src/runtime/budget.js'
import { openWorkStore, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const at = utcInstantSchema.parse('2026-11-07T23:59:50.000Z')
const nextDay = utcInstantSchema.parse('2026-11-08T00:00:00.000Z')
const scope = { ownerId: ownerIdSchema.parse('budget-owner'), profileId: profileIdSchema.parse('budget-profile') }
const route = { provider: 'fixture', model: 'priced-model' }
const request = { ...scope, ...route, unattended: true, upperInputTokens: 2, upperOutputTokens: 2 }
const price = {
  kind: 'known',
  inputMicrosPerMillion: 2_000_000,
  outputMicrosPerMillion: 3_000_000,
  cacheReadMicrosPerMillion: 500_000,
  cacheWriteMicrosPerMillion: 4_000_000,
  ceilingMicros: 20,
} as const
const limit = { currency: 'USD', ownerDayMicros: 40, taskMicros: 40, maxCallsPerDay: 16, maxCallsPerTask: 8, maxConcurrent: 8 }
const configured = budgetConfigSchema.parse({
  pricingVersion: 'fixture-price-1', routes: [{ ...route, currency: 'USD', pricing: price }], limits: [limit],
})
const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 1, totalTokens: 5 }
const freePrice = {
  kind: 'known', inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0,
  cacheWriteMicrosPerMillion: 0, ceilingMicros: 0,
} as const

function accepted<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`Expected budget fixture acceptance: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

function fixture(config: BudgetConfig = configured) {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-budget-'))
  let store: WorkStore | undefined
  let clock = at
  onTestFinished(() => {
    try { store?.close() } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  store = openWorkStore(directory)
  return {
    store,
    budget: store.createBudget({ ...config, now: () => clock }),
    advance(next: UtcInstant) { clock = next },
    reopen(next: BudgetConfig = config) {
      store?.close()
      store = undefined
      store = openWorkStore(directory)
      return store.createBudget({ ...next, now: () => clock })
    },
  }
}

function makeTask(store: WorkStore, id = 'task') {
  const project = projectSchema.parse({
    ...scope, id: `project-${id}`, kind: 'project', title: 'Budget scope',
    purpose: 'Verify scoped budget fencing.', resourceRefs: [], status: 'active',
    successCriteria: ['Stay in budget.'], planRevision: 1, milestones: [],
  })
  const actor = {
    ...scope, role: 'owner' as const, clientId: clientIdSchema.parse('fixture-client'),
    deviceId: deviceIdSchema.parse('fixture-device'), policyVersion: 'fixture-policy',
  }
  store.insertProject(project)
  const taskId = taskIdSchema.parse(`budget-${id}`)
  const ref = { ...scope, taskId }
  const { state } = accepted(store.applyCommand({
    type: 'work.create', commandId: `create-${id}`,
    payload: { projectId: project.id, requestedOutcome: 'Use scoped inference.', constraints: [],
      acceptance: { criteria: ['Read the result.'], requiresArtifact: false, requiresReceipt: false } },
  }, {
    actor, at, projectId: project.id, newTaskId: taskId,
    newAttempt: {
      id: attemptIdSchema.parse(`attempt-${id}`),
      mandate: mandateRefSchema.parse({ id: `mandate-${id}`, ...scope, policyVersion: actor.policyVersion }),
    },
  }))
  return { ref, state, actor, projectId: project.id }
}

function fence(state: ReturnType<typeof makeTask>['state']) {
  return { taskId: state.task.id, attemptId: state.attempt.id, generation: state.attempt.generation, expectedVersion: state.task.version }
}

describe('SQLite compute budget reservations', () => {
  it('atomically reserves a shared owner day limit across profile scopes and charges disjoint cached usage', async () => {
    const { budget } = fixture()
    const alternate = { ...scope, profileId: profileIdSchema.parse('alternate-profile') }
    const candidates = await Promise.all([
      Promise.resolve().then(() => budget.begin(request)),
      Promise.resolve().then(() => budget.begin({ ...request, ...alternate })),
      Promise.resolve().then(() => budget.begin(request)),
    ])
    const first = accepted(candidates[0]!).reservation
    const second = accepted(candidates[1]!).reservation
    expect(candidates[2]).toEqual({ ok: false, code: 'budget_exceeded' })
    expect(budget.get({ ...first, ...alternate })).toBeUndefined()
    expect(budget.settle(first, usage)).toBe(true)
    expect(budget.get(first)).toMatchObject({ status: 'settled', estimateMicros: 20, actualMicros: 13, usage })
    expect(budget.uncertain(second)).toBe(true)
    expect(budget.begin(request)).toEqual({ ok: false, code: 'budget_exceeded' })
    expect(budget.snapshot(scope)).toMatchObject({ day: '2026-11-07', dayBasis: 'utc', currencies: [{
      currency: 'USD', spentMicros: 13, heldMicros: 0, calls: 1, unknownCostCalls: 0, unknownUsageCalls: 0,
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 1, overflow: false,
    }] })
    expect(budget.snapshot(alternate).currencies).toMatchObject([{
      spentMicros: 0, uncertainMicros: 20, unknownUsageCalls: 1, calls: 1,
    }])
    expect(budget.reconcile(second, { inputTokens: 0, outputTokens: 0 })).toBe(true)
    expect(budget.reconcile(second, usage)).toBe(false)
    expect(budget.begin(request)).toMatchObject({ ok: true })
  })

  it('requires an exact configured route and a worst-case quote within its ceiling', () => {
    const { budget } = fixture()
    expect(budget.begin({ ...request, model: 'alias' })).toEqual({ ok: false, code: 'pricing_unavailable' })
    expect(budget.begin({ ...request, upperInputTokens: 4, upperOutputTokens: 2 }))
      .toEqual({ ok: false, code: 'budget_exceeded' })
    expect(budget.begin({ ...request, upperOutputTokens: -1 })).toEqual({ ok: false, code: 'invalid_input' })
    expect(budget.begin({ ...request, upperOutputTokens: 1.5 })).toEqual({ ok: false, code: 'invalid_input' })
    expect(budget.snapshot(scope).currencies).toEqual([])
    expect(budgetConfigSchema.safeParse({
      ...configured, routes: [{ ...route, currency: null, pricing: price }],
    }).success).toBe(false)
    expect(budgetConfigSchema.safeParse({
      ...configured, routes: [{ ...route, currency: 'USD', pricing: price }, { ...route, currency: 'USD', pricing: price }],
    }).success).toBe(false)
  })

  it('distinguishes unknown and zero cost, with bounded manual-only unknown admissions', () => {
    const config = budgetConfigSchema.parse({
      pricingVersion: 'fixture-zero-unknown',
      routes: [
        { provider: 'fixture', model: 'unknown', currency: null, pricing: { kind: 'unknown' } },
        { provider: 'fixture', model: 'free', currency: null, pricing: freePrice },
      ],
      limits: [{ ...limit, currency: null, ownerDayMicros: 0, taskMicros: 0, maxCallsPerDay: 2, maxConcurrent: 1 }],
    })
    const { budget } = fixture(config)
    const unknown = { ...request, model: 'unknown' }
    expect(budget.begin(unknown)).toEqual({ ok: false, code: 'pricing_unavailable' })
    const first = accepted(budget.begin({ ...unknown, unattended: false })).reservation
    expect(first.estimateMicros).toBeNull()
    expect(budget.begin({ ...request, model: 'free' })).toEqual({ ok: false, code: 'capacity' })
    expect(budget.settle(first, usage)).toBe(true)
    expect(budget.get(first)).toMatchObject({ actualMicros: null, status: 'settled', usage })
    const free = accepted(budget.begin({ ...request, model: 'free' })).reservation
    expect(free.estimateMicros).toBe(0)
    expect(budget.settle(free, { inputTokens: 0, outputTokens: 0 })).toBe(true)
    expect(budget.get(free)).toMatchObject({ actualMicros: 0, status: 'settled' })
    expect(budget.begin({ ...unknown, unattended: false })).toEqual({ ok: false, code: 'budget_exceeded' })
    expect(budget.snapshot(scope).currencies).toMatchObject([{
      currency: null, calls: 2, unknownCostCalls: 1, unknownUsageCalls: 0, spentMicros: 0,
    }])
  })

  it('keeps a cancelled generation from claiming a staged reservation and accounts for an already started call', () => {
    const { store, budget } = fixture({ ...configured, limits: [{ ...limit, ownerDayMicros: 60 }] })
    const task = makeTask(store)
    expect(budget.canBegin({ ...request, task: fence(task.state) })).toBe(true)
    expect(budget.begin({ ...request, task: fence(task.state) })).toEqual({ ok: false, code: 'stale_attempt' })
    const { taskId: _taskId, ...startFence } = fence(task.state)
    const running = accepted(store.applyEvent(task.ref, { type: 'start', ...startFence, at, executor: 'fixture' })).state
    expect(budget.begin({ ...request, profileId: profileIdSchema.parse('different-profile'), task: fence(running) }))
      .toEqual({ ok: false, code: 'stale_attempt' })
    const first = accepted(budget.begin({ ...request, task: fence(running) })).reservation
    const staged = accepted(budget.reserve({ ...request, task: fence(running) })).reservation
    expect(budget.canBegin({ ...request, task: fence(running) })).toBe(false)
    accepted(store.applyCommand({
      type: 'work.cancel', commandId: 'budget-cancel', taskId: task.ref.taskId,
      expectedVersion: running.task.version, payload: {},
    }, { actor: task.actor, at, projectId: task.projectId }))
    expect(budget.claim(staged)).toEqual({ ok: false, code: 'stale_attempt' })
    expect(budget.release(staged)).toBe(true)
    expect(budget.settle(first, usage)).toBe(true)
    expect(budget.get(first)).toMatchObject({ status: 'settled', actualMicros: 13 })
  })

  it('retains cold claims across UTC days and reconciles usage at the original stored price', () => {
    const setup = fixture()
    const started = accepted(setup.budget.begin(request)).reservation
    const staged = accepted(setup.budget.reserve(request)).reservation
    setup.advance(nextDay)
    const replacement = budgetConfigSchema.parse({
      ...configured, pricingVersion: 'fixture-price-2',
      routes: [{ ...route, currency: 'USD', pricing: { ...price, inputMicrosPerMillion: 4_000_000 } }],
    })
    const reopened = setup.reopen(replacement)
    expect(reopened.get(staged)?.status).toBe('released')
    expect(reopened.get(started)?.status).toBe('uncertain')
    expect(reopened.listUncertain(scope)).toMatchObject([{ id: started.id, pricingVersion: configured.pricingVersion }])
    expect(reopened.snapshot(scope)).toMatchObject({ day: '2026-11-08', currencies: [{
      currency: 'USD', calls: 0, spentMicros: 0, heldMicros: 0, olderHeldMicros: 20, olderUnresolvedCalls: 1,
    }] })
    accepted(reopened.begin(request))
    expect(reopened.begin(request)).toEqual({ ok: false, code: 'budget_exceeded' })
    expect(reopened.reconcile(started, { ...usage, totalTokens: 6 })).toBe(false)
    expect(reopened.reconcile(started, usage)).toBe(true)
    expect(reopened.get(started)).toMatchObject({ actualMicros: 13, pricingVersion: configured.pricingVersion })
    expect(reopened.listUncertain(scope)).toEqual([])
    expect(reopened.begin(request)).toMatchObject({ ok: true })
    setup.advance(at)
    expect(reopened.begin(request)).toEqual({ ok: false, code: 'budget_exceeded' })
  })

  it('rechecks staged reservations and supports a configuration without provider routes', () => {
    const setup = fixture()
    const staged = accepted(setup.budget.reserve(request)).reservation
    expect(setup.budget.claim(staged)).toMatchObject({ ok: true, reservation: { status: 'claimed' } })
    expect(setup.budget.claim(staged)).toEqual({ ok: false, code: 'invalid_transition' })
    expect(setup.budget.release(staged)).toBe(false)
    const readOnly = setup.reopen(budgetConfigSchema.parse({ pricingVersion: 'read-only', routes: [], limits: [] }))
    expect(readOnly.canBegin(request)).toBe(false)
    expect(readOnly.begin(request)).toEqual({ ok: false, code: 'pricing_unavailable' })
    expect(readOnly.snapshot(scope).currencies).toMatchObject([{ uncertainMicros: 20, uncertainCalls: 1 }])
  })

  it('keeps admission exact when actual reported usage exceeds a configured estimate and the display saturates', () => {
    const huge = { ...freePrice, inputMicrosPerMillion: Number.MAX_SAFE_INTEGER, ceilingMicros: 1 }
    const { budget } = fixture({
      ...configured,
      routes: [{ ...route, currency: 'USD', pricing: huge }],
    })
    const quoted = { ...request, upperInputTokens: 0, upperOutputTokens: 1 }
    const first = accepted(budget.begin(quoted)).reservation
    const second = accepted(budget.begin(quoted)).reservation
    for (const reservation of [first, second]) {
      expect(budget.settle(reservation, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(true)
      expect(budget.get(reservation)?.actualMicros).toBe(Number.MAX_SAFE_INTEGER)
    }
    expect(budget.snapshot(scope).currencies).toMatchObject([{
      spentMicros: Number.MAX_SAFE_INTEGER, heldMicros: 0, reservedMicros: 0, uncertainMicros: 0, overflow: true,
    }])
    expect(budget.begin(quoted)).toEqual({ ok: false, code: 'budget_exceeded' })
  })
})
