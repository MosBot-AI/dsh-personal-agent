import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createNativeProfile, nativeAgentRows, nativeProfileTimeoutMs, nativeSessionPersistenceRows } from '../contracts/native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/compute-probe.mjs', import.meta.url))

describe('metered native provider admission', () => {
  it('meters actual prepared Worker calls and direct Router assessment before provider handoff', () => {
    const profile = createNativeProfile({
      probe,
      patchRows: [...nativeAgentRows, ...nativeSessionPersistenceRows,
        '    - id: llm-retry', '      name: "@deepseek-ai/dsh-llm-retry"'],
    })
    try {
      const result = profile.run()
      expect(result.signal, result.stderr).toBeNull()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('PA013_PINNED_COMPUTE_GATES_PASS')
    } finally {
      profile.dispose()
    }
  }, nativeProfileTimeoutMs + 1_000)
})
