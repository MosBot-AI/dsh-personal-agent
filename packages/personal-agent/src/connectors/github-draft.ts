import { z } from 'zod'
import {
  accountIdSchema, artifactIdSchema, commandIdSchema, operationIdSchema, requestIdSchema, sourceInstanceIdSchema,
  taskIdSchema, utcInstantSchema, versionSchema, type OperationId, type UtcInstant,
} from '../domain/model.js'
import type { InboxResponse } from '../inbox/protocol.js'
import type { ActionRoute } from '../policy/dispatch.js'
import type { Action, ActionBinding } from '../policy/grants.js'
import type { IdentityBoundary, OwnerIdentity } from '../policy/identity.js'
import { confirmOwnedCancellation } from '../runtime/cancel.js'
import type { createRecovery } from '../runtime/recovery.js'
import type { EffectLookupRoute } from '../runtime/recovery-effects.js'
import type { WorkRef, WorkStore } from '../storage/store.js'
import type { PreparedBranch } from './github-branch.js'
import {
  contentDigest, DRAFT_ACTION, DRAFT_EXECUTOR, DRAFT_SOURCE, draftHead, draftInputSchema, draftMarker, draftPath,
  draftPayloadSchema, gitSha, type DraftPayload, type GitHubDraftConfig,
} from './github-draft-model.js'
import { createGitHubDraftProvider, type DraftProvider, type DraftProviderSession } from './github-write.js'
import { ConnectorError, connectorDigest } from './registry.js'

export const githubDraftRequests = [
  z.strictObject({ type: z.literal('github_draft_prepare'), taskId: taskIdSchema, expectedVersion: versionSchema,
    commandId: commandIdSchema.max(256), draft: draftInputSchema }),
  z.strictObject({ type: z.literal('github_draft_inspect'), taskId: taskIdSchema }),
  z.strictObject({ type: z.literal('github_draft_dispatch'), taskId: taskIdSchema, operationId: operationIdSchema, expectedVersion: versionSchema }),
  z.strictObject({ type: z.literal('github_draft_reconcile'), taskId: taskIdSchema, operationId: operationIdSchema }),
  z.strictObject({ type: z.literal('github_draft_revoke'), taskId: taskIdSchema, operationId: operationIdSchema }),
] as const
const requestSchema = z.discriminatedUnion('type', githubDraftRequests)
type Scope = Pick<OwnerIdentity, 'ownerId' | 'profileId'>
type Gate = ReturnType<WorkStore['createActionGate']>
type Recovery = ReturnType<typeof createRecovery>
type Stage = { payload: DraftPayload; branch: PreparedBranch; session: DraftProviderSession }

const REVIEW_MS = 15 * 60_000
const PREPARE_MS = 45_000
const DISPATCH_MS = 45_000
const LOOKUP_MS = 8000
const fail = (code: string): Extract<InboxResponse, { ok: false }> => ({ ok: false, code })

export function githubDraftAccount(config: GitHubDraftConfig, verifiedAt: UtcInstant) {
  return { sourceInstanceId: sourceInstanceIdSchema.parse(DRAFT_SOURCE),
    accountId: accountIdSchema.parse(`github:${config.binding.account.id}`), verifiedAt }
}

export function createGitHubDraftRuntime(config: GitHubDraftConfig, scope: Scope, provider: DraftProvider = createGitHubDraftProvider(config)) {
  const repository = config.binding.repository
  const binding: ActionBinding = {
    sourceInstanceId: sourceInstanceIdSchema.parse(DRAFT_SOURCE),
    accountId: accountIdSchema.parse(`github:${config.binding.account.id}`),
    kind: DRAFT_ACTION, resourceRef: `github:${repository.id}:${repository.owner}/${repository.name}`,
    dataScope: ['github-test-draft'], limits: { maxUses: 1 },
  }
  const life = new AbortController()
  const staged = new Map<OperationId, Stage>()
  const active = new Map<OperationId, Promise<void>>()

  function payloadFor(action: Action) {
    const parsed = draftPayloadSchema.safeParse(action.payload)
    if (!parsed.success || action.ownerId !== scope.ownerId || action.profileId !== scope.profileId) return undefined
    const payload = parsed.data
    return action.operationId === payload.operationId && payload.base === config.base
      && payload.repository.id === repository.id && payload.repository.owner === repository.owner
      && payload.repository.name === repository.name ? payload : undefined
  }

  const route: ActionRoute = {
    binding,
    permitsPayload: (_payload, action) => payloadFor(action) !== undefined,
    handoff(action, current) {
      const entry = staged.get(action.operationId)
      if (!entry || !current() || life.signal.aborted || !entry.session.current()) throw new Error('The draft handoff is no longer authorized')
      staged.delete(action.operationId)
      const signal = AbortSignal.any([life.signal, AbortSignal.timeout(DISPATCH_MS)])
      const permitted = () => !signal.aborted && current() && entry.session.current()
      const run = (async () => {
        if (!permitted()) return
        // Git starts synchronously after the persisted one-use claim. The lease
        // allows a new head only, and the provider call is fenced again afterward.
        await entry.branch.publish(signal)
        if (!permitted()) return
        const session = await provider.open(signal, permitted)
        if (!permitted() || !session.current()) return
        await session.createPull(entry.payload, signal)
      })().catch(() => { /* Readback determines acceptance, including timeout. */ })
        .finally(() => { active.delete(action.operationId); entry.branch.close() })
      active.set(action.operationId, run)
      return undefined
    },
  }

  const lookup: EffectLookupRoute = {
    ...scope, binding,
    async lookup(request, action) {
      const payload = payloadFor(action)
      if (!payload || active.has(action.operationId)) return { kind: 'unknown' }
      const signal = AbortSignal.any([life.signal, AbortSignal.timeout(LOOKUP_MS)])
      const session = await provider.open(signal, () => !signal.aborted)
      const receiptId = await session.lookup(payload, signal)
      if (!receiptId || signal.aborted || !session.current()) return { kind: 'unknown' }
      const { operationId, taskId, attemptId, generation, sourceInstanceId, accountId, digest, providerIdempotencyKey } = request
      return { kind: 'confirmed', operationId, taskId, attemptId, generation, sourceInstanceId, accountId, digest, receiptId,
        ...(providerIdempotencyKey === undefined ? {} : { providerIdempotencyKey }) }
    },
  }

  return {
    binding, route, lookup, payloadFor, provider,
    signal: life.signal,
    active: (operationId: OperationId) => active.get(operationId),
    stage(operationId: OperationId, entry: Stage) { staged.set(operationId, entry) },
    discard(operationId: OperationId) {
      staged.get(operationId)?.branch.close()
      staged.delete(operationId)
    },
    async close() {
      life.abort()
      for (const entry of staged.values()) entry.branch.close()
      staged.clear()
      await Promise.allSettled(active.values())
    },
  }
}

export type GitHubDraftRuntime = ReturnType<typeof createGitHubDraftRuntime>

export function createGitHubDraftService(options: {
  config: GitHubDraftConfig; runtime: GitHubDraftRuntime; store: WorkStore; gate: Gate; recovery: Recovery
  identity: IdentityBoundary; scope: Scope; now?: () => UtcInstant
}) {
  const { config, runtime, store, gate, recovery, identity, scope } = options
  const now = options.now ?? (() => utcInstantSchema.parse(new Date().toISOString()))
  const preparing = new Set<string>()

  function view(token: unknown, ref: WorkRef): InboxResponse {
    const saved = gate.inspect(token, ref.taskId, DRAFT_ACTION)
    if (!saved) return { ok: true, kind: 'github_draft', draft: null }
    const payload = runtime.payloadFor(saved.action)
    const effect = store.getEffect(ref, saved.action.operationId)
    if (!payload || !effect) return fail('not_found')
    return { ok: true, kind: 'github_draft', draft: {
      payload, digest: saved.digest, approval: saved.approval.status, effect: effect.status,
      ...(effect.status === 'confirmed' ? { receipt: effect.receipt.providerReceiptId } : {}),
      revoked: saved.grant?.revokedAt !== undefined,
    } }
  }

  function finishTask(action: Action, receipt: string) {
    const state = store.getWork(action)
    if (!state || state.task.status !== 'running' || state.attempt.id !== action.attemptId
      || state.task.generation !== action.generation || state.attempt.executor !== DRAFT_EXECUTOR) return
    const payload = runtime.payloadFor(action)
    if (!payload) return
    const id = artifactIdSchema.parse(`receipt-${connectorDigest([action.operationId])}`)
    const bytes = Buffer.from(`Verified draft pull request: ${receipt}\nContent SHA-256: ${payload.contentDigest}\n`)
    const artifact = store.artifacts.read(action, id) ?? store.artifacts.seal(action, {
      id, attemptId: action.attemptId, generation: action.generation, expectedVersion: state.task.version,
      mediaType: 'text/plain', visibility: 'private', sourceEventIds: state.task.provenance.sourceEventIds,
      bytes,
    })
    if (artifact.artifact.attemptId !== action.attemptId || artifact.generation !== action.generation
      || !Buffer.from(artifact.bytes).equals(bytes)) return
    store.applyEvent(action, { type: 'ready', at: now(), expectedVersion: state.task.version,
      attemptId: action.attemptId, generation: action.generation, artifactIds: [artifact.artifact.id] })
  }

  async function reconcile(action: Action) {
    if (runtime.active(action.operationId)) return fail('busy')
    const result = await recovery.reconcileEffect(action, action.operationId)
    if (runtime.signal.aborted) return fail('permission_denied')
    if (result.ok && result.effect.status === 'confirmed' && store.canDispatch()) {
      finishTask(action, result.effect.receipt.providerReceiptId)
    }
    const state = store.getWork(action)
    if (state?.task.status === 'cancelling' && state.attempt.id === action.attemptId && store.canDispatch()) {
      confirmOwnedCancellation(store, action, action.attemptId, action.generation, now())
    } else if (result.ok && state?.task.status === 'reconciliation_required' && state.attempt.id === action.attemptId
      && state.task.generation > action.generation && store.canDispatch()) {
      store.applyEvent(action, { type: 'reconcile', at: now(), expectedVersion: state.task.version,
        attemptId: action.attemptId, generation: action.generation, runtimeQuiescent: true, outcome: { status: 'cancelled' } })
    }
    return result.ok ? { ok: true as const } : fail(result.code)
  }

  async function handle(token: unknown, input: unknown, requestSignal?: AbortSignal): Promise<InboxResponse> {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_input')
    const request = parsed.data
    const owner = identity.resolveOwner(token)
    if (!owner || owner.ownerId !== scope.ownerId || owner.profileId !== scope.profileId) return fail('permission_denied')
    const ref: WorkRef = { ...scope, taskId: request.taskId }
    const state = store.getWork(ref)
    if (!state || state.task.projectId !== config.projectId) return fail('not_found')
    const ownerCurrent = () => identity.resolveOwner(token) === owner && !runtime.signal.aborted
    const allowed = () => ownerCurrent() && !requestSignal?.aborted
    const projectCurrent = () => store.getProject(scope, config.projectId)?.status === 'active'
    if (request.type === 'github_draft_inspect') return view(token, ref)
    const saved = gate.inspect(token, ref.taskId, DRAFT_ACTION)
    if (request.type === 'github_draft_reconcile') {
      if (!saved || saved.action.operationId !== request.operationId) return fail('not_found')
      const result = await reconcile(saved.action)
      return result.ok && allowed() ? view(token, ref) : result.ok ? fail('permission_denied') : result
    }
    if (!allowed() || !store.canDispatch() || !projectCurrent()) return fail('permission_denied')
    if (request.type === 'github_draft_revoke') {
      if (!saved?.grant || saved.action.operationId !== request.operationId) return fail('not_found')
      const result = gate.revoke(saved.grant.id, token)
      return result.ok ? view(token, ref) : result
    }
    if (preparing.has(ref.taskId)) return fail('busy')
    const signal = AbortSignal.any([runtime.signal, AbortSignal.timeout(PREPARE_MS), ...(requestSignal ? [requestSignal] : [])])
    const current = () => !signal.aborted && allowed() && store.canDispatch() && projectCurrent()
      && store.getWork(ref)?.task.version === request.expectedVersion
    preparing.add(ref.taskId)
    try {
      if (request.type === 'github_draft_prepare') {
        const operationId = operationIdSchema.parse(`github-draft-${connectorDigest([
          ref.ownerId, ref.profileId, ref.taskId, state.attempt.id, owner.clientId, request.commandId,
        ])}`)
        const digest = contentDigest(request.draft.content)
        const body = `${request.draft.body}\n\n${draftMarker(operationId, digest)}`
        if (saved) {
          const payload = runtime.payloadFor(saved.action)
          return payload?.operationId === operationId && payload.title === request.draft.title
            && payload.body === body && payload.content === request.draft.content ? view(token, ref) : fail('action_changed')
        }
        if (!current() || state.task.status !== 'queued' || state.attempt.startedAt !== undefined
          || state.attempt.mandate.policyVersion !== owner.policyVersion) return fail('version_conflict')
        const preparedAt = now()
        const session = await runtime.provider.open(signal, current)
        const baseSha = gitSha.parse(await session.baseHead(signal))
        const branchInput = { base: config.base, baseSha, head: draftHead(operationId),
          path: draftPath(operationId), content: request.draft.content, preparedAt }
        const branch = await session.prepare(branchInput, signal)
        try {
          if (!current() || !session.current()) return fail('version_conflict')
          const payload = draftPayloadSchema.parse({ ...branchInput, repository: config.binding.repository,
            operationId, headSha: branch.sha, title: request.draft.title, body, contentDigest: digest, draft: true })
          const action = { ...ref, ...runtime.binding, operationId, attemptId: state.attempt.id, generation: state.attempt.generation,
            policyVersion: owner.policyVersion, payload }
          const review = gate.prepareOwnerAction(action, { requestId: requestIdSchema.parse(operationId),
            expiresAt: new Date(Date.parse(preparedAt) + REVIEW_MS).toISOString() }, token, request.expectedVersion)
          return review.decision === 'deny' ? fail(review.code) : view(token, ref)
        } finally { branch.close() }
      }

      if (!saved?.grant || saved.action.operationId !== request.operationId || saved.approval.status !== 'approved'
        || saved.grant.revokedAt !== undefined || state.task.status !== 'running') return fail('permission_denied')
      if (saved.grant.expiresAt <= now()) return fail('expired')
      const effect = store.getEffect(ref, saved.action.operationId)
      if (effect?.status !== 'authorized') return fail('already_claimed')
      const payload = runtime.payloadFor(saved.action)
      if (!payload || !current()) return fail('version_conflict')
      // The dispatch lifetime is owned by the runtime, not by the HTTP request.
      const session = await runtime.provider.open(signal, () => ownerCurrent() && projectCurrent())
      if (await session.baseHead(signal) !== payload.baseSha) return fail('action_changed')
      const branch = await session.prepare(payload, signal)
      if (branch.sha !== payload.headSha || !current() || !session.current()) {
        branch.close()
        return fail('action_changed')
      }
      runtime.stage(saved.action.operationId, { payload, branch, session })
      try {
        const result = gate.dispatch(saved.action, saved.grant.id, request.expectedVersion)
        if (!result.ok) return result
        const running = runtime.active(saved.action.operationId)
        if (running) void running.then(async () => {
          if (runtime.signal.aborted) return
          await reconcile(saved.action)
        }).catch(() => undefined)
        return view(token, ref)
      } finally { runtime.discard(saved.action.operationId) }
    } catch (error) {
      if (error instanceof ConnectorError) return fail(error.code)
      return fail('provider_unavailable')
    } finally { preparing.delete(ref.taskId) }
  }

  function cancel(token: unknown, ref: WorkRef) {
    const state = store.getWork(ref)
    if (!state || state.attempt.executor !== DRAFT_EXECUTOR || !state.attempt.scope?.capabilities.includes(DRAFT_ACTION)) return
    if (state.task.status !== 'cancelling') return
    // An in-flight provider may still accept the request. The dispatch
    // completion path performs lookup and settles cancellation in that case.
    const action = gate.inspect(token, ref.taskId, DRAFT_ACTION)?.action
    if (action && runtime.active(action.operationId)) return
    confirmOwnedCancellation(store, ref, state.attempt.id, state.attempt.generation, now())
  }

  return { handle, cancel }
}

export type GitHubDraftService = ReturnType<typeof createGitHubDraftService>
