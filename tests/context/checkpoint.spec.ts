import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createNativeProfile, nativeAgentRows, nativeProfileTimeoutMs, nativeSessionPersistenceRows } from '../contracts/native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/native-checkpoint-probe.mjs', import.meta.url))

function profile() {
  return createNativeProfile({ probe, patchRows: [...nativeAgentRows, ...nativeSessionPersistenceRows,
    '    - id: token-meter', '      name: "@deepseek-ai/dsh-token-meter"'] })
}

function report(host: ReturnType<typeof profile>, phase: string) {
  const result = host.run(phase)
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  const line = result.stdout.split('\n').find(value => value.startsWith('PA011_NATIVE_CHECKPOINT '))
  expect(line, result.stderr).toBeDefined()
  return JSON.parse(line!.slice('PA011_NATIVE_CHECKPOINT '.length))
}

describe('pinned native compaction and application checkpoints', () => {
  it('persists scoped context before ten native compactions and replays it after a cold process restart', () => {
    const host = profile()
    try {
      const live = report(host, 'write')
      expect(live).toMatchObject({ phase: 'write', managedCompactions: 10, managedSummaryCalls: 0, unrelatedSummaryCalls: 1,
        revision: 10 })
      expect(report(host, 'restart')).toMatchObject({ phase: 'restart', managedCompactions: 10, managedSummaryCalls: 0,
        revision: 10, checkpointId: live.checkpointId, continuedWithCheckpoint: true })
    } finally {
      host.dispose()
    }
  }, 2 * nativeProfileTimeoutMs + 1_000)

  it('leaves the managed surface intact when the SQLite checkpoint transaction fails', () => {
    const host = profile()
    try {
      expect(report(host, 'fail-write')).toMatchObject({ phase: 'fail-write', writeFailures: 2,
        replacementsDuringFailure: 0, managedSummaryCalls: 0, recoveredPrunes: 1 })
    } finally {
      host.dispose()
    }
  }, nativeProfileTimeoutMs + 1_000)
})
