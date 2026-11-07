import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { SessionId as nativeSessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { z } from 'zod'
import {
  accountIdSchema, deviceIdSchema, nonEmptyTextSchema, ownerIdSchema, profileIdSchema, profileSchema,
  sourceInstanceIdSchema, utcInstantSchema,
  type Profile, type SessionId, type SourceEvent,
} from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import { createIdentityBoundary, type SourceToken } from '../policy/identity.js'
import type { ActionRoute } from '../policy/dispatch.js'
import { budgetConfigSchema, type BudgetConfig, type BudgetCurrencyUsage } from '../runtime/budget.js'
import { computeLimitsSchema } from '../runtime/compute.js'
import { createGpuQueue, gpuConfigSchema } from '../runtime/gpu-queue.js'
import type { AttentionExternalRequest } from '../runtime/attention.js'
import type { HostAdapter } from '../runtime/host-adapter.js'
import { createRecovery } from '../runtime/recovery.js'
import { createSessionReadback } from '../runtime/recovery-session.js'
import { createRouter, type EventRouter } from '../runtime/router.js'
import { createDshRoutingAssessor } from '../runtime/routing-model.js'
import { StorageError } from '../storage/schema.js'
import { openWorkStore } from '../storage/store.js'
import { INBOX_RPC_ENDPOINT, type InboxSession, type InboxUsage } from './protocol.js'
import { createInboxService } from './service.js'

const pathSchema = z.string().refine(path => isAbsolute(path) && !path.includes('\0'), 'Expected an absolute path')
const rpcRequestSchema = z.strictObject({
  type: z.literal('client-request'),
  rpcId: nonEmptyTextSchema.max(256),
  method: z.literal(INBOX_RPC_ENDPOINT),
  payload: z.unknown(),
})
const MAX_INBOX_REQUEST_BYTES = 512 * 1024
export const localInboxConfigSchema = z.strictObject({
  storageDirectory: pathSchema,
  workRoot: pathSchema,
  sourceAccounts: profileSchema.shape.verifiedAccounts.max(64).optional(),
  budget: budgetConfigSchema.optional(),
  computeLimits: computeLimitsSchema.optional(),
  gpu: gpuConfigSchema.optional(),
  worker: z.strictObject({
    provider: nonEmptyTextSchema.max(256),
    model: nonEmptyTextSchema.max(256),
    dataScope: z.array(nonEmptyTextSchema.max(256)).max(64).default([]),
    concurrency: z.int().min(1).max(32).optional(),
    unmetered: z.literal(true).optional(),
  }).optional(),
  routing: z.strictObject({
    provider: nonEmptyTextSchema.max(256),
    model: nonEmptyTextSchema.max(256),
    dataScope: z.array(nonEmptyTextSchema.max(256)).min(1).max(64),
    unmetered: z.literal(true).optional(),
  }).optional(),
})

const zeroPrice = {
  kind: 'known', inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
  cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0, ceilingMicros: 0,
} as const

function inboxBudgetConfig(config: z.infer<typeof localInboxConfigSchema>): BudgetConfig {
  const routes = [...config.budget?.routes ?? []]
  const limits = [...config.budget?.limits ?? []]
  const selectedRoutes = [config.worker, config.routing].filter(route => route !== undefined)
  for (const selected of selectedRoutes) {
    const matches = (route: { provider: string; model: string }) => route.provider === selected.provider && route.model === selected.model
    const route = routes.find(matches)
    const unmetered = selectedRoutes.some(candidate => candidate.unmetered === true && matches(candidate))
    if (route && unmetered && (route.pricing.kind !== 'known' || route.pricing.ceilingMicros !== 0)) {
      throw new Error('An unmetered inbox route conflicts with its configured price')
    }
    if (!route) routes.push({ provider: selected.provider, model: selected.model, currency: null,
      pricing: unmetered ? zeroPrice : { kind: 'unknown' } })
  }
  if (routes.some(route => route.currency === null) && !limits.some(limit => limit.currency === null)) {
    limits.push({ currency: null, ownerDayMicros: 0, taskMicros: 0, maxCallsPerDay: 128, maxCallsPerTask: 64,
      maxConcurrent: Math.min(32, (config.worker?.concurrency ?? 2) + (config.routing ? 1 : 0)) })
  }
  return budgetConfigSchema.parse({ pricingVersion: config.budget?.pricingVersion ?? 'local-1', routes, limits })
}

const localIdentitySchema = z.strictObject({
  ownerId: ownerIdSchema,
  profileId: profileIdSchema,
  deviceId: deviceIdSchema,
  verifiedAt: utcInstantSchema,
})
const sourceBindingSchema = z.strictObject({ sourceInstanceId: sourceInstanceIdSchema, accountId: accountIdSchema })

function readLocalIdentity(directory: string) {
  const path = join(directory, 'local-inbox-identity.json')
  const file = lstatSync(path, { throwIfNoEntry: false })
  const uid = process.getuid?.()
  if (file) {
    if (!file.isFile() || file.nlink !== 1 || file.size > 4_096
      || (uid !== undefined && (file.uid !== uid || (file.mode & 0o777) !== 0o600))) {
      throw new StorageError('unsafe_path', 'Inbox identity requires an owner-private file')
    }
    return localIdentitySchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }

  const identity = localIdentitySchema.parse({
    ownerId: `owner-${randomUUID()}`,
    profileId: `profile-${randomUUID()}`,
    deviceId: `device-${randomUUID()}`,
    verifiedAt: new Date().toISOString(),
  })
  const temporary = join(directory, `.inbox-identity-${randomUUID()}.tmp`)
  try {
    const descriptor = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(descriptor, JSON.stringify(identity) + '\n')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, path)
    if (process.platform !== 'win32') {
      const parent = openSync(directory, 'r')
      try {
        fsyncSync(parent)
      } finally {
        closeSync(parent)
      }
    }
  } finally {
    rmSync(temporary, { force: true })
  }
  return identity
}

function isPrimary(header: SessionHeader): boolean {
  return header.origin !== 'subagent' && !/^dshpa-[0-9a-f]{64}$/.test(header.id)
}

function nativeSessions(ctx: Context) {
  return {
    async resolveSession(id: SessionId): Promise<boolean> {
      const nativeId = nativeSessionId(id)
      const live = ctx.get('sessions')?.get(nativeId)
      if (live) return isPrimary(live.header)
      const stored = await ctx.get('sessionPersistence')?.list() ?? []
      return stored.some(entry => entry.header.id === nativeId
        && entry.formatStatus !== 'migration-required' && isPrimary(entry.header))
    },
    async listSessions(): Promise<readonly InboxSession[]> {
      const headers = new Map<string, SessionHeader>()
      for (const entry of await ctx.get('sessionPersistence')?.list() ?? []) {
        if (entry.formatStatus !== 'migration-required' && isPrimary(entry.header)) {
          headers.set(entry.header.id, entry.header)
        }
      }
      for (const session of ctx.get('sessions')?.list() ?? []) {
        if (isPrimary(session.header)) headers.set(session.header.id, session.header)
      }
      return [...headers.values()].sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 50).map(header => ({ id: header.id, label: header.id }))
    },
  }
}

async function readInboxEnvelope(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return new Response('Request body required', { status: 400 })
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_INBOX_REQUEST_BYTES) {
        await reader.cancel()
        return new Response('Request too large', { status: 413 })
      }
      chunks.push(value)
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
    const decoded = rpcRequestSchema.safeParse(JSON.parse(text))
    return decoded.success ? decoded.data : new Response('Invalid inbox request', { status: 400 })
  } catch {
    return new Response('Invalid inbox request', { status: 400 })
  } finally {
    reader.releaseLock()
  }
}

export interface LocalInboxOptions {
  readonly verifiedAccounts?: Profile['verifiedAccounts']
  readonly actionRoutes?: readonly ActionRoute[]
  readonly authorizeRoutedInput?: (state: WorkState, event: SourceEvent) => boolean
  readonly authorizeEventWake?: (state: WorkState, event: SourceEvent) => boolean
  readonly allowAttentionDelivery?: (request: AttentionExternalRequest) => boolean
}

/** Mount the inbox on the existing local Web carrier. The caller owns the Host plugin scope. */
export function activateLocalInbox(
  ctx: Context,
  host: HostAdapter,
  input: unknown,
  options: LocalInboxOptions = {},
) {
  const config = localInboxConfigSchema.parse(input)
  const connection: HostConnectionHandle | undefined = ctx.get('connection')
  const listener = ctx.get('webServer') as { readonly host?: unknown } | undefined
  if (!connection || connection.allowsRemoteAuthorities !== false
    || (listener?.host !== '127.0.0.1' && listener?.host !== '::1')) {
    throw new Error('The inbox requires the local-only DSH Web connection')
  }
  const store = openWorkStore(config.storageDirectory)
  let router: EventRouter | undefined
  try {
    const local = readLocalIdentity(config.storageDirectory)
    const profile = profileSchema.parse({
      id: local.profileId,
      ownerId: local.ownerId,
      verifiedAccounts: options.verifiedAccounts ?? config.sourceAccounts ?? [],
      verifiedDevices: [{ deviceId: local.deviceId, verifiedAt: local.verifiedAt }],
      policyVersion: 'local-web-1',
    })
    const identity = createIdentityBoundary(id => id === profile.id ? profile : undefined)
    const ownerToken = () => identity.bindOwner({
      ownerId: local.ownerId,
      profileId: local.profileId,
      deviceId: local.deviceId,
      clientId: 'dshpa-local-web',
      sessionId: 'dshpa-local-owner',
    })
    const token = ownerToken()
    const owner = identity.resolveOwner(token)
    if (!token || !owner) throw new Error('The local inbox owner binding is unavailable')
    const scope = { ownerId: owner.ownerId, profileId: owner.profileId }
    const budgetConfig = inboxBudgetConfig(config)
    const budget = store.createBudget(budgetConfig)
    const attention = store.createAttention({ allowExternal: options.allowAttentionDelivery })
    const gpu = createGpuQueue(config.gpu ?? {}, ref => {
      if (ref.ownerId !== scope.ownerId || ref.profileId !== scope.profileId || !store.canDispatch()) return false
      const state = store.getWork(ref)
      return Boolean(state && state.task.generation === ref.generation && state.attempt.id === ref.attemptId
        && state.attempt.generation === ref.generation && ['queued', 'running', 'waiting_resource'].includes(state.task.status))
    })
    const routeHasPrice = (route: { provider: string; model: string }) => budgetConfig.routes.some(item =>
      item.provider === route.provider && item.model === route.model && item.pricing.kind === 'known')

    const llm = config.routing && ctx.get('llm')
    const routingStatus = config.routing === undefined ? 'off' : !routeHasPrice(config.routing) ? 'pricing_unavailable'
      : llm ? 'configured' : 'provider_unavailable'
    const assess = config.routing && llm && routingStatus === 'configured' ? createDshRoutingAssessor(llm, config.routing, {
      budget, ...scope, limits: config.computeLimits,
    }) : undefined
    const worker = config.worker
    if (worker) mkdirSync(config.workRoot, { recursive: true, mode: 0o700 })
    const executor = worker ? host.createWorkerExecutor({
      store,
      presets: [{
        id: 'local-model',
        rootDirectory: config.workRoot,
        provider: worker.provider,
        model: worker.model,
        dataScope: worker.dataScope,
      }],
      concurrency: worker.concurrency,
      compute: { budget, limits: config.computeLimits },
      captureResultSummary: true,
      onHandback: (ref, eventId) => router?.handback(ref, eventId),
      onProgress(ref, state, report) {
        const externalEventId = createHash('sha256').update(JSON.stringify([state.attempt.id, state.attempt.generation, report.cursor])).digest('hex')
        attention.consider(ref, {
          attemptId: state.attempt.id, generation: state.attempt.generation, expectedVersion: state.task.version,
          category: 'progress', source: { sourceInstanceId: 'dshpa-worker', externalEventId, externalRevision: '1' },
          summary: report.summary,
        })
      },
    }) : undefined
    const eventRouter = createRouter({ store, identity, executor, assess, assessmentDataScope: config.routing?.dataScope,
      authorizeDelivery: (state, event) => Boolean(worker && routeHasPrice(worker)
        && (options.authorizeRoutedInput === undefined || options.authorizeRoutedInput(state, event))),
      authorizeWake: options.authorizeEventWake })
    router = eventRouter
    const routing = Object.freeze({
      bindSource(authenticatedMetadata: unknown) {
        const source = sourceBindingSchema.safeParse(authenticatedMetadata)
        return source.success ? identity.bindSource({ ...source.data, ownerId: local.ownerId, profileId: local.profileId }) : undefined
      },
      releaseSource(token: SourceToken) { identity.release(token) },
      receive: eventRouter.receive,
      status: eventRouter.status,
      snapshot: eventRouter.snapshot,
    })
    const actionGate = store.createActionGate({ identity, routes: options.actionRoutes ?? [] })
    const recovery = createRecovery(store, { readSession: createSessionReadback(ctx) })
    const startupRecovery = recovery.reconcileStartup().catch(() => undefined)
    const service = createInboxService({
      store, executor, identity, actionGate, router: eventRouter, ...nativeSessions(ctx),
      worker: worker && { presetId: 'local-model', cwd: config.workRoot, dataScope: worker.dataScope },
      configureAttention: (_owner, policy, expectedVersion) => attention.configure(scope, policy, expectedVersion),
      invalidateResources: gpu.cancelStale,
      inspectUsage() {
        const spend = budget.snapshot(scope)
        const notices = attention.snapshot(scope)
        const total = (metric: (row: BudgetCurrencyUsage) => number) => spend.currencies.reduce((count, row) =>
          Math.min(Number.MAX_SAFE_INTEGER, count + metric(row)), 0)
        const balances = new Map(spend.currencies.map(row => [row.currency, row]))
        const currencies = new Set([...balances.keys(), ...budgetConfig.limits.map(limit => limit.currency)])
        const usage: InboxUsage = {
          day: spend.day,
          currencies: [...currencies].filter(currency => currency !== null).sort().map(currency => {
            const row = balances.get(currency)
            return { currency, spentMicros: row?.spentMicros ?? 0, reservedMicros: row?.reservedMicros ?? 0,
              uncertainMicros: row?.uncertainMicros ?? 0, olderHeldMicros: row?.olderHeldMicros ?? 0,
              overflow: row?.overflow ?? false,
              dailyLimitMicros: budgetConfig.limits.find(limit => limit.currency === currency)?.ownerDayMicros }
          }),
          calls: total(row => row.calls), unknownCalls: total(row => row.unknownCostCalls),
          uncertainCalls: total(row => row.uncertainCalls + row.olderUnresolvedCalls),
          routing: routingStatus,
          tokens: { input: total(row => row.inputTokens), output: total(row => row.outputTokens),
            cacheRead: total(row => row.cacheReadTokens), cacheWrite: total(row => row.cacheWriteTokens) },
          workerSlots: executor?.snapshot() ?? { active: 0, limit: 0 },
          gpu: gpu.snapshot(scope),
          attention: { mode: notices.policy.mode, version: notices.policy.version, day: notices.day,
            timeZone: notices.policy.timeZone, unsolicited: notices.unsolicitedUsed, limit: notices.unsolicitedLimit,
            suppressed: notices.suppressedToday, recent: notices.decisions.filter(decision => decision.category !== 'progress')
              .slice(0, 6).map(decision => ({ id: decision.id, reason: decision.claimReason ?? decision.reason, at: decision.at })) },
        }
        return { usage, progress: notices.progress }
      },
    })
    // The pinned Connection carrier authorizes exact Fetch routes for owner
    // peers. Its shared RPC interceptor remains owned by native Typert.
    const remove = connection.fetch.register({
      path: `/api/${INBOX_RPC_ENDPOINT}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (connection.allowsRemoteAuthorities) return new Response('Forbidden', { status: 403 })
        const admission = connection.admit(request)
        if ('rejection' in admission) return new Response('Authentication required', { status: admission.rejection })
        if (admission.peer.principal.kind !== 'owner' || admission.peer.id !== connection.browserPeer.id) {
          return new Response('Forbidden', { status: 403 })
        }
        if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response('JSON request required', { status: 415 })
        }
        const envelope = await readInboxEnvelope(request)
        if (envelope instanceof Response) return envelope
        if (request.signal.aborted) return new Response('Request ended before admission', { status: 400 })
        let value
        try {
          value = await service.handle(token, envelope.payload)
        } catch (error) {
          value = { ok: false, code: error instanceof StorageError ? error.code : 'host_unavailable' }
        }
        return Response.json({
          type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value },
        }, { headers: { 'cache-control': 'no-store' } })
      },
    })

    return Object.freeze({
      store, executor, identity, actionGate, ownerToken, owner, recovery, routing, attention,
      compute: Object.freeze({ budget, gpu }),
      async dispose() {
        identity.release(token)
        const detached = remove()
        try {
          eventRouter.close()
          const [workersReleased, gpuReleased] = await Promise.all([executor?.close() ?? true, gpu.close()])
          if (!workersReleased || !gpuReleased) throw new Error('Inbox compute cleanup remains unverified')
        } finally {
          await detached
        }
        await startupRecovery
        store.close()
      },
    })
  } catch (error) {
    try {
      router?.close()
    } finally {
      store.close()
    }
    throw error
  }
}

export type LocalRoutingService = ReturnType<typeof activateLocalInbox>['routing']
export type LocalAttentionService = ReturnType<typeof activateLocalInbox>['attention']
export type LocalComputeService = ReturnType<typeof activateLocalInbox>['compute']
