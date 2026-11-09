import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import type { MediaProvider, MediaSpec } from '../../packages/plugin-api/src/media.js'
import { comfyMediaProvider } from '../../packages/media-comfyui/src/index.js'
import { createCapabilityRegistry } from '../../packages/personal-agent/src/runtime/capability-registry.js'

export const imageSpec = { modality: 'image', operation: 'generate', width: 16, height: 16 } as const
export const videoSpec = { ...imageSpec, modality: 'video', durationMs: 500 } as const

interface Submission {
  prompt_id: string
  prompt: unknown
  partial_execution_targets: string[]
  extra_data: Record<string, unknown>
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** HTTP behavior fixture for v0.44.0. It deliberately does not deduplicate POSTs. */
export async function comfyFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-comfy-fixture-'))
  const submissions: Submission[] = []
  const cancelled: string[] = []
  let onSubmit: ((submission: Submission) => void) | undefined
  let onView: (() => void) | undefined
  const pending = new Map<string, unknown[]>()
  const running = new Map<string, unknown[]>()
  const history = new Map<string, unknown>()
  const outputs = new Map<string, Buffer>()
  const faults = { loseResponse: false, holdResponse: false, missing: false, rateLimit: false, apiNode: false, cancelRace: false, redirect: false, viewStatus: 200, interruptView: false, stallView: false }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fixture')
    const path = url.pathname
    if (path === '/system_stats') return faults.rateLimit ? json(response, {}, 429)
      : json(response, { system: { comfyui_version: '0.44.0', ram_free: 1e9 }, devices: [{ type: 'cpu', vram_free: 1e9 }] })
    if (path.startsWith('/object_info/')) return json(response, { [decodeURIComponent(path.slice(13))]: { api_node: faults.apiNode } })
    if (path === '/queue') return json(response, {
      queue_running: [...running.values()], queue_pending: faults.missing ? [] : [...pending.values()],
    })
    if (path.startsWith('/history/')) {
      const id = path.slice(9)
      return json(response, history.has(id) && !faults.missing ? { [id]: history.get(id) } : {})
    }
    if (path === '/view') {
      if (faults.viewStatus !== 200) return json(response, {}, faults.viewStatus)
      const bytes = outputs.get(url.searchParams.get('filename') ?? '')
      if (!bytes) return json(response, {}, 404)
      onView?.()
      if (faults.stallView) {
        response.writeHead(200, { 'content-length': bytes.length })
        response.write(bytes.subarray(0, 8))
        return
      }
      if (faults.interruptView) {
        response.writeHead(200, { 'content-length': bytes.length })
        response.write(bytes.subarray(0, 8))
        setTimeout(() => response.destroy(), 10)
        return
      }
      response.end(bytes)
      return
    }
    if (path === '/prompt' && request.method === 'POST') {
      if (faults.redirect) {
        response.writeHead(307, { location: '/redirected' }).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Submission
      submissions.push(body)
      pending.set(body.prompt_id, [submissions.length, body.prompt_id, body.prompt, body.extra_data, body.partial_execution_targets])
      onSubmit?.(body)
      if (faults.loseResponse) return request.socket.destroy()
      if (faults.holdResponse) return
      return json(response, { prompt_id: body.prompt_id })
    }
    const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path)
    if (cancel && request.method === 'POST') {
      const id = cancel[1]!
      cancelled.push(id)
      if (faults.cancelRace) {
        const item = pending.get(id)
        if (item) {
          pending.delete(id)
          running.set(id, item)
        }
        return json(response, { cancelled: false })
      }
      return json(response, { cancelled: pending.delete(id) })
    }
    return json(response, {}, 404)
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected fixture address')
  const origin = `http://127.0.0.1:${address.port}`
  const workflows = [imageSpec, videoSpec].map(spec => ({
    id: spec.modality, version: '1', model: 'local-model', spec,
    graph: {
      '1': { class_type: 'FixtureText', inputs: { text: '' } },
      '2': { class_type: 'FixtureSampler', inputs: { seed: 0 } },
    },
    prompt: { node: '1', input: 'text' }, seed: { node: '2', input: 'seed' }, outputs: ['2'],
  }))
  const config = { origin, outputDirectory: directory, compute: 'cpu', minFreeDiskBytes: 1, minFreeMemoryBytes: 1, workflows }
  return {
    directory, config, faults, submissions, cancelled, pending, running,
    watchSubmit(callback: (submission: Submission) => void) { onSubmit = callback },
    watchView(callback: () => void) { onView = callback },
    async register(configRevision = 1, overrides: { timeoutMs?: number } = {}, decorate?: (provider: MediaProvider) => MediaProvider) {
      const registry = createCapabilityRegistry()
      const definition = {
        ...comfyMediaProvider,
        async start(settings: Parameters<typeof comfyMediaProvider.start>[0], context: Parameters<typeof comfyMediaProvider.start>[1]) {
          const result = await comfyMediaProvider.start(settings, context)
          return result.ok ? { ok: true as const, value: decorate?.(result.value) ?? result.value } : result
        },
      }
      const registration = registry.registrar.register(definition, { instanceId: 'fixture', configRevision }, { ...config, ...overrides })
      const ready = await registration.ready
      if (!ready.ok) throw new Error(ready.code)
      return { registry, pin: ready.value }
    },
    complete(id: string, spec: MediaSpec, corrupt = false) {
      const item = pending.get(id) ?? running.get(id)
      if (!item) throw new Error('Expected the original queued prompt')
      const filename = spec.modality === 'image' ? 'fixture.png' : 'fixture.mp4'
      const file = join(directory, filename)
      const args = spec.modality === 'image' ? ['-frames:v', '1', '-threads', '1', '-update', '1']
        : ['-c:v', 'mpeg4', '-t', '0.5', '-threads', '1']
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=16x16:r=10', ...args, file])
      const bytes = readFileSync(file)
      outputs.set(filename, corrupt ? bytes.subarray(0, 8) : bytes)
      pending.delete(id)
      running.delete(id)
      history.set(id, { prompt: item, status: { status_str: 'success', completed: true },
        outputs: { '2': { [spec.modality === 'image' ? 'images' : 'videos']: [{ filename, subfolder: '', type: 'output' }] } } })
      return bytes
    },
    fail(id: string) {
      const item = pending.get(id)
      if (!item) throw new Error('Expected an accepted prompt')
      pending.delete(id)
      history.set(id, { prompt: item, status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_type: 'OutOfMemoryError' }]] }, outputs: {} })
    },
  }
}

export function mediaRequest(spec: MediaSpec = imageSpec) {
  return {
    access: { ownerId: 'media-owner', profileId: 'media-profile', taskId: 'media-task', attemptId: 'media-attempt', generation: 0 },
    operationId: 'render-1', workflowId: spec.modality, workflowVersion: '1', model: 'local-model', spec, prompt: 'A blue square',
  }
}

export function accepted<T>(result: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!result.ok) throw new Error('Expected success, got ' + result.code)
  return result.value
}
