import { describe, expect, it, vi } from 'vitest'
import { attemptIdSchema, ownerIdSchema, profileIdSchema, taskIdSchema } from '../../packages/personal-agent/src/domain/model.js'
import { workStateSchema } from '../../packages/personal-agent/src/domain/transitions.js'
import { createHealth } from '../../packages/personal-agent/src/runtime/health.js'
import { createWatchdog, type WatchdogWorker } from '../../packages/personal-agent/src/runtime/watchdog.js'
import type { RecoveryMode } from '../../packages/personal-agent/src/storage/recovery-state.js'

const origin = '2026-11-07T08:00:00.000Z'
const day = 86_400_000
const scope = { ownerId: ownerIdSchema.parse('owner-one'), profileId: profileIdSchema.parse('profile-one') }
const otherScope = { ...scope, profileId: profileIdSchema.parse('profile-two') }
const ref = { ...scope, taskId: taskIdSchema.parse('fixture-task') }
const first = attemptIdSchema.parse('attempt-1')
const second = attemptIdSchema.parse('attempt-2')

function state(attemptId = first, generation = 1, workRef = ref) {
  const { taskId, ...owner } = workRef
  return workStateSchema.parse({
    task: { ...owner, id: taskId, projectId: 'project',
      requestedOutcome: 'private fixture prompt', constraints: ['private constraints'],
      acceptance: { criteria: ['private acceptance'], requiresArtifact: false, requiresReceipt: false },
      provenance: { sourceEventIds: [] }, version: generation, generation, status: 'running', attemptId, createdAt: origin, updatedAt: origin },
    attempt: { id: attemptId, taskId: workRef.taskId, generation, status: 'running',
      mandate: { ownerId: workRef.ownerId, profileId: workRef.profileId, id: 'mandate', policyVersion: '1' },
      artifactIds: [], startedAt: origin, executor: 'private provider' },
  })
}

function testClock() {
  let wall = Date.parse(origin)
  let mono = 0
  return { wallNow: () => wall, monotonicNow: () => mono, advance(wallMs: number, monoMs = wallMs) {
    wall += wallMs
    mono += monoMs
  } }
}

describe('resident health', () => {
  it('keeps process liveness and readiness distinct from degradation and restore', () => {
    let mode: RecoveryMode | undefined = 'normal'
    let warm = false
    const health = createHealth({ readRecoveryMode() {
      if (!mode) throw new Error('private database path')
      return mode
    }, readWatchdog: () => ({ reconciling: warm, degraded: [{ code: 'provider_unavailable', count: 1 }] }) })

    expect(health.liveness()).toEqual({ live: true })
    expect(health.readiness()).toEqual({ ready: false, phase: 'starting' })
    health.beginReconciliation()
    expect(health.readiness()).toEqual({ ready: false, phase: 'reconciling' })
    health.markStarted()
    expect(health.snapshot()).toEqual({ live: true, ready: true, phase: 'ready', degraded: [{ code: 'provider_unavailable', count: 1 }] })
    expect(health.readiness()).toEqual({ ready: true, phase: 'ready' })
    warm = true
    expect(health.readiness()).toEqual({ ready: false, phase: 'reconciling' })
    warm = false
    mode = 'restore'
    expect(health.snapshot()).toMatchObject({ ready: false, phase: 'reconciling', degraded: expect.arrayContaining([{ code: 'restore_only', count: 1 }]) })
    mode = undefined
    expect(health.snapshot()).toMatchObject({ live: true, ready: false, degraded: expect.arrayContaining([{ code: 'storage_unavailable', count: 1 }]) })
    expect(JSON.stringify(health.snapshot())).not.toContain('private database path')
    health.stop()
    health.markStarted()
    expect(health.liveness()).toEqual({ live: true })
    expect(health.readiness()).toEqual({ ready: false, phase: 'stopping' })
  })

  it('projects readiness without reading Worker details when the warm-state seam is available', () => {
    let warm = false
    const readWatchdog = vi.fn(() => ({ reconciling: warm, degraded: [] }))
    const health = createHealth({ readRecoveryMode: () => 'normal', readWarmReconciliation: () => warm, readWatchdog })
    health.markStarted()
    expect(health.readiness()).toEqual({ ready: true, phase: 'ready' })
    warm = true
    expect(health.readiness()).toEqual({ ready: false, phase: 'reconciling' })
    expect(readWatchdog).not.toHaveBeenCalled()
    expect(health.snapshot()).toMatchObject({ ready: false, phase: 'reconciling' })
    expect(readWatchdog).toHaveBeenCalledOnce()
  })
})

describe('diagnostic watchdog', () => {
  it('detects stale progress and bounded repeated calls only for the current exact Worker', async () => {
    const clock = testClock()
    let current: WatchdogWorker = { attemptId: first, generation: 1, status: 'running', active: true }
    const watch = createWatchdog({ ...clock, readWorker: () => current,
      config: { tickMs: 100, heartbeatGapMs: 1_000, staleProgressMs: 200, repeatedToolCalls: 3, repeatWindowMs: 300 } })
    const input = state()
    const digest = 'f'.repeat(64)
    watch.observe(ref, input, { kind: 'start' })
    watch.observe(ref, input, { kind: 'tool', digest: 'private tool arguments' })
    for (let n = 0; n < 3; n++) watch.observe(ref, input, { kind: 'tool', digest })
    clock.advance(200)
    await watch.tick()
    expect(watch.snapshot()).toEqual({ reconciling: false, degraded: [
      { code: 'repeated_tool_call', count: 1 }, { code: 'stale_progress', count: 1 },
    ] })
    expect(watch.diagnostics(otherScope)).toEqual([])
    expect(watch.diagnostics(scope)).toEqual([
      { code: 'stale_progress', at: '2026-11-07T08:00:00.200Z', taskId: ref.taskId, attemptId: first, generation: 1 },
      { code: 'repeated_tool_call', at: origin, taskId: ref.taskId, attemptId: first, generation: 1 },
    ])
    expect(JSON.stringify(watch.diagnostics(scope))).not.toMatch(/private|f{64}/)
    clock.advance(100)
    await watch.tick()
    expect(watch.snapshot().degraded).toEqual([{ code: 'stale_progress', count: 1 }])
    watch.observe(ref, input, { kind: 'progress' })
    expect(watch.snapshot().degraded).toEqual([])

    current = { ...current, status: 'cancelled', active: false }
    watch.observe(ref, input, { kind: 'issue', code: 'budget_exceeded' })
    await watch.tick()
    expect(watch.snapshot().degraded).toEqual([])
    expect(watch.diagnostics(scope)).toHaveLength(2)
    current = { attemptId: second, generation: 2, status: 'running', active: true }
    watch.observe(ref, input, { kind: 'issue', code: 'provider_unavailable' })
    watch.observe(ref, state(second, 2), { kind: 'step' })
    clock.advance(200)
    await watch.tick()
    expect(watch.diagnostics(scope)[0]).toMatchObject({ code: 'stale_progress', attemptId: second, generation: 2 })
    expect(watch.diagnostics(scope)).toHaveLength(3)
    await watch.stop()
  })

  it('distinguishes budget and provider waits while discarding unknown and private issue data', async () => {
    const clock = testClock()
    let current: WatchdogWorker = { attemptId: first, generation: 1, status: 'running', active: true }
    const watch = createWatchdog({ ...clock, readWorker: () => current, config: { maxDiagnostics: 3 } })
    const input = state()
    const signal = { kind: 'issue', code: 'budget_exceeded', prompt: 'private model payload' } as const
    watch.observe(ref, input, signal)
    watch.observe(ref, input, signal)
    current = { ...current, status: 'waiting_resource', active: false }
    expect(watch.snapshot().degraded).toEqual([{ code: 'budget_exhausted', count: 1 }])
    watch.observe(ref, input, { kind: 'issue', code: 'private provider error with token' })
    expect(watch.diagnostics(scope)).toHaveLength(1)
    for (const code of ['provider_rate_limited', 'provider_unavailable', 'provider_authentication']) {
      watch.observe(ref, input, { kind: 'issue', code })
    }
    expect(watch.snapshot().degraded).toEqual([{ code: 'provider_authentication', count: 1 }])
    expect(watch.diagnostics(scope).map(item => item.code)).toEqual(['provider_authentication', 'provider_unavailable', 'provider_rate_limited'])
    expect(watch.diagnostics(scope, 1)).toHaveLength(1)
    expect(JSON.stringify(watch.diagnostics(scope))).not.toContain('private')
    current = { ...current, status: 'running', active: true }
    watch.observe(ref, input, { kind: 'step' })
    expect(watch.snapshot().degraded).toEqual([])
    clock.advance(-day, 14 * day)
    expect(watch.diagnostics(scope)).toEqual([])
    await watch.stop()
  })

  it('detects a suspended monotonic clock and coalesces warm reconciliation without cold recovery', async () => {
    const clock = testClock()
    const pending = Promise.withResolvers<void>()
    const reconcileWarm = vi.fn(() => pending.promise)
    const watch = createWatchdog({ ...clock, readWorker: () => ({ attemptId: first, generation: 1, status: 'running', active: true }),
      reconcileWarm, config: { tickMs: 100, heartbeatGapMs: 1_000, staleProgressMs: 200 } })
    watch.observe(ref, state(), { kind: 'step' })
    clock.advance(5_000, 10)
    const firstTick = watch.tick()
    await Promise.resolve()
    expect(watch.snapshot()).toEqual({ reconciling: true, degraded: [{ code: 'heartbeat_gap', count: 1 }] })
    clock.advance(5_000, 10)
    const secondTick = watch.tick()
    expect(secondTick).toBe(firstTick)
    expect(reconcileWarm).toHaveBeenCalledOnce()
    pending.resolve()
    await Promise.all([firstTick, secondTick])
    clock.advance(100, 10)
    await watch.tick()
    expect(watch.snapshot()).toEqual({ reconciling: false, degraded: [] })
    expect(watch.diagnostics(scope).map(item => item.code)).toEqual(['heartbeat_gap', 'heartbeat_gap'])
    await watch.stop()
  })

  it('bounds a warm callback and does not overlap an uncooperative callback even after timeout', async () => {
    vi.useFakeTimers()
    try {
      const clock = testClock()
      const pending = Promise.withResolvers<void>()
      let signal: AbortSignal | undefined
      const reconcileWarm = vi.fn((nextSignal: AbortSignal) => { signal = nextSignal; return pending.promise })
      const watch = createWatchdog({ ...clock, readWorker: () => undefined, reconcileWarm,
        config: { tickMs: 100, heartbeatGapMs: 1_000, warmTimeoutMs: 100 } })
      clock.advance(5_000)
      const warming = watch.tick()
      await vi.advanceTimersByTimeAsync(100)
      await warming
      expect(signal?.aborted).toBe(true)
      expect(watch.snapshot()).toMatchObject({ reconciling: false,
        degraded: expect.arrayContaining([{ code: 'warm_reconcile_failed', count: 1 }]) })
      clock.advance(5_000)
      await watch.tick()
      expect(reconcileWarm).toHaveBeenCalledOnce()
      expect(watch.diagnostics(scope).filter(item => item.code === 'warm_reconcile_failed')).toHaveLength(1)
      await watch.stop()
      pending.resolve()
      clock.advance(5_000)
      await watch.tick()
      expect(reconcileWarm).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts ongoing warm work during stop and discards later Worker observations', async () => {
    const clock = testClock()
    const pending = Promise.withResolvers<void>()
    const reconcileWarm = vi.fn((_signal: AbortSignal) => pending.promise)
    const watch = createWatchdog({ ...clock, reconcileWarm,
      readWorker: () => ({ attemptId: first, generation: 1, status: 'running', active: true }),
      config: { tickMs: 100, heartbeatGapMs: 1_000 } })
    clock.advance(5_000, 10)
    const tick = watch.tick()
    await Promise.resolve()
    await watch.stop()
    await tick
    expect(reconcileWarm.mock.calls[0]?.[0].aborted).toBe(true)
    watch.observe(ref, state(), { kind: 'issue', code: 'budget_exceeded' })
    expect(watch.snapshot()).toEqual({ reconciling: false, degraded: [] })
    expect(watch.diagnostics(scope).map(item => item.code)).toEqual(['heartbeat_gap'])
    pending.resolve()
  })
})
