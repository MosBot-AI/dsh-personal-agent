import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createNativeProfile,
  nativeAgentRows,
  nativeProfileTimeoutMs,
  nativeSessionPersistenceRows,
} from '../contracts/native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/private-worker-probe.mjs', import.meta.url))

describe('native private worker tool isolation', () => {
  it('blocks native, late scoped, and PTC calls on create and resume without affecting ordinary agents', () => {
    const profile = createNativeProfile({
      probe,
      patchRows: [...nativeAgentRows, ...nativeSessionPersistenceRows],
    })
    try {
      for (const phase of ['create', 'resume']) {
        const result = profile.run(phase)
        expect(result.signal, result.stderr).toBeNull()
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toBe(`DSHPA_PRIVATE_WORKER ${phase}`)
      }
    } finally {
      profile.dispose()
    }
  }, nativeProfileTimeoutMs * 2 + 1_000)

  it('fails closed before agent creation or resume when the tools service is unavailable', () => {
    const profile = createNativeProfile({
      probe,
      patchRows: [
        '    - id: session-projection',
        '      name: "@deepseek-ai/dsh-session-projection"',
        '    - id: agent',
        '      name: "@deepseek-ai/dsh-agent"',
      ],
    })
    try {
      const result = profile.run('missing-tools')
      expect(result.signal, result.stderr).toBeNull()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('DSHPA_PRIVATE_WORKER missing-tools')
    } finally {
      profile.dispose()
    }
  }, nativeProfileTimeoutMs + 1_000)
})
