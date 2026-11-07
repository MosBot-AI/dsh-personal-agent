import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createNativeProfile,
  nativeAgentRows,
  nativeProfileTimeoutMs,
  nativeSessionPersistenceRows,
} from '../contracts/native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/executor-probe.mjs', import.meta.url))
const patchRows = [
  ...nativeAgentRows,
  ...nativeSessionPersistenceRows,
  ...[
    ['jobs', 'dsh-jobs-local'],
    ['filesystem', 'dsh-fs-local'],
    ['working-directory', 'dsh-working-directory'],
    ['subagent', 'dsh-subagent'],
  ].flatMap(([id, name]) => [`    - id: ${id}`, `      name: '@deepseek-ai/${name}'`]),
]

function runPhases(...phases: string[]) {
  const profile = createNativeProfile({ probe, patchRows })
  try {
    for (const phase of phases) {
      const result = profile.run(phase)
      expect(result.signal, result.stderr).toBeNull()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(`DSHPA_WORKER ${phase}`)
    }
  } finally {
    profile.dispose()
  }
}

describe('bounded native DSH workers', () => {
  it('keeps foreground control responsive with four held streams and isolates cancellation', () => {
    runPhases('controls')
  }, nativeProfileTimeoutMs + 1_000)

  it('drains owned work before releasing a waiting slot and resumes from persisted worker metadata', () => {
    runPhases('wait', 'resume')
  }, 2 * nativeProfileTimeoutMs + 1_000)
})
