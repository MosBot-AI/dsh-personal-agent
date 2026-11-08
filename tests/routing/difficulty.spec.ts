import { describe, expect, it, vi } from 'vitest'
import { estimateDifficulty } from '../../packages/model-routing/src/difficulty.js'
import { decideRouting, type RoutingPolicyCore, type SemanticEstimator } from '../../packages/model-routing/src/policy.js'
import type { DeploymentPin, RoutingDecision } from '../../packages/plugin-api/src/model-routing.js'

const fast = { id: 'fast', revision: 1 }
const balanced = { id: 'balanced', revision: 1 }
const deep = { id: 'deep', revision: 2 }
const alt = { id: 'alt', revision: 1 }
const at = '2026-11-08T02:00:00.000Z'
const signals = {
  kind: 'extract', phase: 'execute', dependencyCount: 0, sourceCount: 1, constraintCount: 1,
  scope: 'single', verification: 'direct', conflictingEvidence: false, multimodal: false, priority: 'balanced',
} as const
const semantic = { maxInputTokens: 1024, maxOutputTokens: 32, ceilingMicros: 100, currency: 'USD', timeoutMs: 250 }
const admission: RoutingPolicyCore = { inspect: () => 'ready' }
const auto = {
  id: 'policy', revision: 4, mode: 'automatic', pools: { fast: [fast], balanced: [balanced], deep: [deep, alt] },
  maxSwitches: 2,
}

function deployment(pin: DeploymentPin) {
  return {
    ...pin, provider: `route-${pin.id}`, model: 'native', accountId: `account-${pin.id}`, quotaBucketId: `quota-${pin.id}`,
    destination: { kind: 'local' }, capabilities: ['tools'], dataScope: ['task'], contextTokens: 8192, outputTokens: 1024,
    nativeEfforts: ['basic', 'balanced', 'deep'],
    effort: { low: { kind: 'provider', id: 'basic' }, medium: { kind: 'provider', id: 'balanced' },
      high: { kind: 'provider', id: 'deep' } },
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    id: 'decision-1', taskId: 'task', taskAttemptId: 'attempt', generation: 1, acceptanceDigest: 'a'.repeat(64),
    decidedAt: at, readiness: 'ready', requirements: { capabilities: [], dataScope: ['task'], inputTokens: 512, outputTokens: 128 },
    policy: auto, signals, deployments: [fast, balanced, deep, alt].map(deployment), ...overrides,
  }
}

async function decision(...args: Parameters<typeof decideRouting>): Promise<RoutingDecision> {
  const result = await decideRouting(...args)
  if (!result.ok) throw new Error(result.code)
  return result.decision
}

describe('difficulty-based routing decisions', () => {
  it('separates simple, standard and complex work using task shape and configured mappings', async () => {
    expect(estimateDifficulty(signals)).toMatchObject({ tier: 'simple', confidence: 1 })
    expect(await decision(input(), admission)).toMatchObject({ kind: 'dispatch', deployment: fast, effort: 'low', basis: 'rule' })
    expect(await decision(input({ signals: { ...signals, kind: 'edit' } }), admission))
      .toMatchObject({ kind: 'dispatch', deployment: balanced, effort: 'medium' })
    expect(await decision(input({ signals: { ...signals, kind: 'edit', scope: 'cross-module' } }), admission))
      .toMatchObject({ kind: 'dispatch', deployment: deep, effort: 'high' })
    expect(await decision(input({ policy: { ...auto, rules: { simple: { pool: 'balanced', effort: 'low' },
      standard: { pool: 'balanced', effort: 'medium' }, complex: { pool: 'deep', effort: 'high' } } } }), admission))
      .toMatchObject({ kind: 'dispatch', deployment: balanced, effort: 'low' })
  })

  it('filters capability, context, data scope, destination and budget before calling a classifier', async () => {
    const narrow = { id: 'small', revision: 1 }
    const undisclosed = { id: 'undisclosed', revision: 1 }
    const inspect = vi.fn<RoutingPolicyCore['inspect']>((_scope, model) => model.id === 'deep' ? 'destination' : 'budget')
    const estimate = vi.fn(async () => ({ tier: 'complex', confidence: 1 }))
    const classify = vi.fn()
    const result = await decision(input({
      requirements: { capabilities: ['tools'], dataScope: ['task'], inputTokens: 512, outputTokens: 128 },
      signals: { phase: 'execute', kind: 'unknown' }, policy: { ...auto, semantic,
        pools: { ...auto.pools, fast: [fast, narrow, undisclosed] } },
      deployments: [{ ...deployment(fast), capabilities: [] },
        { ...deployment(narrow), contextTokens: 256, outputTokens: 128 },
        { ...deployment(undisclosed), dataScope: [] }, deployment(balanced), deployment(deep), deployment(alt)],
    }), { inspect, classify }, { estimator: estimate })
    expect(result).toMatchObject({ kind: 'wait', reason: 'budget', excluded: expect.arrayContaining([
      { deployment: fast, reason: 'capability' }, { deployment: narrow, reason: 'context' },
      { deployment: undisclosed, reason: 'destination' }, { deployment: balanced, reason: 'budget' },
      { deployment: deep, reason: 'destination' },
    ]) })
    expect(inspect.mock.calls.map(([, model]) => model.id)).toEqual(['balanced', 'deep', 'alt'])
    expect(estimate).not.toHaveBeenCalled()
    expect(classify).not.toHaveBeenCalled()
  })

  it('requires valid effort mappings and never silently changes an explicit override', async () => {
    const missing = { ...deployment(fast), effort: {} }
    const deployments = [missing, deployment(balanced), deployment(deep), deployment(alt)]
    expect(await decision(input({ deployments }), admission)).toMatchObject({ kind: 'wait', excluded: [{ deployment: fast, reason: 'effort' }] })
    expect(await decision(input({ deployments, policy: { ...auto, unsupportedEffort: 'omit' } }), admission))
      .toMatchObject({ kind: 'dispatch', deployment: fast, effort: undefined })
    const thinking = { ...deployment(fast), effort: { low: { kind: 'thinking-budget', tokens: 128 } } }
    expect(await decision(input({ deployments: [thinking, ...deployments.slice(1)] }), admission)).toMatchObject({
      kind: 'wait', excluded: [{ deployment: fast, reason: 'effort' }],
    })
    expect(await decision(input({ override: { deployment: deep, effort: 'high' } }), admission)).toMatchObject({ kind: 'wait', reason: 'permission' })
    const owner = { ...admission, authorizeOverride: () => true }
    expect(await decision(input({ override: { deployment: deep, effort: 'high' } }), owner))
      .toMatchObject({ kind: 'dispatch', deployment: deep, effort: 'high', basis: 'override' })
    expect(await decision(input({ deployments, override: { deployment: fast, effort: 'low' },
      policy: { ...auto, unsupportedEffort: 'omit' } }), owner)).toMatchObject({ kind: 'wait', excluded: [{ deployment: fast, reason: 'effort' }] })
  })

  it('keeps fixed mode on its pinned deployment and respects authority and resource waits', async () => {
    const fixed = { id: auto.id, revision: auto.revision, mode: 'fixed', deployment: fast, effort: 'low' }
    const override = { deployment: deep, effort: 'high' }
    expect(await decision(input({ policy: fixed, signals: { ...signals, conflictingEvidence: true } }), admission))
      .toMatchObject({ kind: 'dispatch', deployment: fast, effort: 'low', basis: 'fixed' })
    expect(await decision(input({ policy: fixed, override }), { ...admission, authorizeOverride: () => true }))
      .toMatchObject({ kind: 'wait', reason: 'permission' })
    expect(await decision(input({ policy: fixed }), { inspect: () => 'budget' }))
      .toMatchObject({ kind: 'wait', reason: 'budget' })
    const inspect = vi.fn<RoutingPolicyCore['inspect']>(() => 'ready')
    for (const readiness of ['missing-input', 'permission']) {
      expect(await decision(input({ readiness, policy: { ...auto, semantic } }), { inspect }))
        .toMatchObject({ kind: 'wait', reason: readiness })
    }
    expect(inspect).not.toHaveBeenCalled()
  })

  it('requires trustworthy quality evidence, keeps criteria stable, and bounds escalation', async () => {
    const first = await decision(input(), admission)
    expect(await decision(input({ id: 'decision-2', request: 'escalation' }), {
      ...admission, quality: () => ({ result: 'quality', switches: 0, decision: first }),
    })).toMatchObject({ kind: 'dispatch', deployment: balanced, effort: 'medium', basis: 'escalation',
      acceptanceDigest: 'a'.repeat(64), requirements: first.requirements })
    expect(await decision(input({ id: 'decision-2', request: 'escalation', acceptanceDigest: 'b'.repeat(64) }), {
      ...admission, quality: () => ({ result: 'quality', switches: 0, decision: first }),
    })).toMatchObject({ kind: 'wait', reason: 'policy' })
    expect(await decision(input({ id: 'decision-2', request: 'escalation' }), {
      ...admission, quality: () => ({ result: 'quality', switches: 2, decision: first }),
    })).toMatchObject({ kind: 'wait', reason: 'policy' })
    const inspect = vi.fn<RoutingPolicyCore['inspect']>(() => 'ready')
    expect(await decision(input({ id: 'decision-2', request: 'escalation' }), {
      inspect, quality: () => ({ result: 'missing-input', switches: 0, decision: first }),
    })).toMatchObject({ kind: 'wait', reason: 'missing-input' })
    expect(inspect).not.toHaveBeenCalled()
    expect(await decision(input({ id: 'decision-2', request: 'escalation' }), admission)).toMatchObject({ kind: 'wait', reason: 'policy' })
  })

  it('counts a same-deployment escalation only when the provider effort increases', async () => {
    const policy = { ...auto, pools: { ...auto.pools, balanced: [fast] } }
    const first = await decision(input({ policy }), admission)
    const core: RoutingPolicyCore = { ...admission, quality: () => ({ decision: first, switches: 0, result: 'quality' }) }
    const retry = input({ id: 'escalated', request: 'escalation', policy })
    expect(await decision(retry, core)).toMatchObject({ kind: 'dispatch', deployment: fast, effort: 'medium', basis: 'escalation' })
    const model = deployment(fast)
    const same = { ...model, effort: { ...model.effort, medium: model.effort.low } }
    expect(await decision({ ...retry, deployments: [same, deployment(deep), deployment(alt)] }, core))
      .toMatchObject({ kind: 'wait', reason: 'policy' })
  })

  it('uses one separately admitted semantic call per phase and keeps a conservative deterministic default', async () => {
    const request = input({ signals: { kind: 'unknown', phase: 'execute' }, policy: { ...auto, semantic } })
    expect(await decision(request, admission)).toMatchObject({ kind: 'dispatch', deployment: balanced,
      difficulty: { tier: 'standard', basis: 'conservative' } })
    const estimate = vi.fn<SemanticEstimator>(async () => ({ tier: 'complex', confidence: 0.92 }))
    const used = new Set<string>()
    const classify = vi.fn<NonNullable<RoutingPolicyCore['classify']>>(async (_scope, key, budget, run) => {
      expect(budget).toEqual(semantic)
      if (used.has(key)) return undefined
      used.add(key)
      const result = await run()
      await expect(run()).rejects.toThrow('Semantic admission')
      return result
    })
    const core = { ...admission, classify }
    expect(await decision(request, core, { estimator: estimate })).toMatchObject({ kind: 'dispatch', deployment: deep,
      difficulty: { tier: 'complex', basis: 'semantic' } })
    expect(await decision({ ...request, id: 'second-decision' }, core, { estimator: estimate }))
      .toMatchObject({ kind: 'dispatch', deployment: balanced, difficulty: { basis: 'conservative' } })
    expect(estimate).toHaveBeenCalledTimes(1)
    expect(estimate.mock.calls[0]?.[0]).toEqual({ kind: 'unknown', phase: 'execute' })
    expect(classify.mock.calls[0]?.[1]).toBe(classify.mock.calls[1]?.[1])
  })

  it('drops a timed-out estimate and rechecks live admission after semantic work', async () => {
    const request = input({ signals: { kind: 'unknown', phase: 'execute' },
      policy: { ...auto, semantic: { ...semantic, timeoutMs: 10 } } })
    const core = { ...admission, classify: async (_fence: unknown, _key: string, _budget: unknown, run: () => Promise<unknown>) => run() }
    const estimate = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 40))
      return { tier: 'complex', confidence: 1 }
    })
    expect(await decision(request, core, { estimator: estimate })).toMatchObject({ deployment: balanced,
      difficulty: { basis: 'conservative' } })
    let authorized = true
    const recheck: RoutingPolicyCore = {
      ...core, inspect: () => authorized ? 'ready' : 'destination',
    }
    expect(await decision(request, recheck, { estimator: async () => {
      authorized = false
      return { tier: 'complex', confidence: 1 }
    } })).toMatchObject({ kind: 'wait', reason: 'permission' })
  })
})
