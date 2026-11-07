import assert from 'node:assert/strict'
import { realpathSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWorkerExecutor } from './node_modules/@mosbot-ai/dshpa/lib/runtime/executor.js'
import { createRecovery } from './node_modules/@mosbot-ai/dshpa/lib/runtime/recovery.js'
import { createSessionReadback } from './node_modules/@mosbot-ai/dshpa/lib/runtime/recovery-session.js'
import { openWorkStore } from './node_modules/@mosbot-ai/dshpa/lib/storage/store.js'

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'dshpa', 'agents', 'llm', 'sessionPersistence']

const scope = { ownerId: 'pa009-owner', profileId: 'pa009-profile' }
const actor = { role: 'owner', ...scope, clientId: 'pa009-client', deviceId: 'pa009-device', policyVersion: 'p1' }
const ref = { ...scope, taskId: 'pa009-input-task' }
const projectId = 'pa009-project'
const provider = 'pa009-crash-model'
const presetId = 'pa009-private'
const at = '2026-11-07T08:00:00.000Z'
const afterCrash = '2026-11-07T08:01:00.000Z'
const fixtureExit = 91
const originalInput = { cursor: 'pa009-cursor', text: 'Exact input retained across fixture interruption.' }
const cwd = realpathSync(process.cwd())
const presets = [{ id: presetId, rootDirectory: cwd, provider, model: 'scripted', dataScope: [] }]

function seed(store) {
  store.insertProject({
    id: projectId, ...scope, kind: 'project', title: 'PA-009 fixture', purpose: 'Check the native input crash boundary.',
    resourceRefs: [], status: 'active', successCriteria: ['No duplicate model request.'], planRevision: 1, milestones: [],
  })
  const result = store.applyCommand({
    type: 'work.create', commandId: 'pa009-create',
    payload: { projectId, requestedOutcome: 'Protect the exact input.', constraints: [],
      acceptance: { criteria: ['No duplicate model request.'], requiresArtifact: false, requiresReceipt: false } },
  }, {
    actor, at, newTaskId: ref.taskId, projectId,
    newAttempt: { id: 'pa009-attempt', mandate: { id: 'pa009-mandate', ...scope, policyVersion: 'p1' } },
  })
  assert.equal(result.ok, true)
  return result.state
}

async function crashAfterFlush(ctx, store, calls, parked) {
  const queued = seed(store)
  const native = ctx.dshpa.host.workerRuntime
  const runtime = {
    async open(options) {
      const worker = await native.open(options)
      const agent = ctx.agents.get(options.sessionId)
      assert.ok(agent)
      return {
        ...worker,
        followup(input) {
          const delivery = {
            ...input,
            acknowledge() {
              const [intent] = store.workerInputs(ref, queued.attempt.id)
              assert.equal(intent?.status, 'intent')
              assert.equal(intent?.messageId, input.messageId)
              assert.equal(intent?.digest, input.digest)
              assert.equal(calls(), 0)
              writeSync(1, 'PA009_NATIVE_FLUSH_WITHOUT_ACK\n')
              process.exit(fixtureExit)
            },
          }
          if (parked) {
            // Keep the driver parked so the exact durable input is pending.
            return agent.runMaintenance(() => worker.followup(delivery))
          }
          const claimed = Promise.withResolvers()
          agent.ctx.on('agent/inbox/claimed', ({ message }) => {
            if (message.id === input.messageId) claimed.resolve()
          })
          ctx.on('session/flush', async session => {
            if (session.id !== options.sessionId) return
            // Flush the claim as well as insertion before simulating the
            // crash. The active driver must still wait for SQLite ack.
            await claimed.promise
            await ctx.sessionPersistence.flush()
          })
          return worker.followup(delivery)
        },
      }
    },
  }
  const executor = createWorkerExecutor({ store, runtime, presets, now: () => at })
  await executor.launch(ref, {
    expectedVersion: queued.task.version, presetId, cwd, dataScope: [], input: originalInput,
  })
  assert.fail('The native input fixture must exit before SQLite acknowledgement')
}

async function recover(ctx, store, calls, expected) {
  assert.equal(store.recoveryMode(), 'reconciling')
  const before = store.getWork(ref)
  assert.equal(before?.task.status, 'running')
  const [intent] = store.workerInputs(ref, before.attempt.id)
  assert.equal(intent?.status, 'intent')
  assert.ok(intent)
  assert.equal(ctx.agents.get(intent.sessionId), undefined)
  const readSession = createSessionReadback(ctx)
  const identity = {
    sessionId: intent.sessionId, cwd, cursor: intent.cursor, messageId: intent.messageId, digest: intent.digest,
  }
  assert.equal(await readSession(identity), expected)
  assert.equal(await readSession({ ...identity, digest: '0'.repeat(64) }), 'unknown')
  const result = await createRecovery(store, { readSession, now: () => afterCrash }).reconcileStartup()
  assert.equal(result.inputs, 1)
  assert.equal(result.fenced, 1)
  const retired = store.getWork(ref)
  assert.equal(retired?.task.status, 'reconciliation_required')
  assert.equal(retired.task.generation, before.task.generation + 1)
  assert.equal(retired.attempt.id, before.attempt.id)
  assert.equal(retired.attempt.generation, before.attempt.generation)
  assert.equal(store.workerInputs(ref, before.attempt.id)[0]?.status, expected)
  assert.equal(store.acknowledgeWorkerInput(ref, intent, afterCrash), false)
  const executor = createWorkerExecutor({ store, runtime: ctx.dshpa.host.workerRuntime, presets, now: () => afterCrash })
  const retry = await executor.launch(ref, {
    expectedVersion: retired.task.version, presetId, cwd, dataScope: [], input: originalInput,
  })
  assert.equal(retry.ok, false, 'The retired attempt must not launch again')
  assert.equal(await executor.close(), true)
  assert.equal(await readSession(identity), expected, 'Startup must not consume or replay the input')
  assert.equal(ctx.agents.get(intent.sessionId), undefined)
  assert.equal(calls(), 0)
  console.log(`PA009_NATIVE_FENCED ${expected}`)
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    const store = openWorkStore(join(process.env.DSH_HOME, 'pa009-input-store'))
    let modelCalls = 0
    class ForbiddenModel extends LlmAdapter {
      async *stream() {
        modelCalls++
        throw new Error('The unacknowledged input entered the model')
      }
    }
    ctx.llm.registerAdapter([provider], new ForbiddenModel())
    const phase = process.env.DSHPA_CONTRACT_PHASE
    const operation = phase === 'crash-pending' || phase === 'crash-claimed'
      ? crashAfterFlush(ctx, store, () => modelCalls, phase === 'crash-pending')
      : recover(ctx, store, () => modelCalls, phase === 'recover-pending' ? 'pending' : 'unknown')
    void operation.then(() => {
      store.close()
      ctx.appExit(0)
    }, error => {
      store.close()
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
