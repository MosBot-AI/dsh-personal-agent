import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  approvalSchema,
  clientIdSchema,
  deviceIdSchema,
  effectSchema,
  grantIdSchema,
  grantSchema,
  operationIdSchema,
  requestIdSchema,
  sessionIdSchema,
  sha256DigestSchema,
  utcInstantSchema,
  versionSchema,
  type Approval,
  type Effect,
  type Grant,
  type GrantId,
  type Profile,
  type TaskId,
  type UtcInstant,
} from '../domain/model.js'
import { workStateSchema } from '../domain/transitions.js'
import { StorageError, transaction } from '../storage/schema.js'
import { canonicalizeAction, matchesActionBinding, type Action, type ActionBinding } from './grants.js'
import type { IdentityBoundary, OwnerIdentity } from './identity.js'

type Proposal = NonNullable<ReturnType<typeof canonicalizeAction>>
type SavedProposal = Proposal & { verifiedAt: UtcInstant }
type DatabaseAccess = <T>(operation: (db: DatabaseSync) => T) => T

export interface ActionRoute {
  readonly binding: ActionBinding
  /** Check payload shape, resource ownership and disclosure in the trusted action scope without I/O. */
  readonly permitsPayload: (payload: Action['payload'], action: Action) => boolean
  /** Start the authorized operation synchronously, before returning to the event loop. */
  readonly handoff: (action: Action, current: () => boolean) => undefined
}

export interface ActionGateOptions {
  readonly identity: IdentityBoundary
  readonly routes: readonly ActionRoute[]
  /** A trusted, synchronous clock without side effects. */
  readonly now?: () => UtcInstant
}

type DenialCode =
  | 'invalid_input'
  | 'permission_denied'
  | 'action_changed'
  | 'stale_attempt'
  | 'version_conflict'
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'already_decided'
  | 'already_claimed'
  | 'recovery_required'
  | 'outcome_uncertain'

type Failure = { ok: false; code: DenialCode }
export type ActionDecision =
  | { decision: 'deny'; code: DenialCode }
  | { decision: 'ask'; action: Action; approval: Approval; version: number }
  | { decision: 'allow'; grantId: GrantId }

type Approver = Pick<OwnerIdentity, 'clientId' | 'deviceId' | 'sessionId' | 'verifiedAt'>

interface ApprovalEntry {
  operationId: Action['operationId']
  approval: Approval
  primary: Approver
  mobile?: Approver
  version: number
}

export type PendingApproval = Extract<ActionDecision, { decision: 'ask' }> & { mobileDeviceId?: Approver['deviceId'] }

interface GrantEntry {
  grant: Grant
  expired: boolean
}

const requestSchema = z.strictObject({ requestId: requestIdSchema, expiresAt: utcInstantSchema })
const reviewFence = { requestId: requestIdSchema, expectedVersion: versionSchema, digest: sha256DigestSchema }
const responseSchema = z.strictObject({ ...reviewFence, decision: z.enum(['approve', 'deny']) })
const handoffSchema = z.strictObject(reviewFence)
const approverSchema = z.strictObject({
  clientId: clientIdSchema, deviceId: deviceIdSchema, sessionId: sessionIdSchema, verifiedAt: utcInstantSchema,
})
const reviewable = new Set(['queued', 'running', 'verifying', 'waiting_approval'])
const dispatchable = new Set(['running', 'verifying'])
const fail = (code: DenialCode): Failure => ({ ok: false, code })
const deny = (code: DenialCode): ActionDecision => ({ decision: 'deny', code })

function corrupt(): never {
  throw new StorageError('corrupt', 'Stored action authorization failed validation')
}

function readJson(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 * 1024) return corrupt()
  try {
    return JSON.parse(value)
  } catch {
    return corrupt()
  }
}

function parseRecord<T>(value: unknown, schema: { parse(input: unknown): T }): T {
  const input = readJson(value)
  try {
    return schema.parse(input)
  } catch {
    return corrupt()
  }
}

function scopeMatches(left: Pick<Action, 'ownerId' | 'profileId'>, right: Pick<Action, 'ownerId' | 'profileId'>) {
  return left.ownerId === right.ownerId && left.profileId === right.profileId
}

function approvalScope(action: Action) {
  return {
    kind: action.kind,
    resourceRef: action.resourceRef,
    accountId: action.accountId,
    recipient: action.recipient,
    dataScope: [...action.dataScope],
    limits: { maxUses: 1 },
  }
}

function matchesScope(stored: Grant['action'], action: Action): boolean {
  return stored.kind === action.kind && stored.resourceRef === action.resourceRef
    && stored.accountId === action.accountId && stored.recipient === action.recipient
    && stored.limits.maxUses === 1 && stored.dataScope.length === action.dataScope.length
    && stored.dataScope.every((label, index) => label === action.dataScope[index])
}

function readProposal(db: DatabaseSync, operationId: Action['operationId']): SavedProposal | undefined {
  const row = db.prepare('SELECT * FROM action_proposals WHERE operation_id = ?').get(operationId)
  if (!row) return undefined
  const proposal = canonicalizeAction(readJson(row.canonical))
  const enrollment = utcInstantSchema.safeParse(row.account_verified_at)
  if (!proposal || !enrollment.success || proposal.digest !== row.digest || proposal.canonical !== row.canonical) return corrupt()
  const { action } = proposal
  if (action.operationId !== operationId || action.ownerId !== row.owner_id || action.profileId !== row.profile_id
    || action.taskId !== row.task_id || action.attemptId !== row.attempt_id || action.generation !== row.generation) {
    return corrupt()
  }
  return { ...proposal, verifiedAt: enrollment.data }
}

function readApproval(db: DatabaseSync, operationId: Action['operationId']): ApprovalEntry | undefined {
  const row = db.prepare(`SELECT a.*, m.client_id AS mobile_client_id, m.device_id AS mobile_device_id,
    m.session_id AS mobile_session_id, m.device_verified_at AS mobile_verified_at
    FROM action_approvals a LEFT JOIN mobile_approval_reviews m ON m.request_id = a.request_id
    WHERE a.operation_id = ?`).get(operationId)
  if (!row) return undefined
  const approval = parseRecord(row.record, approvalSchema)
  if (approval.id !== row.request_id || approval.status !== row.status || typeof row.version !== 'number') return corrupt()
  const primary = approverSchema.safeParse({
    clientId: row.client_id, deviceId: row.device_id, sessionId: row.session_id, verifiedAt: row.device_verified_at,
  })
  if (!primary.success) return corrupt()
  if (row.mobile_device_id === null) return { operationId, approval, primary: primary.data, version: row.version }
  const mobile = approverSchema.safeParse({
    clientId: row.mobile_client_id, deviceId: row.mobile_device_id,
    sessionId: row.mobile_session_id, verifiedAt: row.mobile_verified_at,
  })
  return mobile.success ? { operationId, approval, primary: primary.data, mobile: mobile.data, version: row.version } : corrupt()
}

function readGrant(db: DatabaseSync, operationId: Action['operationId']): GrantEntry | undefined {
  const row = db.prepare(`
    SELECT grant_id, request_id, record, expired_at FROM action_grants WHERE operation_id = ?
  `).get(operationId)
  if (!row) return undefined
  const grant = parseRecord(row.record, grantSchema)
  if (grant.id !== row.grant_id || grant.approvalEvidence.requestId !== row.request_id) return corrupt()
  if (row.expired_at !== null && !utcInstantSchema.safeParse(row.expired_at).success) return corrupt()
  return { grant, expired: row.expired_at !== null }
}

function isApprover(entry: ApprovalEntry, owner: OwnerIdentity, approver = entry.primary): boolean {
  return scopeMatches(entry.approval, owner) && entry.approval.policyVersion === owner.policyVersion
    && approver.deviceId === owner.deviceId && approver.clientId === owner.clientId
    && approver.sessionId === owner.sessionId && approver.verifiedAt === owner.verifiedAt
}

function responderEnrolled(entry: ApprovalEntry, profile: Profile): boolean {
  const responder = entry.mobile ?? entry.primary
  const devices = profile.verifiedDevices.filter(device => device.deviceId === responder.deviceId)
  return devices.length === 1 && devices[0]?.verifiedAt === responder.verifiedAt
}

function approvalMatches(entry: ApprovalEntry, proposal: Proposal): boolean {
  const { approval } = entry
  const { action, digest } = proposal
  return scopeMatches(approval, action) && approval.policyVersion === action.policyVersion
    && approval.taskId === action.taskId && approval.attemptId === action.attemptId
    && approval.generation === action.generation && approval.action.payloadDigest === digest
    && matchesScope(approval.action, action)
}

function expireApproval(db: DatabaseSync, entry: ApprovalEntry): void {
  db.prepare(`
    UPDATE action_approvals SET status = 'expired', record = ?, version = version + 1
    WHERE request_id = ? AND status = 'pending' AND version = ?
  `).run(JSON.stringify({ ...entry.approval, status: 'expired' }), entry.approval.id, entry.version)
}

function grantError(db: DatabaseSync, proposal: Proposal, entry: ApprovalEntry, saved: GrantEntry, at: UtcInstant): DenialCode | undefined {
  const { approval } = entry
  const { grant } = saved
  const { action } = proposal
  const responder = entry.mobile ?? entry.primary
  if (!approvalMatches(entry, proposal) || approval.status !== 'approved'
    || !scopeMatches(grant, action) || grant.approvalEvidence.requestId !== approval.id
    || grant.policyVersion !== action.policyVersion || grant.expiresAt !== approval.expiresAt
    || approval.responseActor?.deviceId !== responder.deviceId || grant.approvingPrincipal.deviceId !== responder.deviceId
    || !matchesScope(grant.action, action)) return 'permission_denied'
  if (grant.revokedAt !== undefined) return 'revoked'
  if (db.prepare('SELECT 1 FROM action_dispatches WHERE grant_id = ?').get(grant.id)) return 'already_claimed'
  if (saved.expired) return 'expired'
  if (at >= grant.expiresAt) {
    db.prepare('UPDATE action_grants SET expired_at = ? WHERE grant_id = ? AND expired_at IS NULL')
      .run(at, grant.id)
    return 'expired'
  }
  if (at < grant.approvalEvidence.approvedAt) return 'permission_denied'
  return undefined
}

/** The action gate shares the work store's synchronous writer and never exposes it to adapters. */
export function createActionGate(access: DatabaseAccess, options: ActionGateOptions, permit = (_db: DatabaseSync) => true) {
  const { identity } = options
  const now = options.now ?? (() => utcInstantSchema.parse(new Date().toISOString()))
  const routes = options.routes.map(({ binding, permitsPayload, handoff }) => Object.freeze({
    binding: Object.freeze({
      ...binding,
      dataScope: Object.freeze([...binding.dataScope]),
      limits: Object.freeze({ ...binding.limits }),
    }),
    permitsPayload,
    handoff,
  }))

  function routeFor(action: Action): ActionRoute | undefined {
    const matching = routes.filter(route => matchesActionBinding(action, route.binding))
    const route = matching.length === 1 ? matching[0] : undefined
    if (!route) return undefined
    try {
      return route.permitsPayload(action.payload, action) === true ? route : undefined
    } catch {
      return undefined
    }
  }

  function currentPolicy(action: Action) {
    const profile = identity.currentProfile(action.profileId)
    if (profile?.ownerId !== action.ownerId || profile.policyVersion !== action.policyVersion) return undefined
    const accounts = profile.verifiedAccounts.filter(item => item.sourceInstanceId === action.sourceInstanceId
      && item.accountId === action.accountId)
    const account = accounts.length === 1 ? accounts[0] : undefined
    return account && { profile, account }
  }

  function checkWork(db: DatabaseSync, proposal: Proposal, allowedPhases: ReadonlySet<string>) {
    const { action, digest } = proposal
    const row = db.prepare(`
      SELECT t.record AS task, a.record AS attempt, e.record AS effect
      FROM tasks t JOIN attempts a ON a.id = t.attempt_id AND a.task_id = t.id
      JOIN effects e ON e.operation_id = ? AND e.task_id = t.id
      WHERE t.id = ? AND t.owner_id = ? AND t.profile_id = ?
    `).get(action.operationId, action.taskId, action.ownerId, action.profileId)
    if (!row) return fail('not_found')
    const decoded = workStateSchema.safeParse({ task: readJson(row.task), attempt: readJson(row.attempt) })
    if (!decoded.success) return corrupt()
    const state = decoded.data
    const effect = parseRecord(row.effect, effectSchema)
    if (state.task.generation !== action.generation || state.attempt.generation !== action.generation
      || state.attempt.id !== action.attemptId || !allowedPhases.has(state.task.status)
      || effect.attemptId !== action.attemptId || effect.generation !== action.generation) return fail('stale_attempt')
    if (effect.payloadDigest !== digest) return fail('action_changed')
    if (state.attempt.mandate.policyVersion !== action.policyVersion
      || !state.attempt.scope?.capabilities.includes(action.kind)
      || !action.dataScope.every(label => state.attempt.scope?.dataScope.includes(label))) return fail('permission_denied')
    return { ok: true as const, state, effect }
  }

  function review(input: unknown, requestInput: unknown, ownerToken: unknown,
    prepare?: (db: DatabaseSync, proposal: Proposal, at: UtcInstant) => DenialCode | undefined): ActionDecision {
    const proposal = canonicalizeAction(input)
    const request = requestSchema.safeParse(requestInput)
    if (!proposal || !request.success) return deny('invalid_input')
    const { action, canonical, digest } = proposal
    const owner = identity.resolveOwner(ownerToken)
    if (!owner || !scopeMatches(action, owner) || owner.policyVersion !== action.policyVersion
      || !routeFor(action)) return deny('permission_denied')

    return access(db => transaction(db, () => {
      if (!permit(db)) return deny('recovery_required')
      const at = now()
      const current = currentPolicy(action)
      if (!current) return deny('permission_denied')
      const existing = readProposal(db, action.operationId)
      if (!existing && prepare) {
        if (request.data.expiresAt <= at) return deny('expired')
        if (db.prepare('SELECT 1 FROM action_approvals WHERE request_id = ?').get(request.data.requestId)) return deny('already_decided')
        const denied = prepare(db, proposal, at)
        if (denied) return deny(denied)
      }
      const work = checkWork(db, proposal, reviewable)
      if (!work.ok) {
        if (prepare && !existing) throw new StorageError('invalid_input', 'Prepared work did not match the exact action')
        return deny(work.code)
      }
      if (existing) {
        if (existing.canonical !== canonical) return deny('action_changed')
        if (existing.verifiedAt !== current.account.verifiedAt) return deny('permission_denied')
        const entry = readApproval(db, action.operationId)
        if (!entry || !approvalMatches(entry, existing)) return corrupt()
        if (!isApprover(entry, owner)) return deny('permission_denied')
        if (entry.approval.status === 'expired') return deny('expired')
        if (entry.approval.status === 'pending') {
          if (at >= entry.approval.expiresAt) {
            expireApproval(db, entry)
            return deny('expired')
          }
          return { decision: 'ask', action: existing.action, approval: entry.approval, version: entry.version }
        }
        const grant = readGrant(db, action.operationId)
        if (!grant || entry.approval.status !== 'approved') return deny('already_decided')
        if (!responderEnrolled(entry, current.profile)) return deny('permission_denied')
        const error = grantError(db, proposal, entry, grant, at)
        if (error) return deny(error)
        if (work.effect.status !== 'authorized' || work.effect.grantId !== grant.grant.id) return deny('permission_denied')
        return { decision: 'allow', grantId: grant.grant.id }
      }
      if (request.data.expiresAt <= at) return deny('expired')
      if (work.effect.status !== 'prepared') {
        if (prepare) throw new StorageError('invalid_input', 'Prepared action has an invalid effect phase')
        return deny('already_claimed')
      }
      if (db.prepare('SELECT 1 FROM action_approvals WHERE request_id = ?').get(request.data.requestId)) {
        return deny('already_decided')
      }
      const approval = approvalSchema.parse({
        kind: 'approval',
        id: request.data.requestId,
        ownerId: action.ownerId,
        profileId: action.profileId,
        taskId: action.taskId,
        attemptId: action.attemptId,
        generation: action.generation,
        displayText: 'Review the exact action and its disclosure scope.',
        expiresAt: request.data.expiresAt,
        action: { ...approvalScope(action), payloadDigest: digest },
        policyVersion: action.policyVersion,
        status: 'pending',
      })
      db.prepare(`
        INSERT INTO action_proposals
          (operation_id, owner_id, profile_id, task_id, attempt_id, generation, canonical, digest, account_verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(action.operationId, action.ownerId, action.profileId, action.taskId, action.attemptId,
        action.generation, canonical, digest, current.account.verifiedAt)
      db.prepare(`
        INSERT INTO action_approvals
          (request_id, operation_id, record, client_id, session_id, device_id, device_verified_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(approval.id, action.operationId, JSON.stringify(approval), owner.clientId, owner.sessionId,
        owner.deviceId, owner.verifiedAt)
      return { decision: 'ask', action, approval, version: 0 }
    }))
  }

  function inspect(ownerToken: unknown, taskId: TaskId, kind: string) {
    const owner = identity.resolveOwner(ownerToken)
    if (!owner) return undefined
    return access(db => {
      const row = db.prepare(`SELECT operation_id FROM action_proposals
        WHERE owner_id = ? AND profile_id = ? AND task_id = ? AND (canonical ->> '$.kind') = ?
        ORDER BY rowid DESC LIMIT 1`).get(owner.ownerId, owner.profileId, taskId, kind)
      if (!row) return undefined
      const operationId = operationIdSchema.parse(row.operation_id)
      const proposal = readProposal(db, operationId)
      const entry = readApproval(db, operationId)
      if (!proposal || !entry || !approvalMatches(entry, proposal)) return corrupt()
      if (!isApprover(entry, owner)) return undefined
      const grant = readGrant(db, operationId)?.grant
      return { action: proposal.action, digest: proposal.digest, approval: entry.approval, version: entry.version, grant }
    })
  }

  /** Show pending reviews only to the original owner client and the exact assigned device. */
  function pending(ownerToken: unknown, taskIds: readonly TaskId[]): PendingApproval[] {
    const owner = identity.resolveOwner(ownerToken)
    const ids = taskIds.slice(0, 64)
    if (!owner || ids.length === 0) return []
    const binding = [owner.clientId, owner.sessionId, owner.deviceId, owner.verifiedAt] as const
    return access(db => transaction(db, () => {
      const rows = db.prepare(`
        SELECT a.operation_id FROM action_approvals a LEFT JOIN mobile_approval_reviews m ON m.request_id = a.request_id
        WHERE a.owner_id = ? AND a.profile_id = ? AND a.status = 'pending'
          AND ((a.client_id = ? AND a.session_id = ? AND a.device_id = ? AND a.device_verified_at = ?)
            OR (m.client_id = ? AND m.session_id = ? AND m.device_id = ? AND m.device_verified_at = ?))
          AND a.task_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY a.rowid DESC LIMIT 64
      `).all(owner.ownerId, owner.profileId, ...binding, ...binding, ...ids)
      const result: PendingApproval[] = []
      const at = now()
      for (const row of rows) {
        const operation = operationIdSchema.safeParse(row.operation_id)
        if (!operation.success) return corrupt()
        const entry = readApproval(db, operation.data)
        if (!entry) return corrupt()
        if (!isApprover(entry, owner) && !(entry.mobile && isApprover(entry, owner, entry.mobile))) continue
        const review = currentReview(db, entry, at)
        if (!review.ok) continue
        result.push({ decision: 'ask', action: review.proposal.action, approval: entry.approval, version: entry.version,
          ...(entry.mobile ? { mobileDeviceId: entry.mobile.deviceId } : {}) })
      }
      return result
    }))
  }

  function findReview(db: DatabaseSync, requestId: Approval['id'], owner: OwnerIdentity): ApprovalEntry | undefined {
    const row = db.prepare(`
      SELECT operation_id FROM action_approvals WHERE request_id = ? AND owner_id = ? AND profile_id = ?
    `).get(requestId, owner.ownerId, owner.profileId)
    if (!row) return undefined
    const operation = operationIdSchema.safeParse(row.operation_id)
    if (!operation.success) return corrupt()
    return readApproval(db, operation.data) ?? corrupt()
  }

  function currentReview(db: DatabaseSync, entry: ApprovalEntry, at: UtcInstant, digest?: string) {
    if (at >= entry.approval.expiresAt) {
      expireApproval(db, entry)
      return fail('expired')
    }
    if (digest !== undefined && entry.approval.action.payloadDigest !== digest) return fail('action_changed')
    const proposal = readProposal(db, entry.operationId)
    if (!proposal || !approvalMatches(entry, proposal)) return corrupt()
    if (!routeFor(proposal.action) || currentPolicy(proposal.action)?.account.verifiedAt !== proposal.verifiedAt) {
      return fail('permission_denied')
    }
    const work = checkWork(db, proposal, reviewable)
    if (!work.ok) return work
    if (work.effect.status !== 'prepared') return fail('already_claimed')
    return { ok: true as const, proposal, work }
  }

  function checkReview(db: DatabaseSync, entry: ApprovalEntry, fence: z.output<typeof handoffSchema>, at: UtcInstant) {
    if (entry.approval.status === 'expired') return fail('expired')
    if (entry.approval.status !== 'pending') return fail('already_decided')
    if (entry.version !== fence.expectedVersion) return fail('version_conflict')
    return currentReview(db, entry, at, fence.digest)
  }

  /** Only the original authenticated owner can move or recall a pending review. */
  function assignMobileReview(input: unknown, ownerToken: unknown, targetToken: unknown):
  | Failure | { ok: true } {
    const owner = identity.resolveOwner(ownerToken)
    const target = targetToken === null ? null : identity.resolveOwner(targetToken)
    if (!owner || target === undefined || (target && (!scopeMatches(owner, target) || target.deviceId === owner.deviceId))) {
      return fail('permission_denied')
    }
    const fence = handoffSchema.safeParse(input)
    if (!fence.success) return fail('invalid_input')
    return access(db => transaction(db, () => {
      if (!permit(db)) return fail('recovery_required')
      const entry = findReview(db, fence.data.requestId, owner)
      if (!entry) return fail('not_found')
      if (!isApprover(entry, owner)) return fail('permission_denied')
      const review = checkReview(db, entry, fence.data, now())
      if (!review.ok) return review
      if (!target && !entry.mobile) return fail('not_found')
      const { requestId, expectedVersion } = fence.data
      const update = db.prepare(`UPDATE action_approvals SET version = version + 1
        WHERE request_id = ? AND status = 'pending' AND version = ?`).run(requestId, expectedVersion)
      if (update.changes !== 1) return fail('version_conflict')
      if (target) {
        db.prepare(`INSERT INTO mobile_approval_reviews (request_id, device_id, client_id, session_id, device_verified_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (request_id) DO UPDATE SET device_id = excluded.device_id,
          client_id = excluded.client_id, session_id = excluded.session_id, device_verified_at = excluded.device_verified_at`)
          .run(requestId, target.deviceId, target.clientId, target.sessionId, target.verifiedAt)
      } else db.prepare('DELETE FROM mobile_approval_reviews WHERE request_id = ?').run(requestId)
      return { ok: true }
    }))
  }

  function respond(input: unknown, ownerToken: unknown):
  | Failure | { ok: true; status: 'denied' } | { ok: true; status: 'approved'; grantId: GrantId } {
    const owner = identity.resolveOwner(ownerToken)
    if (!owner) return fail('permission_denied')
    const response = responseSchema.safeParse(input)
    if (!response.success) return fail('invalid_input')
    const { requestId, expectedVersion, decision } = response.data
    return access(db => transaction(db, () => {
      if (!permit(db)) return fail('recovery_required')
      const entry = findReview(db, requestId, owner)
      if (!entry) return fail('not_found')
      if (!isApprover(entry, owner, entry.mobile ?? entry.primary)) return fail('permission_denied')
      const at = now()
      const review = checkReview(db, entry, response.data, at)
      if (!review.ok) return review
      const { proposal, work } = review
      const operationId = proposal.action.operationId
      const status = decision === 'approve' ? 'approved' : 'denied'
      const principal = { ownerId: owner.ownerId, profileId: owner.profileId, deviceId: owner.deviceId }
      const approved = approvalSchema.parse({ ...entry.approval, status, responseActor: principal })
      const update = db.prepare(`
        UPDATE action_approvals SET status = ?, record = ?, version = version + 1
        WHERE request_id = ? AND status = 'pending' AND version = ?
      `).run(status, JSON.stringify(approved), requestId, expectedVersion)
      if (update.changes !== 1) return fail('version_conflict')
      if (status === 'denied') return { ok: true, status }
      const grant = grantSchema.parse({
        id: grantIdSchema.parse(randomUUID()),
        ownerId: owner.ownerId,
        profileId: owner.profileId,
        approvingPrincipal: principal,
        action: approvalScope(proposal.action),
        expiresAt: approved.expiresAt,
        approvalEvidence: { requestId, approvedAt: at },
        policyVersion: owner.policyVersion,
      })
      db.prepare('INSERT INTO action_grants (grant_id, request_id, operation_id, record) VALUES (?, ?, ?, ?)')
        .run(grant.id, requestId, operationId, JSON.stringify(grant))
      writeEffect(db, work.effect, 'authorized', grant.id)
      return { ok: true, status, grantId: grant.id }
    }))
  }

  function revoke(grantInput: unknown, ownerToken: unknown): Failure | { ok: true } {
    const owner = identity.resolveOwner(ownerToken)
    if (!owner) return fail('permission_denied')
    const grantId = grantIdSchema.safeParse(grantInput)
    if (!grantId.success) return fail('invalid_input')
    return access(db => transaction(db, () => {
      const row = db.prepare(`
        SELECT record FROM action_grants WHERE grant_id = ? AND owner_id = ? AND profile_id = ?
      `).get(grantId.data, owner.ownerId, owner.profileId)
      if (!row) return fail('not_found')
      const grant = parseRecord(row.record, grantSchema)
      if (grant.id !== grantId.data) return corrupt()
      if (!scopeMatches(grant, owner)) return fail('permission_denied')
      if (grant.revokedAt === undefined) {
        db.prepare('UPDATE action_grants SET record = ? WHERE grant_id = ?')
          .run(JSON.stringify({ ...grant, revokedAt: now() }), grant.id)
      }
      return { ok: true }
    }))
  }

  /** Trusted coordinator entry point. Keep this capability out of model and remote tool handlers. */
  function dispatch(input: unknown, grantInput: unknown, versionInput: unknown):
  | Failure | { ok: true; status: 'dispatching' } {
    const proposed = canonicalizeAction(input)
    const grantId = grantIdSchema.safeParse(grantInput)
    const expectedVersion = versionSchema.safeParse(versionInput)
    if (!proposed || !grantId.success || !expectedVersion.success) return fail('invalid_input')
    const route = routeFor(proposed.action)
    if (!route) return fail('permission_denied')

    const claim = access(db => transaction(db, () => {
      const saved = readProposal(db, proposed.action.operationId)
      if (!saved) return fail('not_found')
      if (saved.canonical !== proposed.canonical) return fail('action_changed')
      const { action } = saved
      const current = currentPolicy(action)
      const approval = readApproval(db, action.operationId)
      const grantEntry = readGrant(db, action.operationId)
      if (!current || current.account.verifiedAt !== saved.verifiedAt || !approval
        || !grantEntry || grantEntry.grant.id !== grantId.data) {
        return fail('permission_denied')
      }
      if (!responderEnrolled(approval, current.profile)) return fail('permission_denied')
      const at = now()
      const error = grantError(db, saved, approval, grantEntry, at)
      if (error) return fail(error)
      if (!permit(db)) return fail('recovery_required')
      const work = checkWork(db, saved, dispatchable)
      if (!work.ok) return work
      if (work.state.task.version !== expectedVersion.data) return fail('version_conflict')
      const { grant } = grantEntry
      if (work.effect.status !== 'authorized' || work.effect.grantId !== grant.id) return fail('permission_denied')
      db.prepare('INSERT INTO action_dispatches (operation_id, grant_id, claimed_at) VALUES (?, ?, ?)')
        .run(action.operationId, grant.id, at)
      writeEffect(db, work.effect, 'dispatching', grant.id)
      return { ok: true as const, action, expiresAt: grant.expiresAt, approvedAt: grant.approvalEvidence.approvedAt,
        enrollment: saved.verifiedAt, responder: approval.mobile ?? approval.primary }
    }))
    if (!claim.ok) return claim
    // A synchronous commit may cross the expiry boundary. Leave its one-use
    // claim consumed and skip external work if time is no longer admissible.
    try {
      const handoffAt = now()
      if (handoffAt >= claim.expiresAt || handoffAt < claim.approvedAt) return fail('expired')
      // No await sits between COMMIT and the trusted adapter's start.
      const current = () => access(db => {
        if (!permit(db) || !routeFor(claim.action)) return false
        const policy = currentPolicy(claim.action)
        if (policy?.account.verifiedAt !== claim.enrollment) return false
        const devices = policy.profile.verifiedDevices.filter(device => device.deviceId === claim.responder.deviceId)
        if (devices.length !== 1 || devices[0]?.verifiedAt !== claim.responder.verifiedAt) return false
        const grant = readGrant(db, claim.action.operationId)
        const at = now()
        if (!grant || grant.grant.id !== grantId.data || grant.grant.revokedAt !== undefined
          || at < claim.approvedAt || at >= claim.expiresAt) return false
        const work = checkWork(db, proposed, dispatchable)
        return work.ok && work.state.task.version === expectedVersion.data && work.effect.status === 'dispatching'
          && work.effect.grantId === grantId.data
      })
      const started: unknown = route.handoff(claim.action, current)
      if (started !== undefined) {
        void Promise.resolve(started).catch(() => undefined)
        return fail('outcome_uncertain')
      }
      return { ok: true, status: 'dispatching' }
    } catch {
      return fail('outcome_uncertain')
    }
  }

  return Object.freeze({ review, inspect, pending, assignMobileReview, respond, revoke, dispatch })
}

function writeEffect(db: DatabaseSync, effect: Effect, status: 'authorized' | 'dispatching', grantId: GrantId): void {
  const next = effectSchema.parse({ ...effect, status, grantId })
  const update = db.prepare(`
    UPDATE effects SET record = ? WHERE operation_id = ? AND (record ->> '$.status') = ?
  `).run(JSON.stringify(next), effect.operationId, effect.status)
  if (update.changes !== 1) throw new StorageError('version_conflict', 'Effect status changed before commit')
}
