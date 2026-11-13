import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activateLocalInbox } from './node_modules/@mosbot-ai/dshpa/lib/inbox/host.js'
import { canonicalizeAction } from './node_modules/@mosbot-ai/dshpa/lib/policy/grants.js'

export const inject = ['appReady', 'appExit', 'dshpa', 'connection', 'sessions', 'sessionController', 'webServer']

const sessionId = 'mobile-fixture-chat'
const projectId = 'mobile-review-project'
const conversationId = 'mobile-review-conversation'
const account = { sourceInstanceId: 'mobile-fixture-connector', accountId: 'mobile-fixture-account' }
const route = { ...account, kind: 'fixture-notice', resourceRef: 'fixture-resource',
  recipient: 'fixture-recipient', dataScope: ['fixture-public'], limits: { maxUses: 1 } }

function seedReviews(local, at) {
  const { store, owner } = local
  const { ownerId, profileId, policyVersion } = owner
  const scope = { ownerId, profileId }
  store.insertProject({ ...scope, id: projectId, kind: 'project', title: 'Mobile review fixture', purpose: 'Review exact actions.',
    resourceRefs: [], status: 'active', successCriteria: ['Inspect the action.'], planRevision: 1, milestones: [] })
  store.insertConversation({ ...scope, id: conversationId, sessionIds: [sessionId],
    originalDestination: { sourceInstanceId: 'fixture-original-source', externalDestinationId: 'fixture-original-thread' } })
  for (const suffix of ['approve', 'recall']) {
    const taskId = 'mobile-task-' + suffix
    const attemptId = 'mobile-attempt-' + suffix
    const operationId = 'mobile-operation-' + suffix
    const action = canonicalizeAction({ ...scope, ...route, policyVersion, taskId, attemptId, operationId,
      generation: 1, payload: { text: 'Exact fixture payload ' + suffix } })
    assert.ok(action)
    const created = store.applyCommand({ type: 'work.create', commandId: 'create-' + taskId,
      payload: { projectId, requestedOutcome: 'Review ' + suffix, constraints: [],
        acceptance: { criteria: ['Inspect the action.'], requiresArtifact: false, requiresReceipt: false } },
    }, {
      actor: owner, at, projectId, conversationId, newTaskId: taskId,
      newAttempt: { id: attemptId, mandate: { ...scope, id: 'mandate-' + taskId, policyVersion } },
    }, { effects: [{ operationId, taskId, attemptId, generation: 1, status: 'prepared',
      intent: 'Fixture effect', payloadDigest: action.digest }] })
    assert.equal(created.ok, true, JSON.stringify(created))
    const started = store.applyEvent({ ...scope, taskId }, { type: 'start', at, expectedVersion: created.state.task.version,
      attemptId, generation: 1, executor: 'fixture', scope: { capabilities: [route.kind], dataScope: route.dataScope } })
    assert.equal(started.ok, true, JSON.stringify(started))
    const review = local.actionGate.review(action.action, { requestId: 'mobile-review-' + suffix,
      expiresAt: new Date(Date.parse(at) + 5 * 60_000).toISOString() }, local.ownerToken())
    assert.equal(review.decision, 'ask', JSON.stringify(review))
  }
}

function seedTaskPages({ store, owner }, at, crowdReviews) {
  const create = (suffix, requestedOutcome, timestamp) => {
    const taskId = 'mobile-task-' + suffix
    const result = store.applyCommand({ type: 'work.create', commandId: 'create-' + taskId,
      payload: { projectId, requestedOutcome, constraints: [],
        acceptance: { criteria: ['Inspect the task.'], requiresArtifact: false, requiresReceipt: false } },
    }, {
      actor: owner, at: timestamp, projectId, conversationId, newTaskId: taskId,
      newAttempt: { id: 'mobile-attempt-' + suffix,
        mandate: { ownerId: owner.ownerId, profileId: owner.profileId, id: 'mandate-' + taskId, policyVersion: owner.policyVersion } },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  // Same-time filler sorts ahead of existing reviews by row ID when testing the work limit.
  const recent = crowdReviews ? at : new Date(Date.parse(at) - 1_000).toISOString()
  for (let index = 0; index < 62; index++) {
    const label = String(index).padStart(3, '0')
    create('page-' + label, 'Browse fixture task ' + label, recent)
  }
  create('zz-older', 'Task outside the recent snapshot', new Date(Date.parse(at) - 60_000).toISOString())
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void (async () => {
      const chat = await ctx.sessionController.create({ sessionId, cwd: process.cwd(), agentPreset: 'minimal' })
      assert.equal(chat.sessionId, sessionId)
      const path = join(process.cwd(), 'mobile-review.json')
      if (existsSync(path)) {
        const { seedPages, crowdReviews, ...mobile } = JSON.parse(readFileSync(path, 'utf8'))
        const at = new Date().toISOString()
        const local = activateLocalInbox(ctx, ctx.dshpa.host, {
          storageDirectory: join(process.env.DSH_HOME, 'mobile-approval-inbox'), workRoot: process.cwd(), mobile,
        }, {
          verifiedAccounts: [{ ...account, verifiedAt: at }],
          actionRoutes: [{ binding: route, permitsPayload: payload => typeof payload?.text === 'string' && payload.text.startsWith('Exact fixture payload '),
            handoff() { throw new Error('This fixture does not dispatch an external action') } }],
        })
        ctx.effect(() => () => local.dispose())
        seedReviews(local, at)
        if (seedPages) seedTaskPages(local, at, crowdReviews)
      }
      console.log('DSHPA_WEB_FLOW_READY')
    })().catch(error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
