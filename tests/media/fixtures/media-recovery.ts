import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { mediaOutputsSchema, mediaSubmitRequestSchema, preparedMediaSubmissionSchema, sameMediaAccess } from '@mosbot-ai/dshpa-plugin-api'
import { expect } from 'vitest'
import { comfyMediaProvider } from '../../../packages/media-comfyui/src/index.js'
import { mediaServiceConfigSchema } from '../../../packages/personal-agent/src/media/jobs.js'
import { createCapabilityRegistry } from '../../../packages/personal-agent/src/runtime/capability-registry.js'
import { DATABASE_FILENAME } from '../../../packages/personal-agent/src/storage/database.js'
import { openWorkStore } from '../../../packages/personal-agent/src/storage/store.js'
import { createAttempt } from '../work-fixture.js'
import { openMediaRecoveryRelay } from './media-recovery-relay.js'

const run = promisify(execFile)
const child = fileURLToPath(new URL('./media-caller.mjs', import.meta.url))
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function committedPrompt(path: string, body: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT state, request, digest, prepared FROM media_jobs').get()
    if (row?.state !== 'submitting' || row.digest !== sha256(String(row.request))) {
      throw new Error('The caller did not commit the request before dispatch')
    }
    const { handle, workflowDigest } = preparedMediaSubmissionSchema.parse(JSON.parse(String(row.prepared)))
    if (handle.handleId !== JSON.parse(body).prompt_id || workflowDigest !== sha256(body)) {
      throw new Error('The submitted prompt differs from the committed prompt')
    }
    return handle.handleId
  } finally { db.close() }
}

export async function verifyComfyRecovery(rawConfig: unknown) {
  const backend = comfyMediaProvider.configSchema.parse(rawConfig)
  if (backend.workflows.length !== 1) throw new Error('The acceptance config must contain one approved workflow')
  const workflow = backend.workflows[0]!
  const root = mkdtempSync(join(tmpdir(), 'dshpa-comfy-acceptance-'))
  const directory = join(root, 'work')
  let relay: Awaited<ReturnType<typeof openMediaRecoveryRelay>> | undefined
  let verified = false
  const registry = createCapabilityRegistry()
  try {
    relay = await openMediaRecoveryRelay(backend.origin, body => committedPrompt(join(directory, DATABASE_FILENAME), body))
    const config = { ...backend, origin: relay.origin }
    const registration = registry.registrar.register(comfyMediaProvider, { instanceId: 'fixture', configRevision: 1 }, config)
    const mounted = await registration.ready
    if (!mounted.ok) throw new Error(mounted.code)
    const pin = mounted.value
    const health = await registry.health(pin)
    if (!health.ok || health.value.status !== 'ready') {
      throw new Error('The configured ComfyUI is not ready for acceptance')
    }

    const modality = workflow.spec.modality
    const queue = mediaServiceConfigSchema.parse({ providers: { [modality]: pin }, maxQueued: 1, maxPerAttempt: 1 })
    const store = openWorkStore(directory)
    let ref
    try {
      const access = createAttempt(store, 'comfy-acceptance')
      ref = { access, operationId: 'comfy-acceptance-render' }
      const jobs = store.createMediaJobs(registry, queue, { current: scope => sameMediaAccess(access, scope), artifactAllowed: () => false })
      try {
        const request = mediaSubmitRequestSchema.parse({ ...ref, workflowId: workflow.id, workflowVersion: workflow.version,
          model: workflow.model, spec: workflow.spec, prompt: 'A blue square on a white background' })
        expect(jobs.enqueue(request)).toMatchObject({ ok: true, value: { state: 'queued' } })
      } finally { await jobs.close() }
    } finally { store.close() }

    const input = join(root, 'caller.json')
    writeFileSync(input, JSON.stringify({ directory, config, ref, modality }), { mode: 0o600 })
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
    const sender = await run(process.execPath, [child, input, '1'], { env, timeout: 90_000 })
    const acceptedId = relay.acceptedId
    if (!acceptedId) throw new Error(relay.failure ?? 'The relay did not observe an accepted ComfyUI prompt')
    expect(JSON.parse(sender.stdout)).toMatchObject({ ok: true, value: { state: 'unknown', handle: { handleId: acceptedId } } })

    const receiver = await run(process.execPath, [child, input, '1', '600000'], { env, timeout: 640_000 })
    const result = JSON.parse(receiver.stdout)
    expect(result).toMatchObject({ ok: true, value: { state: 'succeeded', handle: { handleId: acceptedId } } })
    expect(relay.submissions).toBe(1)
    const outputs = mediaOutputsSchema.parse(result.value.outputs)
    const fingerprints = (items: Iterable<{ contentHash: string; sizeBytes: number }>) =>
      [...items].map(item => `${item.contentHash}:${item.sizeBytes}`).sort()
    expect(fingerprints(outputs)).toEqual(fingerprints(relay.outputs.values()))
    verified = true
    return { promptId: acceptedId, submissions: relay.submissions, outputs }
  } finally {
    try { await registry.close() }
    finally {
      await relay?.close()
      if (verified || !relay?.submissions) rmSync(root, { recursive: true, force: true })
      else console.error('Acceptance stopped after a submit attempt. WorkStore preserved at ' + directory)
    }
  }
}
