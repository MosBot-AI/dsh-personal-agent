import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createNativeProfile, nativeProfileTimeoutMs } from './native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/bundle-probe.mjs', import.meta.url))
const agentRows = [
  '    - id: session-projection',
  "      name: '@deepseek-ai/dsh-session-projection'",
  '    - id: agent',
  "      name: '@deepseek-ai/dsh-agent'",
]

function runProfile(scenario: 'normal' | 'missing-agents' | 'wrong-version') {
  const profile = createNativeProfile({
    probe,
    patchRows: scenario === 'missing-agents' ? [] : agentRows,
    requiredDshVersion: scenario === 'wrong-version' ? '999.0.0' : undefined,
  })
  try {
    const result = profile.run()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    return result
  } finally {
    profile.dispose()
  }
}

describe('native dshpa profile', () => {
  it('mounts the built bundle and removes its service when the DSH Loader unloads it', () => {
    const result = runProfile('normal')
    expect(result.stdout).toBe('DSHPA_LOADED\nDSHPA_DISPOSED')
    expect(result.stderr).not.toContain('did not activate')
  }, nativeProfileTimeoutMs + 1_000)

  it('leaves the bundle inactive and diagnoses a missing agents service', () => {
    const result = runProfile('missing-agents')
    expect(result.stdout).toBe('DSHPA_ABSENT')
    expect(result.stderr).toMatch(/dshpa .*waiting for service: agents/)
  }, nativeProfileTimeoutMs + 1_000)

  it('rejects a plugin that requires an incompatible DSH version', () => {
    const result = runProfile('wrong-version')
    expect(result.stdout).toBe('DSHPA_ABSENT')
    expect(result.stderr).toContain('disabling profile plugin row "dshpa"')
    expect(result.stderr).toContain('incompatible with dsh 0.2.2-rc.1')
    expect(result.stderr).toContain('999.0.0')
  }, nativeProfileTimeoutMs + 1_000)
})
