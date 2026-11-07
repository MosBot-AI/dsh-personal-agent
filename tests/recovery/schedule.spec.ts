import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createNativeProfile, nativeAgentRows, nativeProfileTimeoutMs, nativeSessionPersistenceRows,
} from '../contracts/native-profile.js'

const probe = fileURLToPath(new URL('./fixtures/native-schedule-crash.mjs', import.meta.url))

function createScheduleProfile() {
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
      '    - id: schedule',
      '      name: "@deepseek-ai/dsh-schedule"',
      '      inject: [dshpaScheduleResolverReady, dshpaScheduleTestReady]',
    ],
  })
}

function report(profile: ReturnType<typeof createScheduleProfile>, phase: string, status = 0) {
  const result = profile.run(phase)
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(status)
  const line = result.stdout.split('\n').find(value => value.startsWith('PA018_NATIVE '))
  expect(line, result.stderr).toBeDefined()
  return JSON.parse(line!.slice('PA018_NATIVE '.length))
}

describe('native routine recovery', () => {
  it('adopts a real native schedule left unbound by abrupt exit and records its occurrence once', () => {
    const profile = createScheduleProfile()
    try {
      const crash = report(profile, 'create-crash', 88)
      const recovered = report(profile, 'recover-created')
      expect(recovered).toMatchObject({ phase: 'recover-created', nativeId: crash.nativeId,
        intendedAt: crash.intendedAt, nativeRows: 0, occurrences: 1, preparations: 0, streams: 0 })
      expect(recovered.messageId).toBeTruthy()
    } finally {
      profile.dispose()
    }
  }, 2 * nativeProfileTimeoutMs + 1_000)

  it('recovers an exact saved native receipt before application commit and fences the disabled sink', () => {
    const profile = createScheduleProfile()
    try {
      const crash = report(profile, 'receipt-crash', 89)
      expect(report(profile, 'retire-crash', 90)).toMatchObject({ phase: 'retire-crash', nativeId: crash.nativeId,
        intendedAt: crash.intendedAt, messageId: crash.messageId, occurrences: 1 })
      const recovered = report(profile, 'recover-receipt')
      expect(recovered).toMatchObject({ phase: 'recover-receipt', nativeId: crash.nativeId,
        intendedAt: crash.intendedAt, messageId: crash.messageId,
        nativeRows: 0, occurrences: 1, preparations: 0, streams: 0 })
      expect(report(profile, 'verify-disabled')).toMatchObject({ phase: 'verify-disabled',
        reservedResumeDenied: true, fallbackCalls: 0, ordinaryAgentAvailable: true, preparations: 0, streams: 0 })
    } finally {
      profile.dispose()
    }
  }, 4 * nativeProfileTimeoutMs + 1_000)

  it('holds an unbound mapping when its native marker survives an outside edit', () => {
    const profile = createScheduleProfile()
    try {
      const crash = report(profile, 'create-crash', 88)
      expect(report(profile, 'recover-tampered')).toMatchObject({ phase: 'recover-tampered', nativeId: crash.nativeId,
        nativeRows: 1, occurrences: 0, mappingState: 'uncertain' })
    } finally {
      profile.dispose()
    }
  }, 2 * nativeProfileTimeoutMs + 1_000)

  it('keeps a raw native Run Now receipt out of timed application intake', () => {
    const profile = createScheduleProfile()
    try {
      expect(report(profile, 'manual-native')).toMatchObject({ phase: 'manual-native', nativeRows: 1,
        nativeReceipt: true, occurrences: 0, preparations: 0, streams: 0 })
    } finally {
      profile.dispose()
    }
  }, nativeProfileTimeoutMs + 1_000)

  it('retires only the exact active native row after an owner pauses the application revision', () => {
    const profile = createScheduleProfile()
    try {
      expect(report(profile, 'pause-native')).toMatchObject({ phase: 'pause-native', nativeRows: 0,
        unrelatedRows: 1, occurrences: 0, preparations: 0, streams: 0 })
    } finally {
      profile.dispose()
    }
  }, nativeProfileTimeoutMs + 1_000)
})
