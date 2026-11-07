import assert from 'node:assert/strict'
import { mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activateLocalInbox } from './node_modules/@mosbot-ai/dshpa/lib/inbox/host.js'
import { canonicalizeAction } from './node_modules/@mosbot-ai/dshpa/lib/policy/grants.js'

const cliRequire = createRequire(process.argv[1])
const baseRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-llm')).href)

export const inject = ['appReady', 'appExit', 'agents', 'connection', 'dshpa', 'llm', 'sessionController', 'sessions']

const provider = 'dshpa-web-fixture'
const chatModel = 'fixture-chat'
const workerModel = 'fixture-worker'
const sessionId = 'pa008-native-chat'
const conversationId = 'pa008-fixture-conversation'
const projectId = 'pa008-fixture-project'
const resultSummary = 'PA-008 verified fixture\n\nUnicode: 本地交付 ✓'
const account = { sourceInstanceId: 'pa008-fixture-connector', accountId: 'pa008-fixture-account' }
const route = {
  ...account,
  kind: 'publish-notice',
  resourceRef: 'pa008-fixture-notice',
  recipient: 'pa008-fixture-recipient',
  dataScope: ['fixture-public'],
  limits: { maxUses: 1 },
}
const wait = {
  reason: 'input',
  referenceId: 'pa008-fixture-question',
  resumeCondition: 'Provide the exact owner answer.',
}

function mustSucceed(result, operation) {
  assert.equal(result.ok, true, `${operation}: ${JSON.stringify(result)}`)
  return result
}

function* answer(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function attachModel(ctx) {
  let finishHeldStream
  let pendingRedirect = false
  ctx.on('agent/inbox/inserted', ({ message }) => {
    if (message.source.kind === 'dshpa-work-input' && message.source.cursor === 'pa008-redirect') {
      if (finishHeldStream) finishHeldStream()
      else pendingRedirect = true
    }
  })
  class FixtureModel extends LlmAdapter {
    async listModels() {
      return [
        { provider, id: chatModel, name: 'PA-008 fixture chat' },
        { provider, id: workerModel, name: 'PA-008 fixture worker' },
      ]
    }

    async *stream(options) {
      if (options.model === chatModel) {
        yield* answer('The native conversation stayed usable during the task.')
        return
      }
      assert.equal(options.model, workerModel)
      assert.deepEqual(options.tools ?? [], [])
      const text = options.messages.filter(message => message.role === 'user')
        .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
        .findLast(value => /"cursor": "[^"]+"/u.test(value)) ?? ''
      const cursor = /"cursor": "([^"]+)"/u.exec(text)?.[1]
      assert.ok(cursor, 'Worker input must include the exact report cursor')
      if (text.includes('PA008_RESULT')) {
        yield* answer(JSON.stringify({ kind: 'ready', cursor, summary: resultSummary, artifactIds: [] }))
        return
      }
      if (text.includes('PA008_REDIRECT')) {
        pendingRedirect = false
        yield* answer(JSON.stringify({ kind: 'waiting', cursor, summary: 'Waiting for the owner.', wait }))
        return
      }
      const held = Promise.withResolvers()
      const { signal } = options
      assert.ok(signal)
      const abort = () => held.resolve()
      finishHeldStream = held.resolve
      if (pendingRedirect) {
        pendingRedirect = false
        held.resolve()
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      try {
        await held.promise
        signal.throwIfAborted()
        yield* answer(JSON.stringify({ kind: 'progress', cursor, summary: 'The input was redirected.' }))
      } finally {
        signal.removeEventListener('abort', abort)
        if (finishHeldStream === held.resolve) finishHeldStream = undefined
      }
    }
  }
  ctx.llm.registerAdapter([provider], new FixtureModel())
}

function seedApprovalTask(local, effect) {
  const { store, owner } = local
  const { ownerId, profileId, policyVersion } = owner
  const { taskId, attemptId } = effect
  const ref = { ownerId, profileId, taskId }
  const at = new Date().toISOString()
  const accepted = mustSucceed(store.applyCommand({
    type: 'work.create', commandId: 'create-fixture-approval', conversationId,
    payload: {
      projectId,
      requestedOutcome: 'Review one exact notice.',
      constraints: [],
      acceptance: { criteria: ['Review the exact fixture action.'], requiresArtifact: false, requiresReceipt: false },
    },
  }, {
    actor: owner, at, projectId, conversationId, newTaskId: taskId,
    newAttempt: { id: attemptId, mandate: { id: 'mandate-fixture-approval', ownerId, profileId, policyVersion } },
  }, { effects: [effect] }), 'seed the fixture approval task')
  mustSucceed(store.applyEvent(ref, {
    type: 'start', at, expectedVersion: accepted.state.task.version, attemptId,
    generation: accepted.state.attempt.generation, executor: 'fixture-verifier',
    scope: { capabilities: [route.kind], dataScope: route.dataScope },
  }), 'start fixture task')
}

function seedWork(local) {
  const { store, owner, actionGate } = local
  const { ownerId, profileId, policyVersion } = owner
  store.insertProject({
    id: projectId, ownerId, profileId, kind: 'project', title: 'PA-008 fixture project',
    purpose: 'Verify the native inbox journey.', resourceRefs: [], status: 'active',
    successCriteria: ['Inspect work through the Web host.'], planRevision: 1, milestones: [],
  })
  store.insertConversation({
    id: conversationId, ownerId, profileId, sessionIds: [sessionId],
    originalDestination: { sourceInstanceId: 'dshpa-local-inbox', externalDestinationId: sessionId },
  })
  const action = canonicalizeAction({
    ownerId, profileId, policyVersion, ...route,
    taskId: 'pa008-approval', attemptId: 'attempt-pa008-approval', generation: 1,
    operationId: 'pa008-fixture-action', payload: { text: 'Approved fixture notice only.' },
  })
  assert.ok(action)
  seedApprovalTask(local, {
    operationId: action.action.operationId, taskId: action.action.taskId, attemptId: action.action.attemptId,
    generation: action.action.generation, status: 'prepared', intent: 'Prepare only the exact notice.',
    payloadDigest: action.digest,
  })
  const approval = actionGate.review(action.action, {
    requestId: 'pa008-fixture-approval',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  }, local.ownerToken())
  assert.equal(approval.decision, 'ask')
}

async function initialize(ctx) {
  attachModel(ctx)
  if (process.env.DSHPA_WEB_FLOW_CONFIG_ONLY === '1') {
    console.log('DSHPA_WEB_FLOW_READY')
    return
  }
  const workspace = join(process.env.DSH_HOME, 'fixture-workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const workRoot = realpathSync(workspace)
  const local = await activateLocalInbox(ctx, ctx.dshpa.host, {
    storageDirectory: join(process.env.DSH_HOME, 'fixture-inbox'),
    workRoot,
    worker: { provider, model: workerModel, dataScope: route.dataScope, concurrency: 2 },
  }, {
    verifiedAccounts: [{ ...account, verifiedAt: new Date().toISOString() }],
    actionRoutes: [{
      binding: route,
      permitsPayload: payload => JSON.stringify(payload) === '{"text":"Approved fixture notice only."}',
      handoff() { throw new Error('The fixture must not send an external action') },
    }],
  })
  ctx.effect(() => () => local.dispose())
  const chat = await ctx.sessionController.create({ sessionId, cwd: workRoot, agentPreset: 'minimal' })
  assert.equal(chat.sessionId, sessionId)
  await ctx.sessionController.selectModel({ sessionId, provider, model: chatModel })
  seedWork(local)
  console.log('DSHPA_WEB_FLOW_READY')
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void initialize(ctx).catch(error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
