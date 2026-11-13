import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createGitHubDraftRuntime, createGitHubDraftService, githubDraftAccount } from '../../packages/personal-agent/src/connectors/github-draft.js'
import type { GitHubDraftConfig } from '../../packages/personal-agent/src/connectors/github-draft-model.js'
import type { DraftProvider } from '../../packages/personal-agent/src/connectors/github-write.js'
import { deviceIdSchema, profileSchema, projectSchema, taskIdSchema, utcInstantSchema } from '../../packages/personal-agent/src/domain/model.js'
import type { InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { createInboxService } from '../../packages/personal-agent/src/inbox/service.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import { createRecovery } from '../../packages/personal-agent/src/runtime/recovery.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'

export type View = NonNullable<Extract<InboxResponse, { kind: 'github_draft' }>['draft']>
export function draftView(result: InboxResponse): View {
  assert.ok(result.ok && result.kind === 'github_draft' && result.draft, JSON.stringify(result))
  return result.draft
}

export async function waitForDraftReceipt(
  h: Pick<Awaited<ReturnType<typeof makeDraftHarness>>, 'request' | 'taskId'>,
  operationId: View['payload']['operationId'],
  { pollWindowMs = 60_000, intervalMs = 1_000 } = {},
): Promise<string> {
  const deadline = performance.now() + pollWindowMs
  let effect: View['effect'] | undefined
  // The deadline stops new lookups. Finish any in-flight lookup before
  // disposing the host. The runtime bounds that lookup independently.
  do {
    const view = draftView(await h.request({ type: 'github_draft_inspect', taskId: h.taskId }))
    assert.equal(view.payload.operationId, operationId)
    effect = view.effect
    if (effect === 'confirmed' && view.receipt) return view.receipt
    if ((effect === 'uncertain' || effect === 'manual_reconciliation') && performance.now() < deadline) {
      const result = await h.request({ type: 'github_draft_reconcile', taskId: h.taskId, operationId })
      if (result.ok) {
        const reconciled = draftView(result)
        assert.equal(reconciled.payload.operationId, operationId)
        assert.ok(reconciled.effect === 'confirmed' && reconciled.receipt)
        return reconciled.receipt
      }
      if (result.code !== 'busy' && result.code !== 'outcome_uncertain') {
        throw new Error(`GitHub draft readback failed: ${result.code}`)
      }
    } else if (effect !== 'dispatching') {
      break
    }
    const remaining = deadline - performance.now()
    if (remaining > 0) await delay(Math.min(intervalMs, remaining))
  } while (performance.now() < deadline)
  throw new Error(`GitHub draft readback did not confirm the approved operation (last state: ${effect}).`)
}

export async function makeDraftHarness(config: GitHubDraftConfig, provider?: DraftProvider, clock = Date.now) {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-draft-store-'))
  const now = () => utcInstantSchema.parse(new Date(clock()).toISOString())
  const verifiedAt = now()
  const profile = profileSchema.parse({ id: 'draft-profile', ownerId: 'draft-owner', policyVersion: 'draft-policy',
    verifiedAccounts: [githubDraftAccount(config, verifiedAt)], verifiedDevices: [{ deviceId: 'draft-device', verifiedAt }] })
  const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
  const token = identity.bindOwner({ ownerId: profile.ownerId, profileId: profile.id, deviceId: 'draft-device',
    clientId: 'draft-client', sessionId: 'draft-session' })
  const owner = identity.resolveOwner(token)
  assert.ok(owner)
  const scope = { ownerId: owner.ownerId, profileId: owner.profileId }
  let store = openWorkStore(directory)
  function attach() {
    const runtime = createGitHubDraftRuntime(config, scope, provider)
    const gate = store.createActionGate({ identity, routes: [runtime.route], now })
    const recovery = createRecovery(store, { effects: { routes: [runtime.lookup], now }, now })
    const service = createGitHubDraftService({ config, runtime, store, gate, recovery, identity, scope, now })
    const inbox = createInboxService({ store, identity, actionGate: gate, now, resolveSession: () => true,
      githubDraft: { projectId: config.projectId, service } })
    return { runtime, gate, recovery, inbox }
  }
  let host = attach()
  try {
    await host.recovery.reconcileStartup()
    store.insertProject(projectSchema.parse({ ...scope, id: config.projectId, kind: 'project', title: 'Test drafts', purpose: 'Approve exact test work.',
      status: 'active', planRevision: 1, successCriteria: ['Verify provider readback.'], milestones: [], resourceRefs: [] }))
    const created = await host.inbox.handle(token, { type: 'create_task', commandId: 'create-draft', projectId: config.projectId,
      sessionId: 'primary', outcome: 'Prepare and verify one test draft pull request.' })
    assert.ok(created.ok && created.kind === 'updated' && created.taskId)
    const taskId = taskIdSchema.parse(created.taskId)
    const ref = { ...scope, taskId }
    return {
      scope, token, owner, taskId, ref,
      enrollReviewer() {
        const deviceId = deviceIdSchema.parse('draft-mobile-device')
        profile.verifiedDevices.push({ deviceId, verifiedAt })
        const token = identity.bindOwner({ ...scope, deviceId, clientId: 'draft-mobile-client', sessionId: 'draft-mobile-session' })
        assert.ok(token)
        return { token, revoke() {
          profile.verifiedDevices.splice(profile.verifiedDevices.findIndex(item => item.deviceId === deviceId), 1)
        } }
      },
      get runtime() { return host.runtime },
      get store() { return store },
      get gate() { return host.gate },
      request: (input: unknown) => host.inbox.handle(token, input),
      async approve(view: View, decision = 'approve') {
        const snapshot = await host.inbox.handle(token, { type: 'snapshot' })
        assert.ok(snapshot.ok && snapshot.kind === 'snapshot')
        const approval = snapshot.snapshot.approvals.find(item => item.taskId === taskId && item.digest === view.digest)
        assert.ok(approval)
        return host.inbox.handle(token, { type: 'approval', requestId: approval.id,
          expectedVersion: approval.version, digest: view.digest, decision })
      },
      version() { return store.getWork(ref)!.task.version },
      async reopen() {
        await host.runtime.close()
        store.close()
        store = openWorkStore(directory)
        host = attach()
        return host.recovery.reconcileStartup()
      },
      async close() {
        try { await host.runtime.close() } finally {
          store.close()
          rmSync(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await host.runtime.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
