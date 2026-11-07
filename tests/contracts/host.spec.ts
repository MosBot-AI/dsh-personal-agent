import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createNativeProfile,
  nativeAgentRows,
  nativeProfileTimeoutMs,
  nativeSessionPersistenceRows,
} from './native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/host-probe.mjs', import.meta.url))

describe('pinned DSH agent host', () => {
  it('controls native turns, enforces a scoped tool guard, and resumes the flushed session', () => {
    const profile = createNativeProfile({
      probe,
      patchRows: [...nativeAgentRows, ...nativeSessionPersistenceRows],
    })
    try {
      for (const phase of ['create', 'resume']) {
        const result = profile.run(phase)
        expect(result.signal, result.stderr).toBeNull()
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toBe(`DSHPA_HOST ${phase}`)
      }
    } finally {
      profile.dispose()
    }
  }, nativeProfileTimeoutMs * 2 + 1_000)

  it('rejects missing durability and propagates a native flush failure', () => {
    const profile = createNativeProfile({ probe, patchRows: nativeAgentRows })
    try {
      const result = profile.run('no-persistence')
      expect(result.signal, result.stderr).toBeNull()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('DSHPA_HOST no-persistence')
    } finally {
      profile.dispose()
    }
  }, nativeProfileTimeoutMs + 1_000)
})
