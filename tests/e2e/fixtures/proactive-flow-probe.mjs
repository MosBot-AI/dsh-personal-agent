import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const app = dirname(require.resolve('@mosbot-ai/dshpa'))
const { activateLocalInbox } = await import(pathToFileURL(join(app, 'inbox', 'host.js')).href)
const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['dshpa', 'appReady', 'appExit', 'sessionController', 'webServer', 'connection', 'sessions', 'llm']
const provider = 'pa019-fixture'
const model = 'fixture-assessor'
const projectId = 'pa019-goal'
const taskId = 'pa019-anchor'
const account = { sourceInstanceId: 'pa019-source', accountId: 'pa019-account' }
const threadId = 'pa019-thread'

async function initialize(ctx) {
  class FixtureModel extends LlmAdapter {
    async listModels() { return [{ provider, id: model, name: model }] }
    async resolveModel() { return { provider, id: model, name: model, context: { contextWindow: 65_536 } } }
    async *stream(options) {
      assert.equal(options.purpose, 'dshpa-routing')
      assert.deepEqual(options.tools ?? [], [])
      const batch = JSON.parse(options.messages[0].content[0].text)
      const text = JSON.stringify(batch.map(row => ({ id: row.id, kind: 'propose_task', summary: 'Scoped fixture review.' })))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 8, totalTokens: 23 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([provider], new FixtureModel())
  const local = activateLocalInbox(ctx, ctx.dshpa.host, {
    storageDirectory: join(process.env.DSH_HOME, 'proactive-inbox'), workRoot: process.cwd(), proactive: true,
    routing: { provider, model, dataScope: ['fixture-private'], unmetered: true },
  }, { verifiedAccounts: [{ ...account, verifiedAt: new Date().toISOString() }] })
  ctx.effect(() => () => local.dispose())
  const { ownerId, profileId, policyVersion } = local.owner
  const scope = { ownerId, profileId }
  const sessionId = 'pa019-native-primary'
  const created = await ctx.sessionController.create({ sessionId, cwd: process.cwd(), agentPreset: 'minimal' })
  assert.equal(created.sessionId, sessionId)
  local.store.insertProject({ ...scope, id: projectId, kind: 'goal', title: 'Proactive goal', purpose: 'Review delivery evidence.',
    resourceRefs: [], status: 'active', successCriteria: ['Review the scoped source.'], planRevision: 1, milestones: [] })
  const conversationId = 'pa019-conversation'
  local.store.insertConversation({ ...scope, id: conversationId, sessionIds: [sessionId], originalDestination: {
    sourceInstanceId: 'fixture-delivery', externalDestinationId: sessionId,
  } })
  const work = local.store.applyCommand({ type: 'work.create', commandId: 'pa019-create', conversationId,
    payload: { projectId, requestedOutcome: 'Prepare a review.', constraints: [],
      acceptance: { criteria: ['Record evidence.'], requiresArtifact: true, requiresReceipt: false } } },
  { actor: local.owner, at: new Date().toISOString(), projectId, conversationId, newTaskId: taskId,
    newAttempt: { id: 'pa019-attempt', mandate: { ...scope, id: 'pa019-mandate', policyVersion } } })
  assert.ok(work.ok)
  const source = local.routing.bindSource(account)
  assert.ok(source)
  const receive = id => local.routing.receive(source, {
    kind: 'candidate', projectId, threadId, externalEventId: id, externalRevision: '1', occurredAt: new Date().toISOString(),
    actorKind: 'person', externalActorId: 'fixture-author', text: `ready 发布 ${id}`, dataScope: ['fixture-private'],
  })
  assert.ok(receive('replay-sample').ok)
  const ledger = local.store.createProactiveLedger(scope)
  const timer = setInterval(() => {
    if (ledger.rules()[0]?.mode !== 'observe' || local.attention.policy(scope).mode !== 'observe') return
    clearInterval(timer)
    assert.ok(receive('native-observation').ok)
  }, 25)
  ctx.effect(() => () => { clearInterval(timer); local.routing.releaseSource(source) })
  console.log('DSHPA_WEB_FLOW_READY')
}
export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => { void initialize(ctx).catch(error => { console.error(error); ctx.appExit(1) }) }))
}
