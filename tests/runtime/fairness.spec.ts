import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  createRoutingQueue, type RoutingQueueAdmission, type RoutingQueueOutcome,
} from '../../packages/personal-agent/src/runtime/routing-queue.js'

function accepted<T>(result: RoutingQueueAdmission<T>): Promise<RoutingQueueOutcome<T>> {
  if (!result.ok) throw new Error(`Expected a routing queue slot, received ${result.code}`)
  return result.completion
}

describe('bounded semantic assessment scheduling', () => {
  it('rotates ready lanes, preserves their FIFO, and keeps each batch within one group', async () => {
    const batches: string[][] = []
    const queue = createRoutingQueue<string, string>({
      maxBatchSize: 2,
      async assess(items) {
        batches.push([...items])
        return items.map(item => `assessed:${item}`)
      },
    })
    const requests = [
      ['a', 'a1', 'first'], ['a', 'a2', 'first'], ['b', 'b1', 'second'], ['b', 'b2', 'second'],
      ['c', 'c1', 'first'], ['c', 'c2', 'first'], ['d', 'd1', 'second'], ['e', 'e1', 'first'],
    ] as const
    try {
      const completions = requests.map(([lane, item, group]) => accepted(queue.enqueue(lane, item, group)))
      expect(queue.snapshot()).toEqual({ queued: 8, inFlight: 0, closed: false })
      expect(batches).toEqual([])
      expect(await Promise.all(completions)).toEqual(requests.map(([, item]) => ({ ok: true, value: `assessed:${item}` })))
      expect(batches).toEqual([['a1', 'c1'], ['b1', 'd1'], ['e1', 'a2'], ['c2'], ['b2']])
      await nextTurn()
      expect(queue.snapshot()).toEqual({ queued: 0, inFlight: 0, closed: false })
    } finally {
      queue.close()
    }
  })

  it('bounds accepted work across waiting and physically in-flight items after a deadline', async () => {
    const held = Promise.withResolvers<readonly string[]>()
    const entered = Promise.withResolvers<AbortSignal>()
    const batches: string[][] = []
    const queue = createRoutingQueue<string, string>({
      maxOutstanding: 2, maxPerLane: 1, maxBatchSize: 1, deadlineMs: 120,
      async assess(items, signal) {
        batches.push([...items])
        if (items[0] === 'held') {
          entered.resolve(signal)
          return held.promise
        }
        return ['next result']
      },
    })
    try {
      const first = accepted(queue.enqueue('hot', 'held'))
      const signal = await entered.promise
      expect(queue.enqueue('hot', 'cannot overtake')).toEqual({ ok: false, code: 'lane_full' })
      const next = accepted(queue.enqueue('quiet', 'next'))
      expect(queue.enqueue('another', 'full')).toEqual({ ok: false, code: 'queue_full' })
      expect(await first).toEqual({ ok: false, code: 'deadline' })
      expect(signal.aborted).toBe(true)
      await nextTurn()
      expect(queue.snapshot()).toEqual({ queued: 1, inFlight: 1, closed: false })
      expect(batches).toEqual([['held']])
      expect(queue.enqueue('another', 'still full')).toEqual({ ok: false, code: 'queue_full' })
      held.resolve(['late result'])
      expect(await next).toEqual({ ok: true, value: 'next result' })
      expect(batches).toEqual([['held'], ['next']])
    } finally {
      queue.close()
      held.resolve(['discarded'])
    }
  })

  it('closes without waiting for a stalled assessor and discards queued or late results', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const held = Promise.withResolvers<readonly string[]>()
    let calls = 0
    const queue = createRoutingQueue<string, string>({
      maxBatchSize: 1,
      async assess(_items, signal) {
        calls++
        entered.resolve(signal)
        return held.promise
      },
    })
    try {
      const active = accepted(queue.enqueue('first', 'active'))
      const waiting = accepted(queue.enqueue('second', 'waiting'))
      const signal = await entered.promise
      queue.close()
      queue.close()
      expect(signal.aborted).toBe(true)
      expect(await Promise.all([active, waiting])).toEqual([{ ok: false, code: 'closed' }, { ok: false, code: 'closed' }])
      expect(queue.enqueue('third', 'refused')).toEqual({ ok: false, code: 'closed' })
      expect(queue.snapshot()).toEqual({ queued: 0, inFlight: 1, closed: true })
      held.resolve(['late'])
      await nextTurn()
      expect(queue.snapshot()).toEqual({ queued: 0, inFlight: 0, closed: true })
      expect(calls).toBe(1)
    } finally {
      queue.close()
      held.resolve(['discarded'])
    }
  })

  it('rejects an incomplete batch and continues serving another lane', async () => {
    const queue = createRoutingQueue<string, string>({
      maxBatchSize: 1,
      assess: items => items[0] === 'missing' ? [] : ['valid result'],
    })
    try {
      const invalid = accepted(queue.enqueue('first', 'missing'))
      const valid = accepted(queue.enqueue('second', 'present'))
      expect(await invalid).toEqual({ ok: false, code: 'assessment_failed' })
      expect(await valid).toEqual({ ok: true, value: 'valid result' })
    } finally {
      queue.close()
    }
  })
})
