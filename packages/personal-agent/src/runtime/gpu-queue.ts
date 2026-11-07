import { z } from 'zod'
import { attemptIdSchema, generationSchema, ownerIdSchema, profileIdSchema, taskIdSchema } from '../domain/model.js'

const scopeSchema = z.strictObject({
  ownerId: ownerIdSchema, profileId: profileIdSchema, taskId: taskIdSchema,
  attemptId: attemptIdSchema, generation: generationSchema,
})
export type GpuScope = z.infer<typeof scopeSchema>
export const gpuConfigSchema = z.strictObject({
  concurrency: z.int().min(1).max(8).default(1),
  maxQueued: z.int().min(1).max(256).default(32),
  timeoutMs: z.int().min(1).max(86_400_000).default(900_000),
})

type Rejected = { ok: false; code: 'closed' | 'capacity' | 'already_active' | 'permission_denied' | 'cancelled' }
type Outcome<T> = { ok: true; value: T } | { ok: false; code: 'cancelled' | 'deadline' | 'resource_failed' | 'permission_denied' }
type Admission<T> = Rejected | { ok: true; completion: Promise<Outcome<T>> }

interface Job {
  readonly key: string
  readonly scope: GpuScope
  start(): Promise<void>
  cancel(): void
}

/** Serialize scoped, already authorized heavy work without occupying a foreground Worker slot. */
export function createGpuQueue(rawConfig: unknown, current: (scope: GpuScope) => boolean) {
  const config = gpuConfigSchema.parse(rawConfig)
  const pending: Job[] = []
  const active = new Map<string, { job: Job; done: Promise<void> }>()
  let closed = false
  let scheduled: NodeJS.Immediate | undefined

  function permitted(scope: GpuScope, authorize: () => boolean): boolean {
    try {
      return current(scope) && authorize() === true
    } catch {
      return false
    }
  }

  function schedule() {
    if (closed || scheduled || pending.length === 0 || active.size >= config.concurrency) return
    scheduled = setImmediate(() => {
      scheduled = undefined
      while (!closed && pending.length > 0 && active.size < config.concurrency) {
        const job = pending.shift()!
        const done = Promise.resolve().then(() => job.start()).finally(() => {
          active.delete(job.key)
          schedule()
        })
        active.set(job.key, { job, done })
      }
    })
  }

  function enqueue<T>(
    scope: GpuScope,
    authorize: () => boolean,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Admission<T> {
    if (closed) return { ok: false, code: 'closed' }
    if (signal?.aborted) return { ok: false, code: 'cancelled' }
    const parsed = scopeSchema.safeParse(scope)
    if (!parsed.success || !permitted(parsed.data, authorize)) return { ok: false, code: 'permission_denied' }
    const key = JSON.stringify([scope.ownerId, scope.profileId, scope.taskId])
    if (active.has(key) || pending.some(job => job.key === key)) return { ok: false, code: 'already_active' }
    if (pending.length >= config.maxQueued) return { ok: false, code: 'capacity' }

    const abort = new AbortController()
    const { promise: completion, resolve } = Promise.withResolvers<Outcome<T>>()
    let settled = false
    const finish = (result: Outcome<T>) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', job.cancel)
      resolve(result)
    }
    const job: Job = {
      key, scope: parsed.data,
      async start() {
        if (settled) return
        if (!permitted(parsed.data, authorize)) return finish({ ok: false, code: 'permission_denied' })
        const timer = setTimeout(() => {
          finish({ ok: false, code: 'deadline' })
          abort.abort()
        }, config.timeoutMs)
        try {
          // The slot belongs to the physical operation until it settles, even after abort.
          const value = await operation(abort.signal)
          finish(permitted(parsed.data, authorize) ? { ok: true, value } : { ok: false, code: 'permission_denied' })
        } catch {
          finish({ ok: false, code: 'resource_failed' })
        } finally {
          clearTimeout(timer)
        }
      },
      cancel() {
        const index = pending.indexOf(job)
        if (index >= 0) pending.splice(index, 1)
        finish({ ok: false, code: 'cancelled' })
        abort.abort()
      },
    }
    pending.push(job)
    signal?.addEventListener('abort', job.cancel, { once: true })
    if (signal?.aborted) job.cancel()
    schedule()
    return { ok: true, completion }
  }

  return Object.freeze({
    enqueue,
    snapshot(scope: Pick<GpuScope, 'ownerId' | 'profileId'>) {
      const matches = (job: Job) => job.scope.ownerId === scope.ownerId && job.scope.profileId === scope.profileId
      return { active: [...active.values()].filter(entry => matches(entry.job)).length,
        queued: pending.filter(matches).length, limit: config.concurrency }
    },
    cancelStale(ref: Pick<GpuScope, 'ownerId' | 'profileId' | 'taskId'>) {
      for (const job of [...pending, ...[...active.values()].map(entry => entry.job)]) {
        const scope = job.scope
        if (scope.ownerId === ref.ownerId && scope.profileId === ref.profileId && scope.taskId === ref.taskId
          && !permitted(scope, () => true)) job.cancel()
      }
    },
    async close() {
      if (!closed) {
        closed = true
        clearImmediate(scheduled)
        scheduled = undefined
        for (const job of [...pending, ...[...active.values()].map(entry => entry.job)]) job.cancel()
      }
      if (active.size === 0) return true
      let timer: NodeJS.Timeout | undefined
      try {
        const released = Promise.all([...active.values()].map(entry => entry.done)).then(() => true)
        const expired = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 10_000) })
        return await Promise.race([released, expired])
      } finally {
        clearTimeout(timer)
      }
    },
  })
}
