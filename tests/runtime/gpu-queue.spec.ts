import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { attemptIdSchema, ownerIdSchema, profileIdSchema, taskIdSchema } from '../../packages/personal-agent/src/domain/model.js'
import { createGpuQueue, type GpuScope } from '../../packages/personal-agent/src/runtime/gpu-queue.js'

function scope(id: string, owner = 'owner'): GpuScope {
  return { ownerId: ownerIdSchema.parse(owner), profileId: profileIdSchema.parse('profile'), taskId: taskIdSchema.parse(id),
    attemptId: attemptIdSchema.parse(`attempt-${id}`), generation: 1 }
}

function accepted<T>(result: { ok: true; completion: Promise<T> } | { ok: false; code: string }): Promise<T> {
  if (!result.ok) throw new Error(`Expected a GPU slot, received ${result.code}`)
  return result.completion
}

it('bounds a GPU queue, preserves FIFO, and retains a cancelled physical slot until teardown', async () => {
  const revoked = new Set<string>()
  const queue = createGpuQueue({ maxQueued: 2 }, ref => !revoked.has(ref.taskId))
  const held = Promise.withResolvers<string>()
  const entered = Promise.withResolvers<AbortSignal>()
  const first = scope('first')
  const second = scope('second')
  const third = scope('third')
  const started: string[] = []
  const allow = () => true
  try {
    const active = accepted(queue.enqueue(first, allow, async signal => {
      started.push('first')
      entered.resolve(signal)
      return held.promise
    }))
    const signal = await entered.promise
    const waiting = accepted(queue.enqueue(second, allow, async () => {
      started.push('second')
      return 'second'
    }))
    const revokedWhileQueued = accepted(queue.enqueue(third, allow, async () => {
      started.push('third')
      return 'third'
    }))
    expect(queue.enqueue(second, allow, async () => 'duplicate')).toEqual({ ok: false, code: 'already_active' })
    expect(queue.enqueue(scope('overflow'), allow, async () => 'overflow')).toEqual({ ok: false, code: 'capacity' })
    expect(queue.snapshot(scope('hidden', 'different-owner'))).toEqual({ active: 0, queued: 0, limit: 1 })
    revoked.add(first.taskId)
    queue.cancelStale(first)
    expect(await active).toEqual({ ok: false, code: 'cancelled' })
    expect(signal.aborted).toBe(true)
    expect(queue.snapshot(first)).toEqual({ active: 1, queued: 2, limit: 1 })
    expect(started).toEqual(['first'])
    revoked.add(third.taskId)
    held.resolve('discarded')
    expect(await waiting).toEqual({ ok: true, value: 'second' })
    expect(await revokedWhileQueued).toEqual({ ok: false, code: 'permission_denied' })
    expect(started).toEqual(['first', 'second'])
  } finally {
    held.resolve('cleanup')
    expect(await queue.close()).toBe(true)
  }
})

it('aborts at the GPU deadline and drains physical work before confirming shutdown', async () => {
  const held = Promise.withResolvers<number>()
  const entered = Promise.withResolvers<AbortSignal>()
  const queue = createGpuQueue({ timeoutMs: 10 }, () => true)
  const active = accepted(queue.enqueue(scope('long'), () => true, async signal => {
    entered.resolve(signal)
    return held.promise
  }))
  const signal = await entered.promise
  expect(await active).toEqual({ ok: false, code: 'deadline' })
  expect(signal.aborted).toBe(true)
  const closed = queue.close()
  expect(queue.enqueue(scope('late'), () => true, async () => 1)).toEqual({ ok: false, code: 'closed' })
  await nextTurn()
  expect(queue.snapshot(scope('long')).active).toBe(1)
  held.resolve(2)
  expect(await closed).toBe(true)
  expect(queue.snapshot(scope('long')).active).toBe(0)
})
