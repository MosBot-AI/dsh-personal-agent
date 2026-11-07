import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createNativeProfile,
  nativeAgentRows,
  nativeProfileTimeoutMs,
  nativeSessionPersistenceRows,
} from './native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/schedule-host-probe.mjs', import.meta.url))
const sessionId = 'schedule-host-session'
const crashExitCode = 86
const timeoutMs = 2 * nativeProfileTimeoutMs + 1_000

function scheduleProfile() {
  return createNativeProfile({
    probe,
    patchRows: [
      ...nativeAgentRows,
      ...nativeSessionPersistenceRows,
      '    - id: storage',
      '      name: "@deepseek-ai/dsh-storage"',
      '    - id: storage-json',
      '      name: "@deepseek-ai/dsh-storage-json"',
      '      config:',
      "        root: !!js dshHomePath('storages')",
      '    - id: storage-domain',
      '      name: "@deepseek-ai/dsh-storage-domain"',
      '      config: { backend: json }',
    ],
    // The embedding must register the target resolver before overdue delivery starts.
    trailingRows: [
      '    - id: schedule',
      '      name: "@deepseek-ai/dsh-schedule"',
    ],
  })
}

function readReport(result: ReturnType<ReturnType<typeof scheduleProfile>['run']>, status = 0) {
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(status)
  const line = result.stdout.split('\n').find(value => value.startsWith('DSHPA_SCHEDULE '))
  expect(line, result.stderr).toBeDefined()
  return JSON.parse(line!.slice('DSHPA_SCHEDULE '.length))
}

describe('native DSH schedule', () => {
  it('acknowledges a timed occurrence only after the inbox flush and preserves its receipt on restart', () => {
    const profile = scheduleProfile()
    try {
      const first = readReport(profile.run('deliver'))
      expect(first).toMatchObject({ phase: 'deliver', statusAtFlush: 'active', status: 'ended' })
      expect(first.messageIds).toEqual([first.receipt.messageId])
      expect(first.receipt).toMatchObject({ targetSessionId: sessionId, scheduledAt: first.scheduledAt })

      const restarted = readReport(profile.run('restart-committed'))
      expect(restarted).toMatchObject({
        phase: 'restart-committed',
        id: first.id,
        status: 'ended',
        messageIds: first.messageIds,
        receipt: first.receipt,
      })
    } finally {
      profile.dispose()
    }
  }, timeoutMs)

  it('replays the same occurrence with a second inbox message when the host exits before saving its receipt', () => {
    const profile = scheduleProfile()
    try {
      const crashed = readReport(profile.run('interrupt-flush'), crashExitCode)
      expect(crashed).toMatchObject({ phase: 'interrupt-flush', statusAtFlush: 'active' })
      expect(crashed.messageIds).toHaveLength(1)

      const restarted = readReport(profile.run('restart-interrupted'))
      expect(restarted).toMatchObject({
        phase: 'restart-interrupted',
        id: crashed.id,
        status: 'ended',
        receipt: { targetSessionId: sessionId, scheduledAt: crashed.scheduledAt },
      })
      expect(restarted.receipt.messageId).not.toBe(crashed.messageIds[0])
      expect(restarted.messageIds).toEqual([crashed.messageIds[0], restarted.receipt.messageId])
    } finally {
      profile.dispose()
    }
  }, timeoutMs)
})
