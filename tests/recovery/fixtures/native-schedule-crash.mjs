import assert from 'node:assert/strict'
import { realpathSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createScheduleAdapter } from './node_modules/@mosbot-ai/dshpa/lib/runtime/schedule-adapter.js'
import { openWorkStore } from './node_modules/@mosbot-ai/dshpa/lib/storage/store.js'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'dshpaScheduleSink', 'agents', 'llm', 'sessions', 'sessionPersistence']

const scope = { ownerId: 'routine-fixture-owner', profileId: 'routine-fixture-profile' }
const routineId = 'native-recovery-routine'
const ref = { ...scope, routineId }
const authority = { clientId: 'fixture-client', deviceId: 'fixture-device', policyVersion: 'fixture-1',
  verifiedAt: '2026-01-01T00:00:00.000Z' }
const reminderText = 'Read the saved receipt without opening a model.'
const storageDirectory = join(process.env.DSH_HOME, 'routine-store')
const cwd = realpathSync(process.cwd())
const phase = process.env.DSHPA_CONTRACT_PHASE

function report(observation) {
  writeSync(1, `PA018_NATIVE ${JSON.stringify({ phase, ...observation })}\n`)
}

function adapterCounters(ctx) {
  let preparations = 0
  let streams = 0
  class Fixture extends LlmAdapter {
    async prepareCall() {
      preparations++
      throw new Error('A routine sink must never prepare a model call')
    }
    async *stream() {
      streams++
      throw new Error('A routine sink must never dispatch a model call')
    }
  }
  ctx.llm.registerAdapter(['dshpa-routine-sink'], new Fixture())
  return () => {
    assert.equal(preparations, 0)
    assert.equal(streams, 0)
    return { preparations, streams }
  }
}

async function eventually(observe) {
  const deadline = performance.now() + 5_000
  do {
    const value = await observe()
    if (value) return value
    await delay(10)
  } while (performance.now() < deadline)
  assert.fail('The real native receipt was not reconciled')
}

function verify(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result
}

async function verifyModelFreeDelivery(ctx, targetSessionId, messageId, prompt) {
  const agent = ctx.agents.get(targetSessionId)
  if (agent) {
    await agent.whenIdle()
    assert.equal(await ctx.sessions.flush(agent.session), true)
  }
  const reader = await ctx.sessionPersistence.open(targetSessionId, 'read')
  try {
    const { events } = await reader.read(0, 128)
    assert.ok(events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message =>
      message.id === messageId && message.source.kind === 'schedule'
      && message.content.some(block => block.type === 'text' && block.text.includes(`reminder_prompt_json: ${JSON.stringify(prompt)}`)
        && !block.text.includes(reminderText)))))
    assert.ok(events.every(event => event.type !== 'user/message' && event.type !== 'assistant/message'))
  } finally {
    await reader.close()
  }
}

function businessStore(store, counters) {
  if (phase !== 'receipt-crash') return store
  return new Proxy(store, {
    get(target, property) {
      if (property === 'completeRoutineOccurrence') return (scopeRef, input) => {
        assert.deepEqual(scopeRef, ref)
        assert.equal(target.listRoutineOccurrences(scope).length, 0)
        const { receipt, intendedAt } = input
        report({ nativeId: receipt.nativeId, messageId: receipt.messageId, intendedAt, ...counters() })
        process.exit(89)
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function nativeCarrier(port, store, counters) {
  if (phase === 'retire-crash') return {
    ...port,
    async retire(receipt) {
      const rows = store.listRoutineOccurrences(scope)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].nativeReceipt.messageId, receipt.messageId)
      report({ nativeId: receipt.nativeId, messageId: receipt.messageId, intendedAt: rows[0].intendedAt, occurrences: 1 })
      process.exit(90)
    },
  }
  if (phase !== 'create-crash') return port
  return {
    ...port,
    async create(request) {
      const entry = await port.create(request)
      const [mapping] = store.listRoutineMappings(scope)
      assert.equal(mapping.state, 'intent')
      assert.equal(mapping.nativeId, undefined)
      assert.equal(mapping.marker, entry.marker)
      assert.equal(store.listRoutineOccurrences(scope).length, 0)
      report({ nativeId: entry.id, intendedAt: mapping.intendedAt, ...counters() })
      process.exit(88)
    },
  }
}

async function verifyDisabled(ctx, counters) {
  const store = openWorkStore(storageDirectory)
  const id = store.listRoutineOccurrences(scope)[0]?.nativeReceipt?.targetSessionId
  store.close()
  assert.ok(id)
  assert.ok(id.startsWith('dshpa-routine-sink-'))
  let fallbackCalls = 0
  await assert.rejects(ctx.waterfall('schedule/resolve-agent', id, async () => {
    fallbackCalls++
    throw new Error('The stock fallback must not receive a reserved sink')
  }))
  assert.equal(fallbackCalls, 0)
  await assert.rejects(ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'dshpa-routine-sink', model: 'no-model' } }),
    /requires its private resolver/)
  assert.equal(ctx.agents.get(id), undefined)
  const ordinary = await ctx.agents.create({ sessionId: 'ordinary-routine-test', meta: { cwd } })
  assert.equal(ctx.agents.get(ordinary.agent.id), ordinary.agent)
  await ordinary.dispose()
  report({ reservedResumeDenied: true, fallbackCalls, ordinaryAgentAvailable: true, ...counters() })
}

async function run(ctx, counters) {
  if (phase === 'verify-disabled') return verifyDisabled(ctx, counters)
  const store = openWorkStore(storageDirectory)
  const port = ctx.dshpaScheduleSink.connect(ctx)
  const bridge = createScheduleAdapter({
    store: businessStore(store, counters), native: nativeCarrier(port, store, counters), currentAuthority: () => authority,
  })
  try {
    if (phase === 'recover-tampered') {
      const [entry] = await ctx.schedule.catalog()
      await ctx.schedule.edit({ id: entry.id, action: 'update', patch: { title: 'Changed by native management' } })
      const scan = await bridge.reconcile()
      assert.ok(scan.problems.some(problem => problem.code === 'changed_native'))
      const rows = await port.catalog()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].invalid, true)
      assert.equal(rows[0].id, entry.id)
      assert.deepEqual(store.listRoutineOccurrences(scope), [])
      const [mapping] = store.listRoutineMappings(scope)
      assert.equal(mapping.state, 'uncertain')
      report({ nativeId: entry.id, nativeRows: rows.length, occurrences: 0, mappingState: mapping.state })
      return
    }
    const control = phase === 'manual-native' || phase === 'pause-native'
    if (phase === 'create-crash' || phase === 'receipt-crash' || control) {
      const intendedAt = new Date(Date.now() + (control ? 120_000 : 1_250)).toISOString()
      const { routine } = verify(bridge.create(scope, { id: routineId, title: 'Native routine recovery',
        timing: { kind: 'at', at: intendedAt }, timeZone: 'UTC', localTimeIntent: intendedAt,
        dst: { gap: 'skip', overlap: 'earlier' }, misfire: 'latest', target: { kind: 'reminder', text: reminderText },
      }))
      assert.equal(routine.status, 'draft')
      assert.deepEqual(await port.catalog(), [], 'A draft must not arm a native schedule')
      const armed = verify(bridge.update(ref, { type: 'arm', expectedRevision: routine.revision }, authority)).routine
      if (phase === 'pause-native') {
        await bridge.reconcile()
        assert.equal((await port.catalog()).length, 1)
        const other = await ctx.agents.create({ sessionId: 'ordinary-pause-test', meta: { cwd } })
        try {
          const unrelated = await ctx.schedule.create({ title: 'Unrelated native wake', prompt: 'Ordinary note',
            target: { kind: 'session', sessionId: other.agent.id }, timing: { kind: 'at', at: intendedAt } }, other.agent.id)
          verify(bridge.update(ref, { type: 'pause', expectedRevision: armed.revision }, authority))
          await bridge.reconcile()
          assert.deepEqual(await port.catalog(), [])
          assert.deepEqual(store.listRoutineOccurrences(scope), [])
          assert.deepEqual((await ctx.schedule.catalog()).map(row => row.id), [unrelated.id])
          report({ nativeRows: 0, unrelatedRows: 1, occurrences: 0, ...counters() })
          return
        } finally {
          await other.dispose()
        }
      }
      if (phase === 'manual-native') {
        await bridge.reconcile()
        const [entry] = await port.catalog()
        const ran = await ctx.schedule.run({ id: entry.id })
        assert.equal(ran.status, 'active')
        assert.ok(ran.lastDelivery?.messageId)
        assert.notEqual(ran.lastDelivery.scheduledAt, intendedAt)
        await verifyModelFreeDelivery(ctx, port.targetSessionId, ran.lastDelivery.messageId, entry.marker)
        await bridge.reconcile()
        assert.deepEqual(await port.history(entry.id), [])
        assert.deepEqual(store.listRoutineOccurrences(scope), [])
        report({ nativeRows: 1, nativeReceipt: true, occurrences: 0, ...counters() })
        return
      }
      await eventually(() => store.listRoutineOccurrences(scope)[0])
      assert.fail('The child missed its crash point')
    }

    const occurrence = await eventually(async () => {
      await bridge.reconcile()
      return store.listRoutineOccurrences(scope)[0]
    })
    assert.equal(occurrence.status, 'reminded')
    assert.equal(occurrence.reminderText, reminderText)
    const { nativeReceipt } = occurrence
    assert.ok(nativeReceipt)
    assert.deepEqual(store.getRoutineRetirement(nativeReceipt.nativeId), nativeReceipt)
    assert.equal(nativeReceipt.targetSessionId, port.targetSessionId)
    assert.deepEqual(store.listRoutineMappings(scope), [])
    await verifyModelFreeDelivery(ctx, port.targetSessionId, nativeReceipt.messageId, nativeReceipt.prompt)
    await bridge.reconcile()
    assert.equal(store.listRoutineOccurrences(scope).length, 1)
    const rows = await port.catalog()
    assert.equal(rows.length, 0, 'Only the ended, durably consumed native wake is retired')
    report({ nativeId: nativeReceipt.nativeId, messageId: nativeReceipt.messageId, intendedAt: occurrence.intendedAt,
      nativeRows: rows.length, occurrences: 1, ...counters() })
  } finally {
    await bridge.close()
    store.close()
  }
}

export function apply(ctx) {
  const counters = adapterCounters(ctx)
  if (phase !== 'verify-disabled') ctx.dshpaScheduleSink.configure({ storageDirectory, cwd })
  ctx.provide('dshpaScheduleTestReady', true)
  ctx.inject(['schedule'], scheduleCtx => {
    scheduleCtx.effect(() => scheduleCtx.appReady.onReady(() => {
      void run(scheduleCtx, counters).then(() => scheduleCtx.appExit(0), error => {
        console.error(error)
        scheduleCtx.appExit(1)
      })
    }))
  })
}
