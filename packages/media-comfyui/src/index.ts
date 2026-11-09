import { createHash, randomUUID } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  CAPABILITY_API_VERSION, capabilityIdSchema, defineProvider, mediaJobRequestSchema, mediaSpecSchema,
  mediaSubmitRequestSchema, preparedMediaSubmissionSchema, sameProviderPin,
  type MediaCapabilities, type MediaHandle, type MediaJobRequest, type MediaJobStatus, type MediaOutput,
  type MediaProvider, type MediaSubmitRequest, type PluginRegistrar, type ProviderFailureCode, type ProviderPin,
  type ProviderResult,
} from '@mosbot-ai/dshpa-plugin-api'
import { z } from 'zod'
import { BackendError, createComfyHttp, originSchema, readBounded } from './http.js'
import { verifyOutput } from './verify.js'

const manifest = { kind: 'media', pluginId: '@mosbot-ai/dshpa-media-comfyui', pluginVersion: '0.1.0', apiVersion: CAPABILITY_API_VERSION } as const
const nodeId = z.string().regex(/^\d{1,20}$/)
const binding = z.strictObject({ node: nodeId, input: z.string().regex(/^[a-zA-Z][\w-]{0,79}$/) })
const graphSchema = z.record(nodeId, z.object({
  class_type: z.string().min(1).max(128),
  inputs: z.record(z.string(), z.json()),
}))
const workflowSchema = z.strictObject({
  id: capabilityIdSchema, version: capabilityIdSchema, model: capabilityIdSchema,
  spec: mediaSpecSchema.refine(spec => spec.operation === 'generate'),
  graph: graphSchema,
  prompt: binding, seed: binding,
  outputs: z.array(nodeId).min(1).max(8),
}).refine(workflow => {
  const { graph, prompt, seed, outputs } = workflow
  return Object.keys(graph).length <= 128 && Buffer.byteLength(JSON.stringify(graph)) <= 512 * 1024
    && new Set(outputs).size === outputs.length && outputs.every(node => Object.hasOwn(graph, node))
    && typeof graph[prompt.node]?.inputs[prompt.input] === 'string'
    && typeof graph[seed.node]?.inputs[seed.input] === 'number'
}, 'Invalid workflow bindings or output nodes')

const configSchema = z.strictObject({
  origin: originSchema,
  outputDirectory: z.string().refine(isAbsolute),
  compute: z.enum(['cpu', 'gpu']),
  workflows: z.array(workflowSchema).min(1).max(16).refine(workflows =>
    new Set(workflows.map(({ id, version }) => JSON.stringify([id, version]))).size === workflows.length),
  minFreeDiskBytes: z.int().positive().default(512 * 1024 * 1024),
  minFreeMemoryBytes: z.int().positive().default(256 * 1024 * 1024),
  maxOutputBytes: z.int().positive().max(64 * 1024 * 1024).default(32 * 1024 * 1024),
  timeoutMs: z.int().min(100).max(60_000).default(10_000),
})
type Config = z.output<typeof configSchema>
const mountSchema = configSchema.extend({ instanceId: capabilityIdSchema, configRevision: z.int().positive() })
const uuid = z.uuidv4()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const ok = <T>(value: T): ProviderResult<T> => ({ ok: true, value })
const fail = (code: ProviderFailureCode): ProviderResult<never> => ({ ok: false, code })
const codeOf = (error: unknown, fallback: ProviderFailureCode) => error instanceof BackendError ? error.code : fallback
const statsSchema = z.object({
  system: z.object({ comfyui_version: z.string(), ram_free: z.number().nonnegative() }),
  devices: z.array(z.object({ type: z.string(), vram_free: z.number().nonnegative() })).min(1),
})
const extraSchema = z.object({ dshpa_binding: z.string().optional() })
const queueItem = z.tuple([z.number(), z.string(), z.unknown(), extraSchema]).rest(z.unknown())
const queueSchema = z.object({ queue_running: z.array(queueItem), queue_pending: z.array(queueItem) })
const fileSchema = z.object({
  filename: z.string().min(1).max(256).refine(name => !/[\\/:[\]\x00-\x1f]/.test(name) && name !== '.' && name !== '..'),
  subfolder: z.string().max(512).refine(value => value === '' || value.split('/').every(part =>
    part.length > 0 && part !== '.' && part !== '..' && !/[\\:[\]\x00-\x1f]/.test(part))),
  type: z.literal('output'),
})
const historyEntry = z.object({
  prompt: queueItem,
  status: z.object({ status_str: z.enum(['success', 'error']), completed: z.boolean(), messages: z.array(z.unknown()).optional() }),
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())),
})

function matches(left: MediaSubmitRequest['spec'], right: MediaSubmitRequest['spec']): boolean {
  return left.modality === right.modality && left.operation === right.operation && left.width === right.width && left.height === right.height
    && (left.modality === 'image' || (right.modality === 'video' && left.durationMs === right.durationMs))
}

function makeProvider(pin: ProviderPin<'media'>, config: Config): MediaProvider {
  let open = true
  const http = createComfyHttp(config.origin, config.timeoutMs)
  const formats: MediaCapabilities['formats'] = []
  for (const modality of ['image', 'video'] as const) {
    const specs = config.workflows.map(workflow => workflow.spec).filter(spec => spec.modality === modality)
    if (!specs.length) continue
    const bounds = { operations: ['generate'] as ['generate'], maxWidth: Math.max(...specs.map(spec => spec.width)),
      maxHeight: Math.max(...specs.map(spec => spec.height)) }
    if (modality === 'image') formats.push({ modality, ...bounds })
    else formats.push({ modality, ...bounds, maxDurationMs: Math.max(...specs.map(spec => spec.modality === 'video' ? spec.durationMs : 0)) })
  }
  const unavailable = (signal: AbortSignal) => signal.aborted ? fail('cancelled') : !open ? fail('provider_unavailable') : undefined
  function bindingFor({ handle, access }: MediaJobRequest): string {
    return hash(JSON.stringify([pin.kind, pin.pluginId, pin.pluginVersion, pin.instanceId, pin.configRevision,
      access.ownerId, access.profileId, access.taskId, access.attemptId, access.generation, handle.operationId, handle.handleId]))
  }

  function compile(request: MediaSubmitRequest, handle: MediaHandle) {
    const workflow = config.workflows.find(candidate => candidate.id === request.workflowId && candidate.version === request.workflowVersion
      && candidate.model === request.model && matches(candidate.spec, request.spec))
    if (!workflow || !request.prompt || request.inputArtifacts?.length) throw new BackendError('unsupported_capability')
    const graph = structuredClone(workflow.graph)
    const seed = Number.parseInt(handle.handleId.replaceAll('-', '').slice(0, 12), 16)
    graph[workflow.prompt.node]!.inputs[workflow.prompt.input] = request.prompt
    graph[workflow.seed.node]!.inputs[workflow.seed.input] = seed
    const body = {
      prompt: graph, prompt_id: handle.handleId, partial_execution_targets: workflow.outputs,
      extra_data: { dshpa_binding: bindingFor({ access: request.access, handle }) },
    }
    return { body, seed, workflowDigest: hash(JSON.stringify(body)) }
  }

  async function probe(signal: AbortSignal): Promise<void> {
    const [stats, disk] = await Promise.all([
      http.json('/system_stats', statsSchema, signal),
      statfs(config.outputDirectory, { bigint: true }),
    ])
    if (stats.system.comfyui_version !== '0.44.0') throw new BackendError('incompatible_version')
    if (stats.system.ram_free < config.minFreeMemoryBytes
      || disk.bavail * disk.bsize < BigInt(config.minFreeDiskBytes)) throw new BackendError('busy')
    const hasCompute = stats.devices.some(device => config.compute === 'cpu' ? device.type === 'cpu'
      : ['cuda', 'xpu', 'mps'].includes(device.type) && (device.type === 'mps' || device.vram_free >= config.minFreeMemoryBytes))
    if (!hasCompute) throw new BackendError('busy')
  }

  async function observe(request: MediaJobRequest, signal: AbortSignal) {
    const id = request.handle.handleId
    const tag = bindingFor(request)
    const queue = await http.json('/queue', queueSchema, signal)
    const running = queue.queue_running.find(item => item[1] === id)
    const pending = queue.queue_pending.find(item => item[1] === id)
    const item = running ?? pending
    if (item) {
      if (item[3].dshpa_binding !== tag) throw new BackendError('permission_denied')
      return { state: running ? 'running' : 'queued' } as const
    }
    const result = await http.json('/history/' + id, z.record(z.string(), historyEntry), signal)
    const entry = result[id]
    if (!entry) return { state: 'unknown' } as const
    if (entry.prompt[1] !== id || entry.prompt[3].dshpa_binding !== tag) throw new BackendError('permission_denied')
    const interrupted = entry.status.messages?.some(message => Array.isArray(message) && message[0] === 'execution_interrupted')
    const state = interrupted ? 'cancelled' : entry.status.status_str === 'error' ? 'failed'
      : entry.status.completed ? 'succeeded' : 'unknown'
    return { state, entry } as const
  }

  async function scoped<T>(raw: MediaJobRequest, signal: AbortSignal,
    execute: (request: MediaJobRequest) => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
    const offline = unavailable(signal)
    if (offline) return offline
    const parsed = mediaJobRequestSchema.safeParse(raw)
    if (!parsed.success || !uuid.safeParse(parsed.data.handle.handleId).success) return fail('invalid_input')
    if (!sameProviderPin(pin, parsed.data.handle.provider)) return fail('not_found')
    try { return await execute(parsed.data) }
    catch (error) { return fail(signal.aborted ? 'cancelled' : codeOf(error, 'invalid_result')) }
  }

  return {
    capabilities: {
      mock: false, destinations: [{ kind: 'network', origin: config.origin }], formats,
      cancellation: 'per-job', resources: { compute: config.compute, exclusive: true }, pricing: { kind: 'free' },
    },
    async health(signal) {
      if (!open || signal.aborted) return { status: 'unavailable' }
      try {
        await probe(signal)
        return { status: 'ready' }
      } catch (error) {
        const code = codeOf(error, 'invalid_config')
        if (code === 'busy') return { status: 'degraded', reason: 'capacity' }
        return { status: 'unavailable', reason: code === 'incompatible_version' || code === 'invalid_config' ? 'configuration' : 'offline' }
      }
    },
    drain() { open = false },
    stop() { open = false },
    submit() { return fail('unsupported_capability') },
    durableSubmission: {
      async prepare(raw, signal) {
        const offline = unavailable(signal)
        if (offline) return offline
        const parsed = mediaSubmitRequestSchema.safeParse(raw)
        if (!parsed.success) return fail('invalid_input')
        const handle = { provider: pin, operationId: parsed.data.operationId, handleId: randomUUID() }
        try {
          const { body, seed, workflowDigest } = compile(parsed.data, handle)
          await probe(signal)
          const nodeSchema = z.record(z.string(), z.object({ api_node: z.boolean().optional() }))
          for (const name of new Set(Object.values(body.prompt).map(node => node.class_type))) {
            const info = await http.json('/object_info/' + encodeURIComponent(name), nodeSchema, signal)
            if (!Object.hasOwn(info, name) || info[name]?.api_node) return fail('unsupported_capability')
          }
          return ok({ handle, workflowDigest, seed })
        } catch (error) {
          return fail(signal.aborted ? 'cancelled' : codeOf(error, 'provider_unavailable'))
        }
      },
      async submit(raw, rawPrepared, signal) {
        const offline = unavailable(signal)
        if (offline) return offline
        const request = mediaSubmitRequestSchema.safeParse(raw)
        const prepared = preparedMediaSubmissionSchema.safeParse(rawPrepared)
        if (!request.success || !prepared.success) return fail('invalid_input')
        const { handle } = prepared.data
        if (!uuid.safeParse(handle.handleId).success || !sameProviderPin(handle.provider, pin)
          || handle.operationId !== request.data.operationId) return fail('invalid_input')
        try {
          const { body, workflowDigest, seed } = compile(request.data, handle)
          if (workflowDigest !== prepared.data.workflowDigest || seed !== prepared.data.seed) return fail('conflict')
          const response = await http.request('/prompt', signal, body)
          if (response.status === 400) {
            const rejected = z.object({ error: z.object({ type: z.string() }), node_errors: z.record(z.string(), z.unknown()) })
            const bytes = await readBounded(response, 4 * 1024 * 1024)
            return fail(rejected.safeParse(JSON.parse(bytes.toString('utf8'))).success ? 'invalid_input' : 'uncertain')
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined)
            return fail('uncertain')
          }
          const receipt = z.object({ prompt_id: uuid }).parse(JSON.parse((await readBounded(response, 64 * 1024)).toString('utf8')))
          return receipt.prompt_id === handle.handleId ? ok(handle) : fail('uncertain')
        } catch {
          return fail('uncertain')
        }
      },
    },
    inspect: (request, signal) => scoped<MediaJobStatus>(request, signal, async bound => {
      const { state } = await observe(bound, signal)
      return ok({ state })
    }),
    cancel: (request, signal) => scoped<MediaJobStatus>(request, signal, async bound => {
      const before = await observe(bound, signal)
      if (before.state !== 'running' && before.state !== 'queued') return ok({ state: before.state })
      const route = '/api/jobs/' + bound.handle.handleId + '/cancel'
      const reply = await http.json(route, z.object({ cancelled: z.boolean() }), signal, {})
      const after = await observe(bound, signal)
      return ok({ state: before.state === 'queued' && reply.cancelled && after.state === 'unknown' ? 'cancelled' : after.state })
    }),
    collect: (request, signal) => scoped<MediaOutput[]>(request, signal, async bound => {
      const observation = await observe(bound, signal)
      if (observation.state !== 'succeeded' || !('entry' in observation)) return fail('busy')
      const results: MediaOutput[] = []
      const refs = new Set<string>()
      let remainingBytes = config.maxOutputBytes
      const approvedNodes = z.array(nodeId).min(1).max(8).parse(observation.entry.prompt[4])
      for (const id of approvedNodes) {
        const node = observation.entry.outputs[id]
        if (!node) continue
        for (const key of ['images', 'video', 'videos', 'gifs']) {
          if (!Object.hasOwn(node, key)) continue
          const files = z.array(fileSchema).max(8).parse(node[key])
          for (const file of files) {
            const query = new URLSearchParams(file).toString()
            if (refs.has(query)) continue
            refs.add(query)
            if (refs.size > 8) return fail('invalid_result')
            const response = await http.request('/view?' + query, signal)
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined)
              return fail('provider_unavailable')
            }
            const bytes = await readBounded(response, remainingBytes)
            remainingBytes -= bytes.length
            const assetId = 'comfy-' + hash(JSON.stringify([bound.handle.handleId, query]))
            results.push(await verifyOutput(bytes, assetId, signal))
          }
        }
      }
      return results.length ? ok(results) : fail('invalid_result')
    }),
  }
}

export const comfyMediaProvider = defineProvider({
  manifest, configSchema,
  start(config, { pin }) { return ok(makeProvider(pin, config)) },
})

export const name = 'dshpa-media-comfyui'
export const inject = ['dshpaPlugins']
export function apply(ctx: Context, raw: unknown): void {
  const { instanceId, configRevision, ...config } = mountSchema.parse(raw)
  const registrar = ctx.get('dshpaPlugins') as PluginRegistrar
  const registration = registrar.register(comfyMediaProvider, { instanceId, configRevision }, config)
  ctx.effect(() => registration.dispose, 'dshpa: ComfyUI media provider')
}
