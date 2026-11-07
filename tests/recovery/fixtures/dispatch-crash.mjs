import assert from 'node:assert/strict'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Run current package sources in a separate process even when the repository's
// compiled output is missing or older than this checkout.
const sourceRoot = new URL('../../../packages/personal-agent/src/', import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (source.href.startsWith(sourceRoot) && existsSync(fileURLToPath(source))) return next(source.href, context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
      })
      return { format: 'module', shortCircuit: true, source: outputText }
    }
    return next(url, context)
  },
})

const { openWorkStore } = await import(`${sourceRoot}storage/store.ts`)
const { createIdentityBoundary } = await import(`${sourceRoot}policy/identity.ts`)
const { canonicalizeAction } = await import(`${sourceRoot}policy/grants.ts`)

const [directory, ledger, kind, phase] = process.argv.slice(2)
const at = '2026-11-07T08:00:00.000Z'
const scope = { ownerId: 'fixture-owner', profileId: 'fixture-profile' }
const sourceInstanceId = 'fixture-source'
const accountId = 'fixture-account'
const destination = { sourceInstanceId, externalDestinationId: 'fixture-thread' }
const binding = {
  sourceInstanceId, accountId, kind: 'fixture-write', resourceRef: 'fixture-resource', dataScope: ['fixture'], limits: { maxUses: 1 },
}
const profile = {
  id: scope.profileId, ownerId: scope.ownerId, policyVersion: 'fixture-policy',
  verifiedAccounts: [{ sourceInstanceId, accountId, verifiedAt: at }],
  verifiedDevices: [{ deviceId: 'fixture-device', verifiedAt: at }],
}
const metadata = { ...scope, clientId: 'fixture-client', deviceId: 'fixture-device', sessionId: 'fixture-session' }
const identity = createIdentityBoundary(() => profile)
const token = identity.bindOwner(metadata)
const owner = identity.resolveOwner(token)
const taskId = 'fixture-task'
const attemptId = 'fixture-attempt'
const ref = { ...scope, taskId }
const store = openWorkStore(directory)
const projectId = 'fixture-project'
const conversationId = 'fixture-conversation'
const operationId = 'fixture-effect'
const otherOperationId = 'unused-effect'
const providerIdempotencyKey = 'fixture-effect-key'
const routeId = 'fixture-route'

function succeed(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.state
}

function report(value) {
  writeSync(1, `${JSON.stringify(value)}\n`)
}

function crashAtProvider(record) {
  if (phase === 'after') {
    const fd = openSync(ledger, 'a', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  process.exit(86)
}

function delivery(id) {
  return { ...scope, id, destination, payload: { text: 'Fixture result', artifactIds: [] }, dedupeKey: `key-${id}`, status: 'pending', retries: 0 }
}

function actionFor(id) {
  return { ...scope, ...binding, taskId, attemptId, generation: 1, operationId: id, policyVersion: profile.policyVersion, payload: { text: 'Fixture write' } }
}

function effect(action) {
  return {
    operationId: action.operationId, taskId, attemptId, generation: 1, status: 'prepared', intent: 'Fixture operation',
    payloadDigest: canonicalizeAction(action).digest, providerIdempotencyKey,
  }
}

store.insertProject({
  ...scope, id: projectId, kind: 'project', title: 'Recovery fixture', purpose: 'Verify crash fencing',
  resourceRefs: [], status: 'active', successCriteria: ['Preserve evidence'], planRevision: 1, milestones: [],
})
store.insertConversation({ ...scope, id: conversationId, sessionIds: [], originalDestination: destination })
const action = actionFor(operationId)
const otherAction = actionFor(otherOperationId)
const message = delivery('fixture-delivery')
const otherMessage = delivery('unused-delivery')
const work = succeed(store.applyCommand({
  type: 'work.create', commandId: 'create-crash-task', conversationId,
  payload: { projectId, requestedOutcome: 'Produce crash evidence', constraints: [],
    acceptance: { criteria: ['Preserve evidence'], requiresArtifact: false, requiresReceipt: false } },
}, {
  actor: owner, at, conversationId, projectId, newTaskId: taskId,
  newAttempt: { id: attemptId, mandate: { ...scope, id: 'fixture-mandate', policyVersion: profile.policyVersion } },
}, {
  ...(kind !== 'outbox' ? { effects: [effect(action), effect(otherAction)] } : {}),
  ...(kind !== 'effect' ? { deliveries: [message, otherMessage] } : {}),
}))

if (kind !== 'outbox') {
  const running = succeed(store.applyEvent(ref, {
    type: 'start', expectedVersion: work.task.version, at, attemptId, generation: 1, executor: 'fixture',
    scope: { capabilities: [binding.kind], dataScope: binding.dataScope },
  }))
  const gate = store.createActionGate({ identity, now: () => at, routes: [{
    binding, permitsPayload: () => true,
    handoff(actual) {
      assert.equal(actual.operationId, operationId)
      crashAtProvider({ operationId, taskId, attemptId, generation: 1, sourceInstanceId, accountId,
        digest: canonicalizeAction(actual).digest, providerIdempotencyKey, receiptId: 'effect-receipt' })
    },
  }] })
  function approve(value) {
    const requestId = `approval-${value.operationId}`
    const review = gate.review(value, { requestId, expiresAt: '2026-11-07T08:05:00.000Z' }, token)
    assert.equal(review.decision, 'ask')
    const result = gate.respond({ requestId, expectedVersion: review.version,
      digest: review.approval.action.payloadDigest, decision: 'approve' }, token)
    assert.equal(result.status, 'approved')
    return result.grantId
  }
  const grantId = approve(action)
  const otherGrantId = approve(otherAction)
  report({ ref, metadata, profile, binding, action, otherAction, grantId, otherGrantId, version: running.task.version,
    message, otherMessage, routeId, accountId })
  if (kind === 'restore' || kind === 'normal') {
    store.close()
    process.exit(0)
  }
  gate.dispatch(action, grantId, running.task.version)
} else {
  const outbox = store.createOutbox({
    now: () => at,
    allowDisclosure: () => true,
    resolveRoute: () => ({ ...scope, destination, id: routeId, accountId, provider: {
      async send(request) {
        crashAtProvider({ deliveryId: request.deliveryId, dedupeKey: request.dedupeKey,
          destination: request.destination, routeId, accountId, receiptId: 'delivery-receipt' })
      },
    } }),
  })
  report({ ref, message, otherMessage, routeId, accountId })
  await outbox.deliver(ref, message.id)
}

throw new Error('The fixture failed to reach its abrupt provider boundary')
