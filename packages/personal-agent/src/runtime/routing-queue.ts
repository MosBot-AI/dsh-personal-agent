import { performance } from 'node:perf_hooks'
import { z } from 'zod'

export interface RoutingQueueOptions<Item, Result> {
  /** Assess the batch asynchronously and return one result in each input position. */
  readonly assess: (batch: readonly Item[], signal: AbortSignal) => readonly Result[] | Promise<readonly Result[]>
  readonly maxOutstanding?: number
  readonly maxPerLane?: number
  readonly maxBatchSize?: number
  readonly deadlineMs?: number
}

type OutcomeError = 'deadline' | 'assessment_failed' | 'closed'
export type RoutingQueueOutcome<Result> = { ok: true; value: Result } | { ok: false; code: OutcomeError }
export type RoutingQueueAdmission<Result> = { ok: true; completion: Promise<RoutingQueueOutcome<Result>> }
  | { ok: false; code: 'queue_full' | 'lane_full' | 'closed' }

interface Ticket<Item, Result> {
  readonly lane: string
  readonly group?: string
  readonly item: Item
  resolve(outcome: RoutingQueueOutcome<Result>): void
}

interface Batch<Item, Result> {
  readonly tickets: readonly Ticket<Item, Result>[]
  readonly abort: AbortController
  readonly expires: number
  timer?: NodeJS.Timeout
  resolved: boolean
}

const capacity = z.int().min(1).max(4_096)
const laneCapacity = z.int().min(1).max(512)
const batchCapacity = z.int().min(1).max(128)
const timeBudget = z.int().min(1).max(120_000)

/** Keep semantic assessment off the foreground path, with one physical batch in flight. */
export function createRoutingQueue<Item, Result>(options: RoutingQueueOptions<Item, Result>) {
  const { assess } = options
  const maxOutstanding = capacity.parse(options.maxOutstanding ?? 64)
  const maxPerLane = laneCapacity.parse(options.maxPerLane ?? 8)
  const maxBatchSize = batchCapacity.parse(options.maxBatchSize ?? 8)
  const deadlineMs = timeBudget.parse(options.deadlineMs ?? 5_000)
  const lanes = new Map<string, Ticket<Item, Result>[]>()
  const outstanding = new Map<string, number>()
  let ready: string[] = []
  let queued = 0
  let running: Batch<Item, Result> | undefined
  let scheduled: NodeJS.Immediate | undefined
  let closed = false

  function release(lane: string): void {
    const count = outstanding.get(lane)!
    if (count === 1) outstanding.delete(lane)
    else outstanding.set(lane, count - 1)
  }

  function select(): Ticket<Item, Result>[] {
    const batch: Ticket<Item, Result>[] = []
    const skipped: string[] = []
    const served: string[] = []
    for (const lane of ready) {
      const tickets = lanes.get(lane)!
      const next = tickets[0]!
      if (batch.length >= maxBatchSize || (batch.length > 0 && next.group !== batch[0]!.group)) {
        skipped.push(lane)
        continue
      }
      tickets.shift()
      batch.push(next)
      if (tickets.length === 0) lanes.delete(lane)
      else served.push(lane)
    }
    ready = [...skipped, ...served]
    queued -= batch.length
    return batch
  }

  function rejectBatch(batch: Batch<Item, Result>, code: OutcomeError): void {
    if (batch.resolved) return
    batch.resolved = true
    for (const ticket of batch.tickets) ticket.resolve({ ok: false, code })
    batch.abort.abort()
  }

  function schedule(): void {
    if (closed || running || scheduled || queued === 0) return
    scheduled = setImmediate(() => {
      scheduled = undefined
      start()
    })
  }

  function start(): void {
    const batch: Batch<Item, Result> = {
      tickets: select(), abort: new AbortController(), expires: performance.now() + deadlineMs, resolved: false,
    }
    running = batch
    batch.timer = setTimeout(() => rejectBatch(batch, 'deadline'), deadlineMs)
    const items = Object.freeze(batch.tickets.map(ticket => ticket.item))
    void Promise.resolve().then(() => {
      if (batch.abort.signal.aborted) return undefined
      return assess(items, batch.abort.signal)
    }).then(results => {
      if (batch.resolved) return
      if (performance.now() >= batch.expires) return rejectBatch(batch, 'deadline')
      if (!Array.isArray(results) || results.length !== items.length || items.some((_, index) => !Object.hasOwn(results, index))) {
        return rejectBatch(batch, 'assessment_failed')
      }
      const values = [...results]
      if (performance.now() >= batch.expires) return rejectBatch(batch, 'deadline')
      batch.resolved = true
      batch.tickets.forEach((ticket, index) => ticket.resolve({ ok: true, value: values[index]! }))
    }).catch(() => {
      rejectBatch(batch, performance.now() >= batch.expires ? 'deadline' : 'assessment_failed')
    }).finally(() => {
      clearTimeout(batch.timer)
      // Abort may be ignored. Keep the physical slot and its queue capacity
      // until this invocation actually settles, even after its logical deadline.
      for (const ticket of batch.tickets) release(ticket.lane)
      running = undefined
      schedule()
    })
  }

  function enqueue(lane: string, item: Item, batchGroup?: string): RoutingQueueAdmission<Result> {
    if (closed) return { ok: false, code: 'closed' }
    if (queued + (running?.tickets.length ?? 0) >= maxOutstanding) return { ok: false, code: 'queue_full' }
    const count = outstanding.get(lane) ?? 0
    if (count >= maxPerLane) return { ok: false, code: 'lane_full' }

    const { promise: completion, resolve } = Promise.withResolvers<RoutingQueueOutcome<Result>>()
    const ticket = { lane, item, group: batchGroup, resolve }
    const pending = lanes.get(lane)
    if (pending) pending.push(ticket)
    else {
      lanes.set(lane, [ticket])
      ready.push(lane)
    }
    outstanding.set(lane, count + 1)
    queued++
    schedule()
    return { ok: true, completion }
  }

  function close(): void {
    if (closed) return
    closed = true
    clearImmediate(scheduled)
    scheduled = undefined
    for (const tickets of lanes.values()) {
      for (const ticket of tickets) {
        ticket.resolve({ ok: false, code: 'closed' })
        release(ticket.lane)
      }
    }
    lanes.clear()
    ready = []
    queued = 0
    if (running) {
      clearTimeout(running.timer)
      rejectBatch(running, 'closed')
    }
  }

  return Object.freeze({ enqueue, close, snapshot: () => ({ queued, inFlight: running?.tickets.length ?? 0, closed }) })
}
