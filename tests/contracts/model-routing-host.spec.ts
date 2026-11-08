import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createNativeProfile, nativeAgentRows, nativeProfileTimeoutMs, nativeSessionPersistenceRows } from './native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/model-routing-host-probe.mjs', import.meta.url))
const routing = fileURLToPath(new URL('../../packages/model-routing/', import.meta.url))
const api = fileURLToPath(new URL('../../packages/plugin-api/', import.meta.url))

it('captures DSH selection before assembly and retry, and reroutes through a fresh budgeted request series', () => {
  const profile = createNativeProfile({
    probe, patchRows: [...nativeAgentRows, ...nativeSessionPersistenceRows],
    localPackages: [{ directory: routing }, { directory: api }],
  })
  try {
    const result = profile.run('model-routing')
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('PA040_NATIVE_ROUTING pinned retry fresh-series')
  } finally { profile.dispose() }
}, nativeProfileTimeoutMs + 1_000)
