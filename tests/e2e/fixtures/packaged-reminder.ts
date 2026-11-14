import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, vi } from 'vitest'
import type { InboxRequest, InboxResponse } from '../../../packages/personal-agent/src/inbox/protocol.js'

interface Resident {
  inbox(request: InboxRequest): Promise<InboxResponse>
  stop(): Promise<void>
}

export async function verifyPackagedReminder(first: Resident, restart: () => Promise<Resident>, database: string) {
  async function snapshot(host: Resident) {
    const result = await host.inbox({ type: 'snapshot' })
    assert.ok(result.ok && result.kind === 'snapshot' && result.snapshot.schedules, JSON.stringify(result))
    expect(result.snapshot.tasks).toEqual([])
    expect(result.snapshot.usage).toMatchObject({ calls: 0, workerSlots: { active: 0 }, attention: { unsolicited: 0 } })
    expect(result.snapshot.sessions.some(session => session.id.startsWith('dshpa-routine-sink-'))).toBe(false)
    return result.snapshot.schedules
  }

  function query(sql: string, routineId: string) {
    const db = new DatabaseSync(database, { readOnly: true })
    try { return db.prepare(sql).all(routineId) } finally { db.close() }
  }
  const mappings = (routineId: string) => query(`SELECT routine_revision AS revision, state,
    native_id AS nativeId, intended_at AS intendedAt, record ->> '$.terminalReason' AS reason
    FROM routine_mappings WHERE routine_id = ? ORDER BY routine_revision`, routineId)
  const occurrences = (routineId: string) => query(`SELECT id, routine_revision AS revision, kind, intended_at AS intendedAt,
    mapping_id AS mappingId, record ->> '$.status' AS status
    FROM routine_occurrences WHERE routine_id = ?`, routineId)

  const title = 'Confirm the fictional library delivery'
  const originalTime = new Date(Date.now() + 12_000).toISOString()
  const revisedTime = new Date(Date.parse(originalTime) + 4_000).toISOString()
  const originalText = 'Collect the delivery from the front desk.'
  const revisedText = 'Collect the delivery from the east entrance.'
  const draft = {
    title, timing: { kind: 'at', at: originalTime }, misfire: 'latest', target: { kind: 'reminder', text: originalText },
  } as const
  expect(await first.inbox({ type: 'save_routine', commandId: 'packaged-reminder-draft', draft })).toMatchObject({ ok: true })
  const { routines, reminders } = await snapshot(first)
  expect(reminders).toEqual([])
  expect(routines).toHaveLength(1)
  const [initial] = routines
  assert.ok(initial && initial.state === 'draft')
  const arm = { type: 'arm_routine', commandId: 'packaged-reminder-arm-original', routineId: initial.id,
    expectedRevision: initial.revision } as const
  expect(await first.inbox(arm)).toMatchObject({ ok: true })
  const originalRevision = initial.revision + 1
  await vi.waitFor(() => expect(mappings(initial.id)).toEqual([expect.objectContaining({ revision: originalRevision,
    state: 'bound', nativeId: expect.any(String), intendedAt: originalTime })]), { timeout: 5_000 })

  expect(await first.inbox({ type: 'save_routine', commandId: 'packaged-reminder-edit', routineId: initial.id,
    expectedRevision: originalRevision, draft: { ...draft, timing: { kind: 'at', at: revisedTime },
      target: { kind: 'reminder', text: revisedText } } })).toMatchObject({ ok: true })
  const edit = (await snapshot(first)).routines[0]
  expect(edit).toMatchObject({ id: initial.id, revision: originalRevision + 1, state: 'draft',
    timing: { kind: 'at', at: revisedTime }, target: { kind: 'reminder', text: revisedText } })
  const rearm = { ...arm, commandId: 'packaged-reminder-arm-edit' }
  expect(await first.inbox({ ...rearm, expectedRevision: originalRevision })).toEqual({ ok: false, code: 'version_conflict' })
  expect((await snapshot(first)).routines[0]).toEqual(edit)
  expect(await first.inbox({ ...rearm, expectedRevision: originalRevision + 1 })).toMatchObject({ ok: true })
  const currentRevision = originalRevision + 2
  await vi.waitFor(() => {
    expect(mappings(initial.id)).toEqual([
      expect.objectContaining({ revision: originalRevision, state: 'terminal', reason: 'cancelled', intendedAt: originalTime }),
      expect.objectContaining({ revision: currentRevision, state: 'bound', nativeId: expect.any(String), intendedAt: revisedTime }),
    ])
  }, { timeout: 5_000 })
  expect((await snapshot(first)).reminders).toEqual([])
  await first.stop()
  expect(Date.now()).toBeLessThan(Date.parse(originalTime))
  expect(occurrences(initial.id)).toEqual([])
  await delay(Math.max(0, Date.parse(revisedTime) - Date.now() + 500))
  expect(Date.now()).toBeGreaterThan(Date.parse(revisedTime))
  expect(occurrences(initial.id)).toEqual([])

  const recovered = await restart()
  const restored = await vi.waitFor(async () => {
    const state = await snapshot(recovered)
    expect(state.reminders).toEqual([expect.objectContaining({ title, text: revisedText, intendedAt: revisedTime })])
    expect(state.routines).toEqual([expect.objectContaining({ id: initial.id, revision: currentRevision, state: 'ended',
      last: expect.objectContaining({ status: 'reminded' }) })])
    return state
  }, { timeout: 12_000 })
  const reminder = restored.reminders[0]!
  expect(Date.parse(reminder.deliveredAt)).toBeGreaterThan(Date.parse(revisedTime))
  const receipts = occurrences(initial.id)
  expect(receipts).toEqual([{ id: reminder.id, revision: currentRevision, kind: 'scheduled', intendedAt: revisedTime,
    mappingId: expect.any(String), status: 'reminded' }])
  await recovered.stop()

  const reopened = await restart()
  expect(await snapshot(reopened)).toEqual(restored)
  await reopened.stop()
  expect(occurrences(initial.id)).toEqual(receipts)
  console.log(JSON.stringify({ routineId: initial.id, originalRevision, currentRevision, originalTime, ...reminder }))
}
