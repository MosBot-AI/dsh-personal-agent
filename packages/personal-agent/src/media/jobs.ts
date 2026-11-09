import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  capabilityIdSchema, mediaAccessSchema, mediaHandleSchema, mediaJobStatusSchema, mediaOutputsSchema,
  mediaSubmitRequestSchema, preparedMediaSubmissionSchema, providerPinSchema, providerResultSchema, sameProviderPin,
  type MediaAccess, type MediaHandle, type MediaInputArtifact, type MediaJobRequest, type MediaOutput, type MediaSubmitRequest,
  type PreparedMediaSubmission, type ProviderFailureCode, type ProviderPin, type ProviderResult,
} from '@mosbot-ai/dshpa-plugin-api'
import { z } from 'zod'
import type { CapabilityRegistry } from '../runtime/capability-registry.js'
import { dispatchPermitted } from '../storage/recovery-state.js'
import { transaction } from '../storage/schema.js'
import { matchesMediaOutput, supportsLocalMedia } from './provider.js'
import { holdingLease, mediaQueueConfigSchema, scopeParams, withinMediaQuota } from './resources.js'

const pinSchema = providerPinSchema.extend({ kind: z.literal('media') })
export const mediaServiceConfigSchema = mediaQueueConfigSchema.extend({
  providers: z.strictObject({ image: pinSchema.optional(), video: pinSchema.optional() }).refine(value => value.image || value.video),
})
const jobStates = z.enum(['queued', 'submitting', 'unknown', 'rendering', 'collecting', 'succeeded', 'failed', 'cancelled'])
type JobState = z.output<typeof jobStates>
const jobRefSchema = z.strictObject({ access: mediaAccessSchema, operationId: capabilityIdSchema })
type JobRef = z.output<typeof jobRefSchema>
type DbAccess = <T>(callback: (db: DatabaseSync) => T) => T
export type MediaServiceConfig = z.output<typeof mediaServiceConfigSchema>
export interface MediaJobAuthority {
  current(scope: MediaAccess): boolean
  artifactAllowed(scope: MediaAccess, artifact: MediaInputArtifact): boolean
  canLease?(): boolean
}
interface Job {
  sequence: number
  request: MediaSubmitRequest
  provider: ProviderPin<'media'>
  state: JobState
  prepared?: PreparedMediaSubmission
  outputs?: MediaOutput[]
  reason?: string
  cancelRequested: boolean
}
export interface DurableMediaJobStatus {
  state: JobState
  provider: ProviderPin<'media'>
  handle?: MediaHandle
  outputs?: MediaOutput[]
  reason?: string
}

const fail = (code: ProviderFailureCode): ProviderResult<never> => ({ ok: false, code })
const ok = <T>(value: T): ProviderResult<T> => ({ ok: true, value })
const checked = <S extends z.ZodType>(schema: S, result: unknown): ProviderResult<z.output<S>> => {
  const parsed = providerResultSchema(schema).safeParse(result)
  return parsed.success ? parsed.data as ProviderResult<z.output<S>> : fail('invalid_result')
}
const params = (ref: JobRef) => [...scopeParams(ref.access), ref.operationId] as const
const byScope = 'owner_id = ? AND profile_id = ? AND task_id = ? AND attempt_id = ? AND generation = ? AND operation_id = ?'

function decode(row: Record<string, unknown>): Job {
  return {
    sequence: z.int().positive().parse(row.sequence),
    request: mediaSubmitRequestSchema.parse(JSON.parse(String(row.request))),
    provider: pinSchema.parse(JSON.parse(String(row.provider))),
    state: jobStates.parse(row.state),
    prepared: row.prepared === null ? undefined : preparedMediaSubmissionSchema.parse(JSON.parse(String(row.prepared))),
    outputs: row.outputs === null ? undefined : mediaOutputsSchema.parse(JSON.parse(String(row.outputs))),
    reason: typeof row.reason === 'string' ? row.reason : undefined,
    cancelRequested: row.cancel_requested === 1,
  }
}

function publicStatus(job: Job): DurableMediaJobStatus {
  return { state: job.state, provider: job.provider, handle: job.prepared?.handle, outputs: job.outputs, reason: job.reason }
}

/** Trusted host service. A caller sees only its current Attempt and never receives a provider object. */
export function createMediaJobs(dbAccess: DbAccess, registry: CapabilityRegistry, input: MediaServiceConfig, authority: MediaJobAuthority) {
  const config = mediaServiceConfigSchema.parse(input)
  const abort = new AbortController()
  let inFlight: Promise<void> | undefined
  let timer: NodeJS.Timeout | undefined
  let collection: { sequence: number; abort: AbortController } | undefined

  function current(access: MediaAccess): boolean {
    return !abort.signal.aborted && authority.current(access)
  }

  function allowed(request: MediaSubmitRequest): boolean {
    return current(request.access) && (request.inputArtifacts ?? []).every(artifact => authority.artifactAllowed(request.access, artifact))
  }

  function enqueue(raw: unknown): ProviderResult<DurableMediaJobStatus> {
    const parsed = mediaSubmitRequestSchema.safeParse(raw)
    if (!parsed.success) return fail('invalid_input')
    const request = parsed.data
    if (!allowed(request)) return fail('permission_denied')
    const body = JSON.stringify(request)
    const digest = createHash('sha256').update(body).digest('hex')
    return dbAccess(db => transaction(db, () => {
      const prior = db.prepare(`SELECT * FROM media_jobs WHERE ${byScope}`).get(...params(request))
      if (prior) return prior.digest === digest ? ok(publicStatus(decode(prior))) : fail('conflict')
      if (!dispatchPermitted(db)) return fail('busy')
      const provider = config.providers[request.spec.modality]
      if (!provider) return fail('unsupported_capability')
      const metadata = registry.inspect(provider)
      if (!metadata.ok) return metadata
      if (!supportsLocalMedia(metadata.value.capabilities, request.spec)) return fail('permission_denied')
      if (!withinMediaQuota(db, request.access, config)) return fail('busy')
      db.prepare(`INSERT INTO media_jobs
        (owner_id, profile_id, task_id, attempt_id, generation, operation_id, digest, request, provider, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`).run(...params(request), digest, body, JSON.stringify(provider))
      return ok({ state: 'queued', provider })
    }))
  }

  function scoped(raw: unknown, cancel: boolean): ProviderResult<DurableMediaJobStatus> {
    const parsed = jobRefSchema.safeParse(raw)
    if (!parsed.success) return fail('invalid_input')
    if (!current(parsed.data.access)) return fail('permission_denied')
    let cancelSequence: number | undefined
    const result = dbAccess(db => transaction(db, () => {
      const key = params(parsed.data)
      if (cancel && !dispatchPermitted(db)) return fail('busy')
      if (cancel) db.prepare(`UPDATE media_jobs SET cancel_requested = 1,
        state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END
        WHERE ${byScope} AND state IN ('queued', 'submitting', 'unknown', 'rendering', 'collecting')`).run(...key)
      const row = db.prepare(`SELECT * FROM media_jobs WHERE ${byScope}`).get(...key)
      // Keep the durable lease until the physical collector settles, even when
      // it does not honor abort. The saved flag fences its eventual result.
      if (cancel && collection && row?.state === 'collecting' && row.cancel_requested === 1 && row.sequence === collection.sequence) {
        cancelSequence = collection.sequence
      }
      return row ? ok(publicStatus(decode(row))) : fail('not_found')
    }))
    if (cancelSequence !== undefined && collection?.sequence === cancelSequence) collection.abort.abort()
    return result
  }

  function update(job: Job, state: JobState, reason?: string, outputs?: MediaOutput[]): void {
    dbAccess(db => db.prepare(`UPDATE media_jobs SET state = ?, reason = ?, outputs = ?
      WHERE sequence = ? AND state = ?`).run(state, reason ?? null, outputs ? JSON.stringify(outputs) : null, job.sequence, job.state))
  }

  function retryLater(job: Job, reason: string): void {
    dbAccess(db => db.prepare("UPDATE media_jobs SET reason = ?, next_try = ? WHERE sequence = ? AND state = 'queued'")
      .run(reason, Date.now() + Math.max(5000, config.pollMs), job.sequence))
  }

  async function send(job: Job, signal: AbortSignal): Promise<void> {
    if (!allowed(job.request)) return update(job, 'cancelled', 'permission_denied')
    if (authority.canLease?.() === false) return
    const metadata = registry.inspect(job.provider)
    if (!metadata.ok) return retryLater(job, metadata.code)
    if (!supportsLocalMedia(metadata.value.capabilities, job.request.spec)) return update(job, 'failed', 'permission_denied')
    const dispatched = await registry.invoke(job.provider, async (provider, callSignal) => {
      if (!provider.durableSubmission) {
        update(job, 'failed', 'unsupported_capability')
        return ok(null)
      }
      const result = checked(preparedMediaSubmissionSchema, await provider.durableSubmission.prepare(job.request, callSignal))
      if (!result.ok) {
        if (['busy', 'rate_limited', 'provider_unavailable', 'cancelled'].includes(result.code)) retryLater(job, result.code)
        else update(job, 'failed', result.code)
        return ok(null)
      }
      const { handle } = result.value
      if (!sameProviderPin(job.provider, handle.provider) || handle.operationId !== job.request.operationId) {
        update(job, 'failed', 'invalid_result')
        return ok(null)
      }
      if (callSignal.aborted || !allowed(job.request) || !registry.inspect(job.provider).ok) return ok(null)

      // This transition is the only place a send can be admitted, including after process restart.
      const claimed = dbAccess(db => transaction(db, () => dispatchPermitted(db) && authority.canLease?.() !== false && db.prepare(`
        UPDATE media_jobs SET state = 'submitting', prepared = ?, reason = NULL
        WHERE sequence = ? AND state = 'queued' AND NOT EXISTS (SELECT 1 FROM media_jobs WHERE ${holdingLease})
      `).run(JSON.stringify(result.value), job.sequence).changes === 1))
      if (!claimed) return ok(null)
      const sending = { ...job, state: 'submitting' } as const
      const receipt = checked(mediaHandleSchema, await provider.durableSubmission.submit(job.request, result.value, callSignal))
      if (receipt.ok && sameProviderPin(job.provider, receipt.value.provider) && receipt.value.operationId === handle.operationId
        && receipt.value.handleId === handle.handleId) update(sending, 'rendering')
      else if (!receipt.ok && receipt.code === 'invalid_input') update(sending, 'failed', receipt.code)
      else update(sending, 'unknown', 'uncertain')
      return ok(null)
    }, signal)
    if (!dispatched.ok && !signal.aborted) retryLater(job, dispatched.code)
  }

  async function reconcile(job: Job, signal: AbortSignal): Promise<void> {
    const request: MediaJobRequest = { access: job.request.access, handle: job.prepared!.handle }
    if (job.state === 'collecting') {
      const cancelled = () => dbAccess(db => db.prepare('SELECT cancel_requested FROM media_jobs WHERE sequence = ?')
        .get(job.sequence)?.cancel_requested === 1)
      if (cancelled()) return update(job, 'cancelled')
      if (!current(request.access)) return update(job, 'cancelled', 'permission_denied')
      const abortCollection = new AbortController()
      collection = { sequence: job.sequence, abort: abortCollection }
      let output: ProviderResult<MediaOutput[]>
      try {
        output = checked(mediaOutputsSchema, await registry.invoke(job.provider, (provider, active) =>
          provider.collect(request, active), AbortSignal.any([signal, abortCollection.signal])))
      } finally {
        collection = undefined
      }
      if (signal.aborted) return
      if (cancelled()) return update(job, 'cancelled')
      if (!output.ok) {
        if (output.code === 'invalid_result' || output.code === 'permission_denied') update(job, 'failed', output.code)
        else update(job, 'collecting', output.code)
      } else if (!current(request.access)) update(job, 'cancelled', 'permission_denied')
      else if (output.value.every(asset => matchesMediaOutput(job.request.spec, asset))) update(job, 'succeeded', undefined, output.value)
      else update(job, 'failed', 'invalid_result')
      return
    }

    const status = checked(mediaJobStatusSchema, await registry.invoke(job.provider, (provider, active) =>
      job.cancelRequested && current(request.access) && dbAccess(dispatchPermitted)
        && ['queued', 'per-job'].includes(provider.capabilities.cancellation)
        ? provider.cancel(request, active) : provider.inspect(request, active), signal))
    if (signal.aborted) return
    if (!status.ok) return update(job, 'unknown', status.code)
    switch (status.value.state) {
      case 'unknown': return update(job, 'unknown', 'uncertain')
      case 'queued':
      case 'running': return update(job, 'rendering')
      case 'succeeded': return update(job, 'collecting')
      case 'failed': return update(job, 'failed', 'provider_failed')
      case 'cancelled': return update(job, 'cancelled')
    }
  }

  function step(): Promise<void> {
    if (abort.signal.aborted) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = Promise.resolve().then(async () => {
      const active = dbAccess(db => db.prepare(`SELECT * FROM media_jobs WHERE ${holdingLease}`).get())
      if (active) return reconcile(decode(active), abort.signal)
      const next = dbAccess(db => dispatchPermitted(db) ? db.prepare(
        "SELECT * FROM media_jobs WHERE state = 'queued' AND next_try <= ? ORDER BY sequence LIMIT 1").get(Date.now()) : undefined)
      if (next) await send(decode(next), abort.signal)
    }).finally(() => { inFlight = undefined })
    return inFlight
  }

  return Object.freeze({
    enqueue, inspect: (ref: unknown) => scoped(ref, false), cancel: (ref: unknown) => scoped(ref, true), step,
    start(onError: (error: unknown) => void) {
      if (timer || abort.signal.aborted) return
      const run = () => { void step().catch(onError) }
      timer = setInterval(run, config.pollMs)
      timer.unref()
      run()
    },
    async close() {
      clearInterval(timer)
      abort.abort()
      await inFlight
    },
  })
}

export type MediaJobService = ReturnType<typeof createMediaJobs>
