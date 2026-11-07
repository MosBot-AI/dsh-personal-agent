import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createNativeProfile, nativeAgentRows, nativeProfileTimeoutMs, nativeSessionPersistenceRows,
} from '../contracts/native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/provider-outage-probe.mjs', import.meta.url))

describe('resident native Worker provider faults', () => {
  it('parks the exact Worker, fences late outcomes, and reports diagnostics without provider content', () => {
    const profile = createNativeProfile({
      probe,
      patchRows: [...nativeAgentRows, ...nativeSessionPersistenceRows,
        '    - id: jobs', '      name: "@deepseek-ai/dsh-jobs-local"',
        '    - id: llm-retry', '      name: "@deepseek-ai/dsh-llm-retry"'],
    })
    try {
      const result = profile.run()
      expect(result.signal, result.stderr).toBeNull()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('PA021_NATIVE_PROVIDER_PASS')
    } finally {
      profile.dispose()
    }
  }, nativeProfileTimeoutMs + 1_000)
})
