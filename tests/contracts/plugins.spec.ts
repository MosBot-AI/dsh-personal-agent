import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createNativeProfile, nativeAgentRows, nativeProfileTimeoutMs } from './native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/plugin-probe.mjs', import.meta.url))
const directory = (path: string) => fileURLToPath(new URL(`../../${path}/`, import.meta.url))

describe('external DSH capability packages', () => {
  it('loads the independent providers, preserves snapshots and pins, then drains a native plugin fiber', () => {
    const profile = createNativeProfile({ probe, patchRows: nativeAgentRows, localPackages: [
      { directory: directory('packages/plugin-testkit') },
      { directory: directory('examples/plugins/memory-local'), bundle: true },
      { directory: directory('examples/plugins/media-mock'), bundle: true },
    ] })
    try {
      const result = profile.run()
      expect(result.signal, result.stderr).toBeNull()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('DSHPA_PLUGIN_CONTRACTS_PASSED')
    } finally { profile.dispose() }
  }, nativeProfileTimeoutMs + 1_000)
})
