import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { sameMediaAccess } from '@mosbot-ai/dshpa-plugin-api'
import { comfyMediaProvider } from '../../../packages/media-comfyui/lib/index.js'
import { mediaServiceConfigSchema } from '../../../packages/personal-agent/lib/media/jobs.js'
import { createCapabilityRegistry } from '../../../packages/personal-agent/lib/runtime/capability-registry.js'
import { openWorkStore } from '../../../packages/personal-agent/lib/storage/store.js'

const { directory, config, ref, modality = 'image' } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const steps = Number(process.argv[3])
const waitMs = Number(process.argv[4] ?? 0)
const terminal = new Set(['succeeded', 'failed', 'cancelled'])
const registry = createCapabilityRegistry()
const store = openWorkStore(directory)
try {
  const registration = registry.registrar.register(comfyMediaProvider, { instanceId: 'fixture', configRevision: 1 }, config)
  const provider = await registration.ready
  if (!provider.ok) throw new Error(provider.code)
  const jobs = store.createMediaJobs(registry, mediaServiceConfigSchema.parse({ providers: { [modality]: provider.value } }), {
    current: scope => sameMediaAccess(ref.access, scope),
    artifactAllowed: () => false,
  })
  try {
    for (let step = 0; step < steps; step++) await jobs.step()
    let result = jobs.inspect(ref)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline && result.ok && !terminal.has(result.value.state)) {
      await delay(1_000)
      await jobs.step()
      result = jobs.inspect(ref)
    }
    process.stdout.write(JSON.stringify(result))
  } finally {
    await jobs.close()
  }
} finally {
  await registry.close()
  store.close()
}
