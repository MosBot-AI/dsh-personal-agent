import { readFileSync } from 'node:fs'
import { sameMediaAccess } from '@mosbot-ai/dshpa-plugin-api'
import { comfyMediaProvider } from '../../../packages/media-comfyui/lib/index.js'
import { mediaServiceConfigSchema } from '../../../packages/personal-agent/lib/media/jobs.js'
import { createCapabilityRegistry } from '../../../packages/personal-agent/lib/runtime/capability-registry.js'
import { openWorkStore } from '../../../packages/personal-agent/lib/storage/store.js'

const { directory, config, ref } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const steps = Number(process.argv[3])
const registry = createCapabilityRegistry()
const store = openWorkStore(directory)
try {
  const registration = registry.registrar.register(comfyMediaProvider, { instanceId: 'fixture', configRevision: 1 }, config)
  const provider = await registration.ready
  if (!provider.ok) throw new Error(provider.code)
  const jobs = store.createMediaJobs(registry, mediaServiceConfigSchema.parse({ providers: { image: provider.value } }), {
    current: scope => sameMediaAccess(ref.access, scope),
    artifactAllowed: () => false,
  })
  try {
    for (let step = 0; step < steps; step++) await jobs.step()
    process.stdout.write(JSON.stringify(jobs.inspect(ref)))
  } finally {
    await jobs.close()
  }
} finally {
  await registry.close()
  store.close()
}
