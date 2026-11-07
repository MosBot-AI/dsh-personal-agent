import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

export const inject = ['appReady', 'appExit', 'dshpa', 'agentLoop', 'agents', 'llm', 'sessionPersistence']

const sessionId = 'schedule-host-session'
const prompt = 'Record the schedule contract observation.'
const route = { provider: 'dshpa-schedule-fixture', model: 'fake' }

function report(result) {
  // Write synchronously so the report survives the simulated abrupt exit.
  writeSync(1, `DSHPA_SCHEDULE ${JSON.stringify(result)}\n`)
}

async function waitFor(observe, description) {
  const deadline = Date.now() + 5_000
  do {
    const result = await observe()
    if (result !== undefined) return result
    await delay(10)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}

async function readEvents(ctx) {
  const reader = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    return (await reader.read()).events
  } finally {
    await reader.close()
  }
}

function scheduleMessages(events) {
  return events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
    .filter(message => message.source.kind === 'schedule' && message.content[0]?.text?.startsWith('[SCHEDULE REMINDER]\n'))
}

function messageIds(events, task) {
  return scheduleMessages(events).map(message => {
    const content = message.content.map(block => block.text).join('')
    assert.ok(content.includes(`schedule_id_json: ${JSON.stringify(task.id)}`), content)
    assert.ok(content.includes(`occurrence_at: ${task.scheduledAt}`), content)
    assert.ok(content.includes(`reminder_prompt_json: ${JSON.stringify(prompt)}`), content)
    return message.id
  })
}

async function receiptFor(ctx, task) {
  const { records } = await ctx.schedule.history({ id: task.id, limit: 10 })
  assert.equal(records.length, 1)
  const { prompt: recordedPrompt, ...receipt } = records[0]
  assert.equal(recordedPrompt, prompt)
  assert.deepEqual(receipt, task.lastDelivery)
  return receipt
}

async function deliver(ctx, phase) {
  const { agent, dispose } = await ctx.agents.create({ sessionId, agentOptions: route })
  const releaseMaintenance = Promise.withResolvers()
  const maintenance = agent.runMaintenance(() => releaseMaintenance.promise)
  const releaseFlush = Promise.withResolvers()
  let atFlush
  const detach = ctx.on('session/flush', session => {
    if (session.id === sessionId && scheduleMessages(session.snapshotEvents()).length > 0) {
      atFlush = session
      return releaseFlush.promise
    }
  })

  try {
    const task = await ctx.schedule.create({
      title: 'Native schedule contract',
      prompt,
      timing: { kind: 'after', after_seconds: 1 },
      target: { kind: 'session', sessionId },
    }, sessionId)
    await waitFor(() => atFlush, 'the timed occurrence to enter the session flush')
    const current = await ctx.schedule.view({ id: task.id })
    assert.equal(current.status, 'active')
    assert.equal(current.lastDelivery, undefined)
    assert.deepEqual((await ctx.schedule.history({ id: task.id, limit: 10 })).records, [])

    // Drain the real persistence backend while the extra flush listener holds
    // the scheduler's barrier. The inbox message is durable before its receipt.
    await ctx.sessionPersistence.flush()
    const events = await readEvents(ctx)
    const persistedIds = messageIds(events, task)
    assert.equal(persistedIds.length, 1)
    assert.equal(events.some(event => event.type === 'assistant/message'), false)
    const result = {
      phase,
      id: task.id,
      scheduledAt: task.scheduledAt,
      statusAtFlush: current.status,
      messageIds: persistedIds,
    }

    if (phase === 'interrupt-flush') {
      report(result)
      process.exit(86)
    }

    releaseFlush.resolve()
    const ended = await waitFor(async () => {
      const view = await ctx.schedule.view({ id: task.id })
      return view.status === 'ended' ? view : undefined
    }, 'the durable schedule receipt')
    assert.deepEqual(await ctx.schedule.run({ id: task.id }), {
      id: task.id,
      code: 'schedule_execution_pending',
    })
    report({ ...result, status: ended.status, receipt: await receiptFor(ctx, ended) })
  } finally {
    detach()
    releaseFlush.resolve()
    agent.cancel({ kind: 'user' })
    releaseMaintenance.resolve()
    await maintenance
    await dispose()
  }
}

async function restart(ctx, phase) {
  const catalog = await ctx.schedule.catalog()
  assert.equal(catalog.length, 1)
  const [{ id }] = catalog
  const task = await waitFor(async () => {
    const view = await ctx.schedule.view({ id })
    return view.status === 'ended' ? view : undefined
  }, 'the ended schedule after restart')
  await ctx.agents.get(sessionId)?.whenIdle()
  await ctx.sessionPersistence.flush()
  report({
    phase,
    id,
    status: task.status,
    receipt: await receiptFor(ctx, task),
    messageIds: messageIds(await readEvents(ctx), task),
  })
}

export function apply(ctx) {
  const phase = process.env.DSHPA_CONTRACT_PHASE
  // A resumed Agent can run pending input while the native timer replays it.
  ctx.llm.registerAdapter([route.provider], {
    providerInfo: id => ({ id, name: id }),
    providerRetryPolicy: () => undefined,
    async prepareCall(provider, model) {
      return {
        model: { provider, id: model, name: model },
        async *stream() {
          const text = 'Local schedule probe response.'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  })
  ctx.on('schedule/resolve-agent', async (id, next) => {
    if (id !== sessionId) return next()
    return ctx.agents.get(id) ?? (await ctx.agents.resume({ resumeSessionId: id, agentOptions: route })).agent
  })
  ctx.inject(['schedule'], scheduleCtx => {
    scheduleCtx.effect(() => scheduleCtx.appReady.onReady(() => {
      const operation = phase === 'deliver' || phase === 'interrupt-flush'
        ? deliver(scheduleCtx, phase)
        : restart(scheduleCtx, phase)
      void operation.then(() => scheduleCtx.appExit(0), error => {
        console.error(error)
        scheduleCtx.appExit(1)
      })
    }))
  })
}
