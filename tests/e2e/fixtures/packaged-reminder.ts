import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, vi } from 'vitest'
import type { InboxRequest, InboxResponse } from '../../../packages/personal-agent/src/inbox/protocol.js'

interface Resident {
  rpc<T>(method: string, payload: unknown): Promise<T>
  inbox(request: InboxRequest): Promise<InboxResponse>
  stop(): Promise<void>
}

function reminderFixture() {
  const originalTime = new Date(Date.now() + 12_000).toISOString()
  return {
    title: 'Confirm the fictional library delivery',
    originalTime,
    revisedTime: new Date(Date.parse(originalTime) + 4_000).toISOString(),
    originalText: 'Collect the delivery from the front desk.',
    revisedText: 'Collect the delivery from the east entrance.',
  }
}

async function waitPastDue(revisedTime: string) {
  const due = Date.parse(revisedTime)
  await delay(Math.max(0, due - Date.now() + 500))
  expect(Date.now()).toBeGreaterThan(due)
}

interface NativeReceipt {
  messageId: string
  targetSessionId: string
  scheduledAt: string
  deliveredAt: string
}

interface NativeSchedule {
  id: string
  status: 'active' | 'ended'
  updatedAt: string
  lastDelivery?: NativeReceipt
}

export async function verifyForegroundReminder(first: Resident, restart: () => Promise<Resident>, workRoot: string) {
  const { sessionId } = await first.rpc<{ sessionId: string }>('session/create', { args: { request: { cwd: workRoot } } })
  assert.ok(sessionId)
  const { title, originalTime, revisedTime, originalText, revisedText } = reminderFixture()
  const target = { kind: 'session', sessionId }
  const original = await first.rpc<NativeSchedule>('schedule/create', { args: { request: {
    title, prompt: originalText, timing: { kind: 'at', at: originalTime }, target,
  } } })
  expect(original).toMatchObject({ id: expect.any(String), updatedAt: expect.any(String),
    status: 'active', title, prompt: originalText, scheduledAt: originalTime, target })
  const { id } = original
  const history = (host: Resident) => host.rpc<{ records: Array<NativeReceipt & { prompt: string }> }>(
    'schedule/history', { args: { request: { id, limit: 10 } } })
  const view = (host: Resident) => host.rpc<NativeSchedule>('schedule/view', { args: { request: { id } } })
  const edit = { id, action: 'update', expectedUpdatedAt: original.updatedAt }
  const revised = await first.rpc<NativeSchedule>('schedule/edit', { args: { request: {
    ...edit, patch: { prompt: revisedText, timing: { kind: 'at', at: revisedTime } },
  } } })
  expect(revised).toMatchObject({ id, status: 'active', title, prompt: revisedText, scheduledAt: revisedTime, target })
  expect(revised.updatedAt).not.toBe(original.updatedAt)
  expect(await first.rpc('schedule/edit', { args: { request: { ...edit, patch: { prompt: originalText } } } }))
    .toEqual({ id, code: 'schedule_conflict' })
  expect(await history(first)).toMatchObject({ records: [] })
  await first.stop()
  expect(Date.now()).toBeLessThan(Date.parse(originalTime))
  await waitPastDue(revisedTime)

  async function readDelivery(host: Resident) {
    const schedule = await view(host)
    expect(schedule).toMatchObject({ id, status: 'ended', title, prompt: revisedText, scheduledAt: revisedTime, target })
    const receipt = schedule.lastDelivery
    assert.ok(receipt)
    expect(receipt).toMatchObject({ targetSessionId: sessionId, scheduledAt: revisedTime, messageId: expect.any(String) })
    expect(await history(host)).toMatchObject({ records: [{ ...receipt, prompt: revisedText }] })
    const page = await host.rpc<{ records: { event: { type: string; data: {
      inserted?: { id: string; source: { kind: string }; content: { text?: string }[] }[]
    } } }[] }>('session/page', { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 20 } } })
    const delivery = page.records.flatMap(({ event }) => event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : [])
      .filter(message => message.source.kind === 'schedule')
      .map(message => ({ id: message.id, text: message.content.map(block => block.text).join('') }))
      .filter(message => message.text.startsWith('[SCHEDULE REMINDER]\n'))
    expect(delivery.map(message => message.id)).toEqual([receipt.messageId])
    expect(delivery[0]!.text.split('\n')).toEqual(expect.arrayContaining([
      `schedule_id_json: ${JSON.stringify(id)}`,
      `occurrence_at: ${revisedTime}`,
      `reminder_prompt_json: ${JSON.stringify(revisedText)}`,
    ]))
    return receipt
  }

  const startedAt = performance.now()
  const recovered = await restart()
  const receipt = await vi.waitFor(() => readDelivery(recovered), { timeout: 12_000 })
  const restartReadbackMs = Math.round(performance.now() - startedAt)
  const deliveryDelayMs = Date.parse(receipt.deliveredAt) - Date.parse(revisedTime)
  expect(deliveryDelayMs).toBeGreaterThan(0)
  await recovered.stop()
  const reopened = await restart()
  expect(await readDelivery(reopened)).toEqual(receipt)
  await reopened.stop()
  return { restartReadbackMs, deliveryDelayMs, ownerCommands: 2 }
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

  const { title, originalTime, revisedTime, originalText, revisedText } = reminderFixture()
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
  await waitPastDue(revisedTime)
  expect(occurrences(initial.id)).toEqual([])

  const startedAt = performance.now()
  const recovered = await restart()
  const restored = await vi.waitFor(async () => {
    const state = await snapshot(recovered)
    expect(state.reminders).toEqual([expect.objectContaining({ title, text: revisedText, intendedAt: revisedTime })])
    expect(state.routines).toEqual([expect.objectContaining({ id: initial.id, revision: currentRevision, state: 'ended',
      last: expect.objectContaining({ status: 'reminded' }) })])
    return state
  }, { timeout: 12_000 })
  const reminder = restored.reminders[0]!
  const restartReadbackMs = Math.round(performance.now() - startedAt)
  const deliveryDelayMs = Date.parse(reminder.deliveredAt) - Date.parse(revisedTime)
  expect(deliveryDelayMs).toBeGreaterThan(0)
  const receipts = occurrences(initial.id)
  expect(receipts).toEqual([{ id: reminder.id, revision: currentRevision, kind: 'scheduled', intendedAt: revisedTime,
    mappingId: expect.any(String), status: 'reminded' }])
  await recovered.stop()

  const reopened = await restart()
  expect(await snapshot(reopened)).toEqual(restored)
  await reopened.stop()
  expect(occurrences(initial.id)).toEqual(receipts)
  return { routineId: initial.id, originalRevision, currentRevision, originalTime, originalText, ...reminder,
    restartReadbackMs, deliveryDelayMs, ownerCommands: 4 }
}
