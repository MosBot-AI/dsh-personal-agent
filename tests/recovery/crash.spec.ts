import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  accountIdSchema, deliverySchema, ownerIdSchema, profileIdSchema, profileSchema, taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import { canonicalizeAction, type Action, type ActionBinding } from '../../packages/personal-agent/src/policy/grants.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import type { OutboxSendRequest } from '../../packages/personal-agent/src/runtime/outbox.js'
import type { EffectLookupRequest } from '../../packages/personal-agent/src/runtime/recovery-effects.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { restoreWorkStoreBackup } from '../../packages/personal-agent/src/storage/restore.js'
import { openWorkStore, type WorkRef, type WorkStore } from '../../packages/personal-agent/src/storage/store.js'

const fixture = fileURLToPath(new URL('./fixtures/dispatch-crash.mjs', import.meta.url))
const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')

function prepare(kind: 'effect' | 'outbox' | 'restore' | 'normal', phase: 'before' | 'after' = 'before') {
  const root = mkdtempSync(join(tmpdir(), 'dshpa-crash-'))
  const directory = join(root, 'state')
  const ledger = join(root, 'fixture-provider.jsonl')
  let store: WorkStore | undefined
  onTestFinished(() => {
    try {
      store?.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  const result = spawnSync(process.execPath, [fixture, directory, ledger, kind, phase], {
    encoding: 'utf8', timeout: 15_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(kind === 'restore' || kind === 'normal' ? 0 : 86)
  const evidence = JSON.parse(result.stdout.trim())
  const ref: WorkRef = {
    ownerId: ownerIdSchema.parse(evidence.ref.ownerId),
    profileId: profileIdSchema.parse(evidence.ref.profileId),
    taskId: taskIdSchema.parse(evidence.ref.taskId),
  }
  const records = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  expect(records()).toHaveLength(phase === 'before' ? 0 : 1)
  const activeDirectory = kind === 'restore' ? join(root, 'restored') : directory
  if (kind === 'restore') restoreWorkStoreBackup(join(directory, DATABASE_FILENAME), activeDirectory)
  store = openWorkStore(activeDirectory)
  return {
    evidence, ref, records,
    get store() { return store! },
    reopen() {
      store?.close()
      store = openWorkStore(activeDirectory)
    },
  }
}

function actionOf(raw: unknown): Action {
  const decoded = canonicalizeAction(raw)
  if (!decoded) throw new Error('Crash fixture did not report a valid exact action')
  return decoded.action
}

function bindingOf(action: Action): ActionBinding {
  const { sourceInstanceId, accountId, kind, resourceRef, recipient, dataScope, limits } = action
  return { sourceInstanceId, accountId, kind, resourceRef, recipient, dataScope, limits }
}

function echo(request: EffectLookupRequest) {
  const { operationId, taskId, attemptId, generation, sourceInstanceId, accountId, digest, providerIdempotencyKey } = request
  return { operationId, taskId, attemptId, generation, sourceInstanceId, accountId, digest, providerIdempotencyKey }
}

describe('process-crash dispatch recovery', () => {
  it.each(['before', 'after'] as const)('does not replay an Effect after a crash %s provider acceptance', async phase => {
    const f = prepare('effect', phase)
    const { ref, evidence } = f
    const action = actionOf(evidence.action)
    const otherAction = actionOf(evidence.otherAction)
    const profile = profileSchema.parse(evidence.profile)
    const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
    const token = identity.bindOwner(evidence.metadata)
    expect(token).toBeDefined()
    let sends = 0
    let lookups = 0
    let outcome: 'wrong-account' | 'ledger' | 'definitive-failure' = 'wrong-account'
    const gate = f.store.createActionGate({ identity, now: () => at, routes: [{
      binding: bindingOf(action), permitsPayload: () => true,
      handoff() { sends++; return undefined },
    }] })
    const recovery = f.store.createEffectRecovery({ now: () => at, routes: [{
      ...ref, binding: bindingOf(action),
      lookup(request) {
        lookups++
        const accepted = f.records()[0]
        if (outcome === 'wrong-account') return { ...echo(request), accountId: 'wrong-account', kind: 'confirmed', receiptId: 'wrong-receipt' }
        if (outcome === 'definitive-failure') return { ...echo(request), kind: 'failed', failureReason: 'Fixture ruled out acceptance.' }
        return accepted ? { ...accepted, kind: 'confirmed' } : { kind: 'unknown' }
      },
    }] })

    expect(f.store.recoveryMode()).toBe('reconciling')
    expect(f.store.getEffect(ref, action.operationId)?.status).toBe('dispatching')
    expect(gate.dispatch(action, evidence.grantId, evidence.version)).toEqual({ ok: false, code: 'already_claimed' })
    expect(gate.dispatch(otherAction, evidence.otherGrantId, evidence.version)).toEqual({ ok: false, code: 'recovery_required' })
    expect(gate.review(otherAction, { requestId: 'unused', expiresAt: '2026-11-07T08:05:00.000Z' }, token))
      .toEqual({ decision: 'deny', code: 'recovery_required' })
    expect(recovery.classifyInterrupted()).toEqual({ effects: 1, deliveries: 0 })
    expect(recovery.classifyInterrupted()).toEqual({ effects: 0, deliveries: 0 })
    expect(f.store.getEffect(ref, action.operationId)?.status).toBe('uncertain')
    expect(await recovery.reconcile({ ...ref, ownerId: ownerIdSchema.parse('another-owner') }, action.operationId))
      .toEqual({ ok: false, code: 'not_found' })
    expect(lookups).toBe(0)
    expect(await recovery.reconcile(ref, action.operationId)).toEqual({ ok: false, code: 'outcome_uncertain' })
    expect(f.store.getEffect(ref, action.operationId)?.status).toBe('uncertain')
    outcome = 'ledger'
    const result = await recovery.reconcile(ref, action.operationId)
    if (phase === 'after') {
      expect(result).toMatchObject({ ok: true, effect: { status: 'confirmed', receipt: { providerReceiptId: 'effect-receipt' } } })
    } else {
      expect(result).toEqual({ ok: false, code: 'outcome_uncertain' })
      outcome = 'definitive-failure'
      expect(await recovery.reconcile(ref, action.operationId)).toMatchObject({ ok: true, effect: { status: 'failed' } })
    }
    expect(gate.dispatch(action, evidence.grantId, evidence.version)).toEqual({ ok: false, code: 'already_claimed' })
    expect(sends).toBe(0)
    expect(f.records()).toHaveLength(phase === 'before' ? 0 : 1)
    f.reopen()
    expect(f.store.getEffect(ref, action.operationId)?.status).toBe(phase === 'after' ? 'confirmed' : 'failed')
  }, 20_000)

  it.each(['before', 'after'] as const)('does not replay Outbox delivery after a crash %s provider acceptance', async phase => {
    const f = prepare('outbox', phase)
    const { ref, evidence } = f
    const delivery = deliverySchema.parse(evidence.message)
    const other = deliverySchema.parse(evidence.otherMessage)
    const accountId = accountIdSchema.parse(evidence.accountId)
    let wrongRoute = false
    let sends = 0
    let lookups = 0
    const outbox = f.store.createOutbox({ now: () => at, allowDisclosure: () => true, resolveRoute: scope => ({
      ...scope,
      id: evidence.routeId,
      accountId: wrongRoute ? accountIdSchema.parse('wrong-account') : accountId,
      provider: {
        async send() { sends++; return { kind: 'unknown' } },
        async lookup(request) {
          lookups++
          expect(request.accountId).toBe(accountId)
          expect(request.routeId).toBe(evidence.routeId)
          const accepted = f.records()[0]
          if (!accepted) return { kind: 'absent', deliveryId: request.deliveryId, dedupeKey: request.dedupeKey, destination: request.destination }
          return { kind: 'accepted', deliveryId: accepted.deliveryId, dedupeKey: accepted.dedupeKey,
            destination: accepted.destination, receiptId: accepted.receiptId }
        },
      },
    }) })
    const recovery = f.store.createEffectRecovery()

    expect(f.store.recoveryMode()).toBe('reconciling')
    expect(f.store.getDelivery(ref, delivery.id)?.status).toBe('dispatching')
    expect(await outbox.deliver(ref, delivery.id)).toEqual({ ok: false, code: 'reconciliation_required' })
    expect(await outbox.deliver(ref, other.id)).toEqual({ ok: false, code: 'recovery_required' })
    expect(recovery.classifyInterrupted()).toEqual({ effects: 0, deliveries: 1 })
    expect(recovery.classifyInterrupted()).toEqual({ effects: 0, deliveries: 0 })
    expect(f.store.getDelivery(ref, delivery.id)?.status).toBe('uncertain')
    expect(f.store.canDispatch()).toBe(true)
    expect(await outbox.deliver(ref, other.id)).toEqual({ ok: false, code: 'blocked' })
    wrongRoute = true
    expect(await outbox.reconcile(ref, delivery.id)).toEqual({ ok: false, code: 'permission_denied' })
    expect(lookups).toBe(0)
    wrongRoute = false
    const readback = await outbox.reconcile(ref, delivery.id)
    if (phase === 'after') {
      expect(readback).toMatchObject({ ok: true, delivery: { status: 'accepted', receipt: { providerReceiptId: 'delivery-receipt' } } })
      expect(await outbox.deliver(ref, delivery.id)).toEqual(readback)
    } else {
      expect(readback).toMatchObject({ ok: true, delivery: { status: 'uncertain' } })
      expect(await outbox.deliver(ref, delivery.id)).toEqual({ ok: false, code: 'reconciliation_required' })
    }
    expect(lookups).toBe(1)
    expect(sends).toBe(0)
    expect(f.records()).toHaveLength(phase === 'before' ? 0 : 1)
    f.reopen()
    expect(f.store.getDelivery(ref, delivery.id)?.status).toBe(phase === 'after' ? 'accepted' : 'uncertain')
  }, 20_000)

  it('keeps approved grants and pending deliveries inert after guarded restore and reopen', async () => {
    const f = prepare('restore')
    const { ref, evidence } = f
    const action = actionOf(evidence.action)
    const profile = profileSchema.parse(evidence.profile)
    const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
    const token = identity.bindOwner(evidence.metadata)
    const message = deliverySchema.parse(evidence.message)
    let sends = 0
    let lookups = 0
    function openRoutes() {
      return {
        gate: f.store.createActionGate({ identity, now: () => at, routes: [{
          binding: bindingOf(action), permitsPayload: () => true,
          handoff() { sends++; return undefined },
        }] }),
        outbox: f.store.createOutbox({ now: () => at, allowDisclosure: () => true, resolveRoute: scope => ({
          ...scope, id: evidence.routeId, accountId: accountIdSchema.parse(evidence.accountId), provider: {
            async send() { sends++; return { kind: 'unknown' } },
            async lookup() { lookups++; return { kind: 'unknown' } },
          },
        }) }),
        recovery: f.store.createEffectRecovery(),
      }
    }

    for (let opening = 0; opening < 2; opening++) {
      if (opening > 0) f.reopen()
      const { gate, outbox, recovery } = openRoutes()
      expect(f.store.recoveryMode()).toBe('restore')
      expect(f.store.canDispatch()).toBe(false)
      expect(recovery.classifyInterrupted()).toEqual({ effects: 0, deliveries: 0 })
      expect(f.store.getEffect(ref, action.operationId)?.status).toBe('authorized')
      expect(f.store.getDelivery(ref, message.id)?.status).toBe('pending')
      expect(gate.dispatch(action, evidence.grantId, evidence.version)).toEqual({ ok: false, code: 'recovery_required' })
      expect(gate.review(action, { requestId: 'review-restored', expiresAt: '2026-11-07T08:05:00.000Z' }, token))
        .toEqual({ decision: 'deny', code: 'recovery_required' })
      expect(gate.respond({ requestId: 'approval-fixture-effect', expectedVersion: 0, digest: canonicalizeAction(action)?.digest,
        decision: 'approve' }, token)).toEqual({ ok: false, code: 'recovery_required' })
      expect(gate.revoke(evidence.otherGrantId, token)).toEqual({ ok: true })
      expect(await outbox.deliver(ref, message.id)).toEqual({ ok: false, code: 'recovery_required' })
      expect(await outbox.reconcile(ref, message.id)).toMatchObject({ ok: true, delivery: { status: 'pending' } })
      expect(f.store.canDispatch()).toBe(false)
    }
    expect(sends).toBe(0)
    expect(lookups).toBe(0)
    expect(f.records()).toHaveLength(0)
  }, 20_000)

  it('leaves an active dispatch alone in a normal live store', async () => {
    const f = prepare('normal')
    const message = deliverySchema.parse(f.evidence.message)
    const entered = Promise.withResolvers<OutboxSendRequest>()
    const settled = Promise.withResolvers<unknown>()
    const outbox = f.store.createOutbox({ now: () => at, allowDisclosure: () => true, resolveRoute: scope => ({
      ...scope, id: f.evidence.routeId, accountId: accountIdSchema.parse(f.evidence.accountId),
      provider: { async send(request) { entered.resolve(request); return settled.promise } },
    }) })
    const pending = outbox.deliver(f.ref, message.id)
    const request = await entered.promise
    try {
      expect(f.store.recoveryMode()).toBe('normal')
      expect(f.store.createEffectRecovery().classifyInterrupted()).toEqual({ effects: 0, deliveries: 0 })
      expect(f.store.getDelivery(f.ref, message.id)?.status).toBe('dispatching')
    } finally {
      settled.resolve({ kind: 'accepted', deliveryId: request.deliveryId, dedupeKey: request.dedupeKey,
        destination: request.destination, receiptId: 'live-acceptance' })
      await pending
    }
    expect(f.store.getDelivery(f.ref, message.id)).toMatchObject({ status: 'accepted', receipt: { providerReceiptId: 'live-acceptance' } })
  }, 20_000)
})
