import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  accountIdSchema,
  attemptIdSchema,
  clientIdSchema,
  deviceIdSchema,
  mandateRefSchema,
  operationIdSchema,
  profileSchema,
  projectSchema,
  sessionIdSchema,
  sourceInstanceIdSchema,
  taskIdSchema,
  utcInstantSchema,
  type Profile,
  type UtcInstant,
} from '../../packages/personal-agent/src/domain/model.js'
import { canonicalizeAction, type Action, type ActionBinding } from '../../packages/personal-agent/src/policy/grants.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'

const issuedAt = utcInstantSchema.parse('2026-11-07T10:00:00.000Z')
const reenrolledAt = utcInstantSchema.parse('2026-11-07T10:00:01.000Z')
const expiresAt = utcInstantSchema.parse('2026-11-07T10:01:00.000Z')
const initialProfile = profileSchema.parse({
  id: 'profile-security',
  ownerId: 'owner-security',
  policyVersion: 'policy-1',
  verifiedDevices: [
    { deviceId: 'device-one', verifiedAt: issuedAt },
    { deviceId: 'device-two', verifiedAt: issuedAt },
  ],
  verifiedAccounts: [
    { sourceInstanceId: 'connector-security', accountId: 'account-one', verifiedAt: issuedAt },
    { sourceInstanceId: 'connector-security', accountId: 'account-two', verifiedAt: issuedAt },
  ],
})
const scope = { ownerId: initialProfile.ownerId, profileId: initialProfile.id }
const ownerMetadata = {
  ...scope,
  deviceId: deviceIdSchema.parse('device-one'),
  clientId: clientIdSchema.parse('client-one'),
  sessionId: sessionIdSchema.parse('session-one'),
}
const sourceMetadata = {
  ...scope,
  sourceInstanceId: sourceInstanceIdSchema.parse('connector-security'),
  accountId: accountIdSchema.parse('account-one'),
}
const project = projectSchema.parse({
  id: 'project-security', ...scope, kind: 'project', title: 'Authorization fixture',
  purpose: 'Verify exact action authorization.', resourceRefs: [], status: 'active',
  successCriteria: ['Prove a scoped one-shot action.'], planRevision: 1, milestones: [],
})

const routeFields = {
  sourceInstanceId: sourceMetadata.sourceInstanceId,
  accountId: sourceMetadata.accountId,
  kind: 'publish-notice',
  resourceRef: '/fixture/public/notice',
  recipient: 'fixture-recipient',
  dataScope: ['public', 'shared'],
  limits: { maxUses: 1 },
} satisfies ActionBinding

function requireValue<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Expected ${description}`)
  return value
}

function canonical(input: unknown) {
  return requireValue(canonicalizeAction(input), 'a canonical action')
}

function isPublicNotice(payload: Action['payload']): boolean {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    && Object.keys(payload).length === 2
    && 'summary' in payload && typeof payload.summary === 'string' && payload.summary.startsWith('public:')
    && 'tags' in payload && Array.isArray(payload.tags) && payload.tags.every(tag => typeof tag === 'string')
}

function openFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-authorization-'))
  let profile = initialProfile
  let clock = () => issuedAt
  const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
  const ownerToken = requireValue(identity.bindOwner(ownerMetadata), 'an authenticated owner')
  const actor = requireValue(identity.resolveOwner(ownerToken), 'an owner identity')
  const handoffs: Action[] = []
  let onHandoff: (action: Action) => void = () => {}
  let store: ReturnType<typeof openWorkStore>
  onTestFinished(() => {
    try {
      store?.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  store = openWorkStore(directory)
  store.insertProject(project)
  function actionGate() {
    return store.createActionGate({
      identity,
      now: () => clock(),
      routes: [{
        binding: routeFields,
        permitsPayload: isPublicNotice,
        handoff(action) {
          handoffs.push(action)
          onHandoff(action)
          return undefined
        },
      }],
    })
  }
  let gate = actionGate()
  return {
    directory, actor, identity, ownerToken, handoffs,
    get store() { return store },
    get gate() { return gate },
    profile(transform: (current: Profile) => Profile) { profile = transform(profile) },
    setClock(read: () => UtcInstant) { clock = read },
    observeHandoff(callback: (action: Action) => void) { onHandoff = callback },
    reopen(sql?: string) {
      store.close()
      if (sql !== undefined) {
        const db = new DatabaseSync(join(directory, DATABASE_FILENAME))
        try {
          db.exec(sql)
        } finally {
          db.close()
        }
      }
      store = openWorkStore(directory)
      gate = actionGate()
    },
  }
}

type Fixture = ReturnType<typeof openFixture>

function seed(fixture: Fixture, label: string, attemptScope = {
  capabilities: [routeFields.kind],
  dataScope: routeFields.dataScope,
}) {
  const taskId = taskIdSchema.parse(`task-${label}`)
  const attemptId = attemptIdSchema.parse(`attempt-${label}`)
  const operationId = operationIdSchema.parse(`operation-${label}`)
  const rawAction = {
    ...scope,
    ...routeFields,
    taskId,
    attemptId,
    operationId,
    generation: 1,
    policyVersion: initialProfile.policyVersion,
    payload: { summary: 'public: fixture notice', tags: ['fixture'] },
  }
  const { digest } = canonical(rawAction)
  const context = { actor: fixture.actor, at: issuedAt, projectId: project.id }
  const queued = fixture.store.applyCommand({
    type: 'work.create',
    commandId: `create-${label}`,
    payload: {
      projectId: project.id, requestedOutcome: 'Produce one reviewable notice.', constraints: [],
      acceptance: { criteria: ['Send only the exact notice.'], requiresArtifact: false, requiresReceipt: false },
    },
  }, {
    ...context,
    newTaskId: taskId,
    newAttempt: { id: attemptId, mandate: mandateRefSchema.parse({
      id: `mandate-${label}`, ...scope, policyVersion: initialProfile.policyVersion,
    }) },
  }, { effects: [{
    operationId, taskId, attemptId, generation: 1, status: 'prepared',
    intent: 'Prepare an exact public notice.', payloadDigest: digest,
  }] })
  if (!queued.ok) throw new Error(`Could not seed work: ${queued.code}`)
  const ref = { ...scope, taskId }
  const running = fixture.store.applyEvent(ref, {
    type: 'start', at: issuedAt, expectedVersion: queued.state.task.version,
    generation: 1, attemptId, executor: 'native-dsh', scope: attemptScope,
  })
  if (!running.ok) throw new Error(`Could not start fixture work: ${running.code}`)
  return {
    rawAction, digest, ref, context,
    request: { requestId: `request-${label}`, expiresAt },
    version: running.state.task.version,
  }
}

type Seed = ReturnType<typeof seed>

function review(fixture: Fixture, seeded: Seed) {
  const result = fixture.gate.review(seeded.rawAction, seeded.request, fixture.ownerToken)
  if (result.decision !== 'ask') throw new Error(`Expected an approval request, received ${JSON.stringify(result)}`)
  return result
}

function response(seeded: Seed, expectedVersion = 0) {
  return { requestId: seeded.request.requestId, expectedVersion, decision: 'approve', digest: seeded.digest }
}

function approve(fixture: Fixture, seeded: Seed) {
  const request = review(fixture, seeded)
  const result = fixture.gate.respond(response(seeded, request.version), fixture.ownerToken)
  if (!result.ok || result.status !== 'approved') throw new Error(`Expected approval, received ${JSON.stringify(result)}`)
  return result.grantId
}

function currentEffect(fixture: Fixture, seeded: Seed) {
  return fixture.store.getEffect(seeded.ref, seeded.rawAction.operationId)
}

describe('exact action authorization', () => {
  it('requires trusted identity and the exact owner device, client, and session for a response after reopen', () => {
    const fixture = openFixture()
    const { identity } = fixture
    const seeded = seed(fixture, 'identity')
    expect(identity.bindOwner({ ...ownerMetadata, displayName: 'Claimed owner' })).toBeUndefined()
    expect(identity.bindOwner({ ...ownerMetadata, deviceId: 'unknown-device' })).toBeUndefined()
    expect(identity.bindSource({ ...sourceMetadata, sourceInstanceId: 'unverified-connector' })).toBeUndefined()
    const sourceToken = requireValue(identity.bindSource(sourceMetadata), 'a verified source identity')
    const foreignToken = createIdentityBoundary(() => initialProfile).bindOwner(ownerMetadata)
    for (const token of [{ ...ownerMetadata, role: 'owner' }, sourceToken, foreignToken]) {
      expect(fixture.gate.review(seeded.rawAction, seeded.request, token))
        .toEqual({ decision: 'deny', code: 'permission_denied' })
    }

    expect(review(fixture, seeded)).toMatchObject({
      action: canonical(seeded.rawAction).action,
      approval: { id: seeded.request.requestId, status: 'pending', action: { payloadDigest: seeded.digest } },
      version: 0,
    })
    fixture.reopen()
    for (const metadata of [
      { ...ownerMetadata, deviceId: 'device-two' },
      { ...ownerMetadata, clientId: 'client-other' },
      { ...ownerMetadata, sessionId: 'session-other' },
    ]) {
      const other = requireValue(identity.bindOwner(metadata), 'a second authenticated owner context')
      expect(fixture.gate.respond(response(seeded), other)).toEqual({ ok: false, code: 'permission_denied' })
    }
    expect(fixture.gate.respond(response(seeded), sourceToken)).toEqual({ ok: false, code: 'permission_denied' })
    identity.release(sourceToken)
    expect(identity.resolveSource(sourceToken)).toBeUndefined()
    identity.release(fixture.ownerToken)
    expect(fixture.gate.respond(response(seeded), fixture.ownerToken)).toEqual({ ok: false, code: 'permission_denied' })
    const reauthenticated = requireValue(identity.bindOwner(ownerMetadata), 'a renewed owner token')
    expect(fixture.gate.respond(response(seeded), reauthenticated)).toMatchObject({ ok: true, status: 'approved' })
    expect(fixture.gate.respond({ ...response(seeded), decision: 'deny' }, reauthenticated))
      .toEqual({ ok: false, code: 'already_decided' })
    expect(currentEffect(fixture, seeded)?.status).toBe('authorized')
  })

  it('moves one version-fenced review to the exact device while preserving coordinator dispatch', () => {
    const fixture = openFixture()
    const mobile = requireValue(fixture.identity.bindOwner({ ...ownerMetadata, deviceId: 'device-two',
      clientId: 'mobile-client', sessionId: 'mobile-session' }), 'a mobile identity')
    const wrongSession = requireValue(fixture.identity.bindOwner({ ...ownerMetadata, deviceId: 'device-two',
      clientId: 'mobile-client', sessionId: 'wrong-session' }), 'another session')
    const seeded = seed(fixture, 'mobile-review')
    const approval = review(fixture, seeded)
    const fence = { requestId: approval.approval.id, digest: seeded.digest, expectedVersion: approval.version }
    expect(fixture.gate.assignMobileReview({ ...fence, digest: '0'.repeat(64) }, fixture.ownerToken, mobile))
      .toEqual({ ok: false, code: 'action_changed' })
    expect(fixture.gate.assignMobileReview(fence, mobile, fixture.ownerToken)).toEqual({ ok: false, code: 'permission_denied' })
    expect(fixture.gate.assignMobileReview(fence, fixture.ownerToken, mobile)).toEqual({ ok: true })
    fixture.reopen()
    expect(fixture.gate.pending(mobile, [seeded.ref.taskId])).toMatchObject([{ version: 1, mobileDeviceId: 'device-two' }])
    expect(fixture.gate.pending(wrongSession, [seeded.ref.taskId])).toEqual([])
    expect(fixture.gate.respond(response(seeded, 1), fixture.ownerToken)).toEqual({ ok: false, code: 'permission_denied' })
    expect(fixture.gate.respond(response(seeded, 1), wrongSession)).toEqual({ ok: false, code: 'permission_denied' })
    expect(fixture.gate.respond(response(seeded), mobile)).toEqual({ ok: false, code: 'version_conflict' })
    const granted = fixture.gate.respond(response(seeded, 1), mobile)
    if (!granted.ok || granted.status !== 'approved') throw new Error('Expected a mobile approval')
    expect(fixture.gate.review(seeded.rawAction, seeded.request, fixture.ownerToken)).toEqual({ decision: 'allow', grantId: granted.grantId })
    expect(fixture.gate.respond(response(seeded, 1), mobile)).toEqual({ ok: false, code: 'already_decided' })
    expect(fixture.gate.dispatch(seeded.rawAction, granted.grantId, seeded.version)).toEqual({ ok: true, status: 'dispatching' })
    expect(fixture.gate.dispatch(seeded.rawAction, granted.grantId, seeded.version)).toEqual({ ok: false, code: 'already_claimed' })
    expect(fixture.handoffs).toEqual([canonical(seeded.rawAction).action])
  })

  it('lets the original owner recall a revoked device review and refuses a revoked mobile grant', () => {
    const fixture = openFixture()
    const mobile = requireValue(fixture.identity.bindOwner({ ...ownerMetadata, deviceId: 'device-two',
      clientId: 'mobile-client', sessionId: 'mobile-session' }), 'a mobile identity')
    const pending = seed(fixture, 'mobile-pending')
    const decided = seed(fixture, 'mobile-decided')
    const move = (seeded: Seed) => {
      const approval = review(fixture, seeded)
      const fence = { requestId: approval.approval.id, digest: seeded.digest, expectedVersion: approval.version }
      expect(fixture.gate.assignMobileReview(fence, fixture.ownerToken, mobile)).toEqual({ ok: true })
      return fence
    }
    const fence = move(pending)
    move(decided)
    const granted = fixture.gate.respond(response(decided, 1), mobile)
    if (!granted.ok || granted.status !== 'approved') throw new Error('Expected a mobile approval')
    fixture.profile(profile => ({ ...profile, verifiedDevices: profile.verifiedDevices.filter(device => device.deviceId !== 'device-two') }))
    expect(fixture.gate.respond(response(pending, 1), mobile)).toEqual({ ok: false, code: 'permission_denied' })
    expect(fixture.gate.review(decided.rawAction, decided.request, fixture.ownerToken)).toEqual({ decision: 'deny', code: 'permission_denied' })
    expect(fixture.gate.dispatch(decided.rawAction, granted.grantId, decided.version)).toEqual({ ok: false, code: 'permission_denied' })
    expect(fixture.gate.assignMobileReview({ ...fence, expectedVersion: 1 }, fixture.ownerToken, null)).toEqual({ ok: true })
    expect(fixture.gate.respond(response(pending, 1), fixture.ownerToken)).toEqual({ ok: false, code: 'version_conflict' })
    expect(fixture.gate.respond({ ...response(pending, 2), decision: 'deny' }, fixture.ownerToken)).toEqual({ ok: true, status: 'denied' })
    expect(fixture.handoffs).toEqual([])
  })

  it('rejects an assigned response after approval expiry or task cancellation', () => {
    const fixture = openFixture()
    const mobile = requireValue(fixture.identity.bindOwner({ ...ownerMetadata, deviceId: 'device-two',
      clientId: 'mobile-client', sessionId: 'mobile-session' }), 'a mobile identity')
    const expired = seed(fixture, 'mobile-expiry')
    const cancelled = seed(fixture, 'mobile-cancel')
    for (const seeded of [expired, cancelled]) {
      const approval = review(fixture, seeded)
      expect(fixture.gate.assignMobileReview({ requestId: approval.approval.id, expectedVersion: approval.version, digest: seeded.digest },
        fixture.ownerToken, mobile)).toEqual({ ok: true })
    }
    expect(fixture.store.applyCommand({ type: 'work.cancel', taskId: cancelled.ref.taskId,
      commandId: 'cancel-mobile-fixture', expectedVersion: cancelled.version, payload: {},
    }, cancelled.context)).toMatchObject({ ok: true })
    expect(fixture.gate.respond(response(cancelled, 1), mobile)).toEqual({ ok: false, code: 'stale_attempt' })
    fixture.setClock(() => expiresAt)
    expect(fixture.gate.respond(response(expired, 1), mobile)).toEqual({ ok: false, code: 'expired' })
    fixture.reopen()
    fixture.setClock(() => issuedAt)
    expect(fixture.gate.respond(response(expired, 1), mobile)).toEqual({ ok: false, code: 'expired' })
    expect(fixture.handoffs).toEqual([])
  })

  it('matches the exact account, recipient, resource, connector payload and worker disclosure scope', () => {
    const fixture = openFixture()
    const seeded = seed(fixture, 'route')
    for (const action of [
      { ...seeded.rawAction, accountId: 'account-two' },
      { ...seeded.rawAction, recipient: 'unreviewed-recipient' },
      { ...seeded.rawAction, resourceRef: '/fixture/public/../private' },
      { ...seeded.rawAction, dataScope: ['private', 'public'] },
      { ...seeded.rawAction, payload: { ...seeded.rawAction.payload, privateData: 'fixture-private' } },
    ]) {
      expect(fixture.gate.review(action, seeded.request, fixture.ownerToken))
        .toEqual({ decision: 'deny', code: 'permission_denied' })
    }
    const limited = seed(fixture, 'limited', { capabilities: [routeFields.kind], dataScope: ['public'] })
    expect(fixture.gate.review(limited.rawAction, limited.request, fixture.ownerToken))
      .toEqual({ decision: 'deny', code: 'permission_denied' })
    expect(currentEffect(fixture, seeded)?.status).toBe('prepared')
    expect(fixture.handoffs).toEqual([])
  })

  it('rejects an altered digest or action and treats canonical key and scope order as equivalent', () => {
    const fixture = openFixture()
    const seeded = seed(fixture, 'digest')
    const changed = { ...seeded.rawAction, payload: { ...seeded.rawAction.payload, summary: 'public: changed' } }
    expect(fixture.gate.review(changed, seeded.request, fixture.ownerToken))
      .toEqual({ decision: 'deny', code: 'action_changed' })
    const request = review(fixture, seeded)
    const reordered = {
      ...seeded.rawAction,
      dataScope: ['shared', 'public'],
      payload: { tags: ['fixture'], summary: 'public: fixture notice' },
    }
    expect(fixture.gate.review(reordered, { ...seeded.request, requestId: 'alternate-request' }, fixture.ownerToken))
      .toEqual(request)
    expect(fixture.gate.respond({ ...response(seeded), digest: canonical(changed).digest }, fixture.ownerToken))
      .toEqual({ ok: false, code: 'action_changed' })
    expect(fixture.gate.respond(response(seeded, request.version + 1), fixture.ownerToken))
      .toEqual({ ok: false, code: 'version_conflict' })
    const grantId = approve(fixture, seeded)
    expect(fixture.gate.review(reordered, seeded.request, fixture.ownerToken)).toEqual({ decision: 'allow', grantId })
    expect(fixture.gate.dispatch(changed, grantId, seeded.version)).toEqual({ ok: false, code: 'action_changed' })
    expect(currentEffect(fixture, seeded)?.status).toBe('authorized')
    expect(fixture.handoffs).toEqual([])
  })

  it('persists observed expiry across restart and clock rewind and never grants a denied request', () => {
    const fixture = openFixture()
    const pending = seed(fixture, 'pending-expiry')
    const authorized = seed(fixture, 'authorized-expiry')
    const denied = seed(fixture, 'denied')
    review(fixture, pending)
    const grantId = approve(fixture, authorized)
    review(fixture, denied)
    expect(fixture.gate.respond({ ...response(denied), decision: 'deny' }, fixture.ownerToken))
      .toEqual({ ok: true, status: 'denied' })
    expect(fixture.gate.respond(response(denied), fixture.ownerToken)).toEqual({ ok: false, code: 'already_decided' })
    expect(currentEffect(fixture, denied)?.status).toBe('prepared')

    fixture.setClock(() => expiresAt)
    expect(fixture.gate.respond(response(pending), fixture.ownerToken)).toEqual({ ok: false, code: 'expired' })
    expect(fixture.gate.dispatch(authorized.rawAction, grantId, authorized.version))
      .toEqual({ ok: false, code: 'expired' })
    fixture.reopen()
    fixture.setClock(() => issuedAt)
    expect(fixture.gate.review(pending.rawAction, pending.request, fixture.ownerToken))
      .toEqual({ decision: 'deny', code: 'expired' })
    expect(fixture.gate.respond(response(pending), fixture.ownerToken)).toEqual({ ok: false, code: 'expired' })
    expect(fixture.gate.dispatch(authorized.rawAction, grantId, authorized.version))
      .toEqual({ ok: false, code: 'expired' })
    expect(currentEffect(fixture, pending)?.status).toBe('prepared')
    expect(currentEffect(fixture, authorized)?.status).toBe('authorized')
    expect(fixture.handoffs).toEqual([])
  })

  it.each(['revocation', 'policy change', 'device reenrollment', 'account reenrollment', 'cancellation', 'stale revision'] as const)(
    'blocks dispatch after %s',
    reason => {
      const fixture = openFixture()
      const seeded = seed(fixture, 'fence')
      const grantId = approve(fixture, seeded)
      let denial = 'permission_denied'
      switch (reason) {
        case 'revocation':
          expect(fixture.gate.revoke(grantId, fixture.ownerToken)).toEqual({ ok: true })
          denial = 'revoked'
          break
        case 'policy change':
          fixture.profile(profile => ({ ...profile, policyVersion: 'policy-2' }))
          break
        case 'device reenrollment':
          fixture.profile(profile => ({
            ...profile,
            verifiedDevices: profile.verifiedDevices.map(device => device.deviceId === ownerMetadata.deviceId
              ? { ...device, verifiedAt: reenrolledAt } : device),
          }))
          break
        case 'account reenrollment':
          fixture.profile(profile => ({
            ...profile,
            verifiedAccounts: profile.verifiedAccounts.map(account => account.accountId === sourceMetadata.accountId
              ? { ...account, verifiedAt: reenrolledAt } : account),
          }))
          break
        case 'cancellation':
          expect(fixture.store.applyCommand({
            type: 'work.cancel', taskId: seeded.ref.taskId, commandId: 'cancel-fixture',
            expectedVersion: seeded.version, payload: {},
          }, seeded.context)).toMatchObject({ ok: true, state: { task: { generation: 2 } } })
          denial = 'stale_attempt'
          break
        case 'stale revision':
          expect(fixture.store.applyEvent(seeded.ref, {
            type: 'ready', at: issuedAt, expectedVersion: seeded.version,
            attemptId: seeded.rawAction.attemptId, generation: seeded.rawAction.generation, artifactIds: [],
          })).toMatchObject({ ok: true, state: { task: { status: 'verifying', version: seeded.version + 1 } } })
          denial = 'version_conflict'
          break
      }
      expect(fixture.gate.dispatch(seeded.rawAction, grantId, seeded.version)).toEqual({ ok: false, code: denial })
      expect(currentEffect(fixture, seeded)?.status).toBe('authorized')
      expect(fixture.handoffs).toEqual([])
    },
  )

  it('commits the claim before handing off the immutable exact action once', () => {
    const fixture = openFixture()
    const seeded = seed(fixture, 'handoff')
    const other = seed(fixture, 'other-operation')
    const grantId = approve(fixture, seeded)
    approve(fixture, other)
    expect(fixture.gate.dispatch(other.rawAction, grantId, other.version))
      .toEqual({ ok: false, code: 'permission_denied' })
    const exact = structuredClone(seeded.rawAction)
    seeded.rawAction.payload.summary = 'public: changed after approval'
    let statusAtHandoff: unknown
    let reentrant: unknown
    fixture.observeHandoff(() => {
      const reader = new DatabaseSync(join(fixture.directory, DATABASE_FILENAME), { readOnly: true })
      try {
        statusAtHandoff = reader.prepare(`
          SELECT e.record ->> '$.status' AS status, d.grant_id AS grantId
          FROM effects e JOIN action_dispatches d USING (operation_id) WHERE e.operation_id = ?
        `).get(exact.operationId)
      } finally {
        reader.close()
      }
      reentrant = fixture.gate.dispatch(exact, grantId, seeded.version)
    })

    expect(fixture.gate.dispatch(exact, grantId, seeded.version)).toEqual({ ok: true, status: 'dispatching' })
    expect(statusAtHandoff).toEqual({ status: 'dispatching', grantId })
    expect(reentrant).toEqual({ ok: false, code: 'already_claimed' })
    expect(fixture.gate.dispatch(exact, grantId, seeded.version)).toEqual({ ok: false, code: 'already_claimed' })
    expect(fixture.handoffs).toEqual([canonical(exact).action])
    const sent = fixture.handoffs[0]
    expect(Object.isFrozen(sent)).toBe(true)
    expect(Object.isFrozen(sent?.payload)).toBe(true)
    if (sent?.payload && typeof sent.payload === 'object' && 'tags' in sent.payload) {
      expect(Object.isFrozen(sent.payload.tags)).toBe(true)
    } else {
      throw new Error('Expected the exact nested payload at handoff')
    }
  })

  it('rolls back the claim on a real SQLite update failure, then permits the exact retry', () => {
    const fixture = openFixture()
    const seeded = seed(fixture, 'rollback')
    const grantId = approve(fixture, seeded)
    fixture.reopen(`
      CREATE TRIGGER dispatch_failure BEFORE UPDATE ON effects
        WHEN new.operation_id = 'operation-rollback' AND (new.record ->> '$.status') = 'dispatching'
        BEGIN SELECT RAISE(ABORT, 'fixture dispatch write failure'); END;
    `)
    expect(() => fixture.gate.dispatch(seeded.rawAction, grantId, seeded.version))
      .toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(currentEffect(fixture, seeded)?.status).toBe('authorized')
    expect(fixture.handoffs).toEqual([])

    fixture.reopen('DROP TRIGGER dispatch_failure')
    expect(fixture.gate.dispatch(seeded.rawAction, grantId, seeded.version))
      .toEqual({ ok: true, status: 'dispatching' })
    expect(fixture.handoffs).toHaveLength(1)
  })

  it('retains a consumed claim after an uncertain handoff and refuses replay after reopen', () => {
    const fixture = openFixture()
    const seeded = seed(fixture, 'uncertain')
    const grantId = approve(fixture, seeded)
    fixture.observeHandoff(() => { throw new Error('Fixture lost the provider response') })
    expect(fixture.gate.dispatch(seeded.rawAction, grantId, seeded.version))
      .toEqual({ ok: false, code: 'outcome_uncertain' })
    expect(currentEffect(fixture, seeded)).toMatchObject({ status: 'dispatching', grantId })
    fixture.reopen()
    expect(fixture.gate.dispatch(seeded.rawAction, grantId, seeded.version))
      .toEqual({ ok: false, code: 'already_claimed' })
    expect(fixture.handoffs).toHaveLength(1)
  })

  it('keeps the claim consumed without handoff when commit crosses the expiry boundary', () => {
    const fixture = openFixture()
    const seeded = seed(fixture, 'commit-expiry')
    const grantId = approve(fixture, seeded)
    let clockReads = 0
    fixture.setClock(() => clockReads++ === 0 ? issuedAt : expiresAt)
    expect(fixture.gate.dispatch(seeded.rawAction, grantId, seeded.version))
      .toEqual({ ok: false, code: 'expired' })
    expect(clockReads).toBe(2)
    expect(currentEffect(fixture, seeded)).toMatchObject({ status: 'dispatching', grantId })
    expect(fixture.handoffs).toEqual([])

    fixture.reopen()
    fixture.setClock(() => issuedAt)
    expect(fixture.gate.dispatch(seeded.rawAction, grantId, seeded.version))
      .toEqual({ ok: false, code: 'already_claimed' })
    expect(fixture.handoffs).toEqual([])
  })
})
