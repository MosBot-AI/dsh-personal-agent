import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createNativeProfile, nativeAgentRows, nativeProfileTimeoutMs } from '../contracts/native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/local-executor-probe.mjs', import.meta.url))

it('admits the lease-gated definition and blocks native, program and late scoped bypasses in DSH', () => {
  const profile = createNativeProfile({ probe, patchRows: nativeAgentRows })
  try {
    const result = profile.run('exact')
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('PA031_LOCAL_EXECUTOR exact')
  } finally { profile.dispose() }
}, nativeProfileTimeoutMs + 1_000)
