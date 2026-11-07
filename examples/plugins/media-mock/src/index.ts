import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  CAPABILITY_API_VERSION, mediaSubmitRequestSchema, sameProviderPin,
  type MediaAccess, type MediaJobRequest, type MediaJobStatus, type MediaOutput, type MediaProvider,
  type PluginRegistrar, type ProviderDefinition, type ProviderFailureCode, type ProviderPin, type ProviderResult,
} from '@mosbot-ai/dshpa-plugin-api'
import { z } from 'zod'

const configSchema = z.strictObject({ maxJobs: z.int().min(1).max(128).default(32), latencyMs: z.int().min(0).max(60_000).default(0) })
const mountSchema = configSchema.extend({
  instanceId: z.string().min(1).max(120).default('example-media-mock'),
  configRevision: z.int().positive().default(1),
})
type MockConfig = z.output<typeof configSchema>

const ok = <T>(value: T): ProviderResult<T> => ({ ok: true, value })
const fail = (code: ProviderFailureCode): ProviderResult<never> => ({ ok: false, code })
const hash = (input: string) => createHash('sha256').update(input).digest('hex')

const maximumDimension = 1_024

interface MockJob {
  readonly accessKey: string
  readonly operationId: string
  readonly fingerprint: string
  readonly availableAt: number
  readonly width: number
  readonly height: number
  state: 'queued' | 'succeeded' | 'cancelled'
}

function scopeKey(access: MediaAccess): string {
  return JSON.stringify([access.ownerId, access.profileId, access.taskId, access.attemptId, access.generation])
}

function fixtureAsset(handleId: string, { width, height }: MockJob): MediaOutput {
  const fixture = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="0" y="20">MOCK FIXTURE</text></svg>`
  return { assetId: `mock-asset-${hash(handleId)}`, contentHash: hash(fixture), mediaType: 'image/svg+xml',
    sizeBytes: Buffer.byteLength(fixture), width, height }
}

function makeProvider(pin: ProviderPin<'media'>, config: MockConfig): MediaProvider {
  let open = true
  const jobs = new Map<string, MockJob>()
  const unavailable = (signal: AbortSignal) => signal.aborted ? fail('cancelled') : !open ? fail('provider_unavailable') : undefined
  const matching = ({ access, handle }: MediaJobRequest) => {
    if (!sameProviderPin(handle.provider, pin)) return undefined
    const job = jobs.get(handle.handleId)
    return job?.accessKey === scopeKey(access) && job.operationId === handle.operationId ? job : undefined
  }
  const status = (job: MockJob): MediaJobStatus => {
    if (job.state === 'queued' && performance.now() >= job.availableAt) job.state = 'succeeded'
    return { state: job.state }
  }

  return {
    capabilities: {
      mock: true, destinations: [{ kind: 'local' }],
      formats: [{ modality: 'image', operations: ['generate'], maxWidth: maximumDimension, maxHeight: maximumDimension }],
      cancellation: 'queued', resources: { compute: 'cpu', exclusive: false }, pricing: { kind: 'free' },
    },
    health: () => ({ status: open ? 'ready' : 'unavailable' }),
    drain() {
      open = false
      for (const job of jobs.values()) if (job.state === 'queued') job.state = 'cancelled'
    },
    stop() { open = false; jobs.clear() },
    submit(raw, signal) {
      const unavailableResult = unavailable(signal)
      if (unavailableResult) return unavailableResult
      const decoded = mediaSubmitRequestSchema.safeParse(raw)
      if (!decoded.success) return fail('invalid_input')
      const request = decoded.data
      const { spec, operationId } = request
      if (spec.modality !== 'image' || spec.operation !== 'generate' || spec.width > maximumDimension
        || spec.height > maximumDimension || (request.inputArtifacts?.length ?? 0) !== 0) return fail('unsupported_capability')
      const accessKey = scopeKey(request.access)
      const handleId = `mock-job-${hash(JSON.stringify([pin, accessKey, operationId]))}`
      const fingerprint = hash(JSON.stringify(request))
      const existing = jobs.get(handleId)
      if (existing && existing.fingerprint !== fingerprint) return fail('conflict')
      if (!existing) {
        if (jobs.size >= config.maxJobs) return fail('busy')
        jobs.set(handleId, { accessKey, operationId, fingerprint, availableAt: performance.now() + config.latencyMs,
          width: spec.width, height: spec.height, state: 'queued' })
      }
      return ok({ provider: structuredClone(pin), operationId, handleId })
    },
    inspect(request, signal) {
      const unavailableResult = unavailable(signal)
      if (unavailableResult) return unavailableResult
      const job = matching(request)
      return job ? ok(status(job)) : fail('not_found')
    },
    cancel(request, signal) {
      const unavailableResult = unavailable(signal)
      if (unavailableResult) return unavailableResult
      const job = matching(request)
      if (!job) return fail('not_found')
      if (job.state === 'queued') job.state = 'cancelled'
      return ok({ state: job.state })
    },
    collect(request, signal) {
      const unavailableResult = unavailable(signal)
      if (unavailableResult) return unavailableResult
      const job = matching(request)
      if (!job) return fail('not_found')
      return status(job).state === 'succeeded' ? ok([fixtureAsset(request.handle.handleId, job)]) : fail('conflict')
    },
  }
}

export const definition: ProviderDefinition<'media', MockConfig> = {
  manifest: { kind: 'media', pluginId: 'example-media-mock', pluginVersion: '0.0.0', apiVersion: CAPABILITY_API_VERSION },
  configSchema,
  start(config, { pin }) { return ok(makeProvider(pin, config)) },
}

export const inject = ['dshpaPlugins']

export function apply(ctx: Context & { readonly dshpaPlugins: PluginRegistrar }, raw: unknown): void {
  const { instanceId, configRevision, ...config } = mountSchema.parse(raw ?? {})
  ctx.effect(() => {
    const registration = ctx.dshpaPlugins.register(definition, { instanceId, configRevision }, config)
    return () => registration.dispose()
  }, 'dshpa: example mock media provider')
}
