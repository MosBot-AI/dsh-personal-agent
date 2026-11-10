import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { SessionId as nativeSessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { z } from 'zod'
import { createMobileApprovals } from '../api/approvals.js'
import { mobileHttpConfigSchema, startMobileHttp } from '../api/mobile-http.js'
import { createLocalKnowledge, localKnowledgeConfigSchema } from '../connectors/local-knowledge.js'
import { createGitHubReadTransport } from '../connectors/github.js'
import { createGitHubDraftRuntime, createGitHubDraftService, githubDraftAccount, type GitHubDraftRuntime } from '../connectors/github-draft.js'
import { DRAFT_SOURCE, githubDraftConfigSchema } from '../connectors/github-draft-model.js'
import type { DraftProvider } from '../connectors/github-write.js'
import { createMcpReadTransport, mcpLoopbackUrlSchema } from '../connectors/mcp.js'
import { connectorBindingSchema, createReadConnector } from '../connectors/registry.js'
import { createLocalContext, localContextConfigSchema } from '../context/local-context.js'
import { createLocalMemory, localMemoryConfigSchema } from '../context/memory.js'
import {
  accountIdSchema, artifactIdSchema, deviceIdSchema, nonEmptyTextSchema, ownerIdSchema, profileIdSchema, profileSchema, projectIdSchema, sha256DigestSchema,
  sourceInstanceIdSchema, utcInstantSchema,
  taskIdSchema, type Profile, type SessionId, type SourceEvent,
} from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import { mediaServiceConfigSchema, type MediaJobService } from '../media/jobs.js'
import { ROUTINE_SOURCE } from '../domain/routines.js'
import { createIdentityBoundary, type SourceToken } from '../policy/identity.js'
import type { ActionRoute } from '../policy/dispatch.js'
import { budgetConfigSchema, type BudgetConfig, type BudgetCurrencyUsage } from '../runtime/budget.js'
import { capabilityRegistryFor } from '../runtime/capability-registry.js'
import CheckpointedCompactionEngine from '../runtime/checkpoint-compaction.js'
import CheckpointedToolResultPruner from '../runtime/checkpoint-pruner.js'
import { computeLimitsSchema } from '../runtime/compute.js'
import { createGpuQueue, gpuConfigSchema } from '../runtime/gpu-queue.js'
import type { AttentionExternalRequest } from '../runtime/attention.js'
import type { HostAdapter } from '../runtime/host-adapter.js'
import { createDesktopControl, desktopConfigSchema, type DesktopControl } from '../runtime/desktop-control.js'
import { createResourceLeases } from '../runtime/resource-leases.js'
import { createRecovery } from '../runtime/recovery.js'
import { createResidentOperations, residentConfigSchema, type ResidentOperations } from '../runtime/resident-operations.js'
import { attachResidentWeb, type ResidentAppReady, type ResidentListener } from '../runtime/resident-web.js'
import { isRoutineSinkSession, type NativeSchedulePort } from '../runtime/native-schedule.js'
import { createSessionReadback } from '../runtime/recovery-session.js'
import { createRouter, type EventRouter } from '../runtime/router.js'
import { createDshRoutingAssessor } from '../runtime/routing-model.js'
import { createProactive, type ProactiveService } from '../runtime/proactive.js'
import { createScheduleAdapter } from '../runtime/schedule-adapter.js'
import { reserveLocalDesktop } from '../storage/database.js'
import { StorageError } from '../storage/schema.js'
import { openWorkStore, type WorkStore } from '../storage/store.js'
import { INBOX_RPC_ENDPOINT, type InboxSession, type InboxUsage } from './protocol.js'
import { createRoutineInbox, routineAuthority } from './routines.js'
import type { WorkerExecutor } from '../runtime/executor.js'
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
  routines: z.boolean().default(false),
  proactive: z.boolean().default(false),
  resident: residentConfigSchema.optional(),
  mobile: mobileHttpConfigSchema.optional(),
  sourceAccounts: profileSchema.shape.verifiedAccounts.max(64).optional(),
  budget: budgetConfigSchema.optional(),
  computeLimits: computeLimitsSchema.optional(),
  context: localContextConfigSchema.optional(),
  memory: localMemoryConfigSchema.optional(),
  knowledge: localKnowledgeConfigSchema.optional(),
  githubDraft: githubDraftConfigSchema.optional(),
  githubRead: z.strictObject({
    binding: connectorBindingSchema,
    projectId: projectIdSchema.max(256).optional(),
    transport: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('github') }),
      z.strictObject({ kind: z.literal('mcp'), url: mcpLoopbackUrlSchema, fingerprint: sha256DigestSchema })]).default({ kind: 'github' }),
  }).optional(),
  gpu: gpuConfigSchema.optional(),
  media: mediaServiceConfigSchema.optional(),
  desktop: desktopConfigSchema.optional(),
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
  return header.origin !== 'subagent' && !/^dshpa-[0-9a-f]{64}$/.test(header.id) && !isRoutineSinkSession(header.id)
}

function nativeSessions(ctx: Context, checkpointed: boolean) {
  function eligible(header: SessionHeader): boolean {
    if (!isPrimary(header)) return false
    if (!checkpointed) return true
    const agent = ctx.agents.get(header.id)
    if (!agent) return false
    const presets = ctx.get('agentPresets')
    const compaction = presets?.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction')
    const pruner = presets?.serviceFor(agent, 'toolResultPruner') ?? agent.ctx.get('toolResultPruner')
    return compaction instanceof CheckpointedCompactionEngine && pruner instanceof CheckpointedToolResultPruner
  }
  return {
    async resolveSession(id: SessionId): Promise<boolean> {
      const nativeId = nativeSessionId(id)
      const live = ctx.get('sessions')?.get(nativeId)
      if (live) return eligible(live.header)
      if (checkpointed) return false
      const stored = await ctx.get('sessionPersistence')?.list() ?? []
      return stored.some(entry => entry.header.id === nativeId
        && entry.formatStatus !== 'migration-required' && isPrimary(entry.header))
    },
    async listSessions(): Promise<readonly InboxSession[]> {
      const headers = new Map<string, SessionHeader>()
      for (const entry of await ctx.get('sessionPersistence')?.list() ?? []) {
        if (entry.formatStatus !== 'migration-required' && eligible(entry.header)) {
          headers.set(entry.header.id, entry.header)
        }
      }
      for (const session of ctx.get('sessions')?.list() ?? []) {
        if (eligible(session.header)) headers.set(session.header.id, session.header)
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
  readonly githubDraftProvider?: DraftProvider
  readonly authorizeRoutedInput?: (state: WorkState, event: SourceEvent) => boolean
  readonly authorizeEventWake?: (state: WorkState, event: SourceEvent) => boolean
  readonly allowAttentionDelivery?: (request: AttentionExternalRequest) => boolean
  readonly schedule?: NativeSchedulePort
  readonly takeResidentStore?: () => WorkStore | undefined
}

/** Mount the inbox on the existing local Web carrier. The caller owns the Host plugin scope. */
export function activateLocalInbox(
  ctx: Context,
  host: HostAdapter,
  input: unknown,
  options: LocalInboxOptions = {},
) {
  const config = localInboxConfigSchema.parse(input)
  if (config.routines && options.schedule === undefined) throw new Error('Enabled routines require the private native schedule carrier')
  if (config.context && (!ctx.get('dshpaCheckpointCompactionReady') || !ctx.get('dshpaCheckpointPrunerReady'))) {
    throw new Error('Enabled context requires both dshpa checkpoint plugins')
  }
  const connection: HostConnectionHandle | undefined = ctx.get('connection')
  const listener = ctx.get('webServer') as ResidentListener | undefined
  if (!connection || connection.allowsRemoteAuthorities !== false
    || (listener?.host !== '127.0.0.1' && listener?.host !== '::1')) {
    throw new Error('The inbox requires the local-only DSH Web connection')
  }
  const appReady = config.resident && ctx.get('appReady') as ResidentAppReady | undefined
  if (config.resident && !appReady) throw new Error('Resident mode requires the native Web startup service')
  const store = options.takeResidentStore?.() ?? openWorkStore(config.storageDirectory)
  let router: EventRouter | undefined
  let schedules: ReturnType<typeof createScheduleAdapter> | undefined
  let proactive: ProactiveService | undefined
  let media: MediaJobService | undefined
  let executor: WorkerExecutor | undefined
  let desktop: DesktopControl | undefined
  let removeDesktopGuard: (() => void) | undefined
  let resident: ResidentOperations | undefined
  let mobileHttp: ReturnType<typeof startMobileHttp> | undefined
  let draftRuntime: GitHubDraftRuntime | undefined
  let detachResident: (() => void) | undefined
  let detachInbox: (() => Promise<void>) | undefined
  let startup: Promise<void> | undefined
  try {
    const local = readLocalIdentity(config.storageDirectory)
    const mobile = config.mobile
    const mobileScope = { ownerId: local.ownerId, profileId: local.profileId }
    const mobileDevices = mobile && store.mobileDevices(mobileScope)
    const profile = profileSchema.parse({
      id: local.profileId,
      ownerId: local.ownerId,
      verifiedAccounts: [...(options.verifiedAccounts ?? config.sourceAccounts ?? []).filter(account => account.sourceInstanceId !== DRAFT_SOURCE),
        ...(config.githubDraft ? [githubDraftAccount(config.githubDraft, local.verifiedAt)] : [])],
      verifiedDevices: [{ deviceId: local.deviceId, verifiedAt: local.verifiedAt }],
      policyVersion: 'local-web-1',
    })
    const identity = createIdentityBoundary(id => {
      if (id !== profile.id) return undefined
      return mobileDevices ? { ...profile, verifiedDevices: [...profile.verifiedDevices, ...mobileDevices.verifiedDevices()] } : profile
    })
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
    resident = config.resident && createResidentOperations({
      store, directory: config.storageDirectory, config: config.resident,
      readWorker(ref) {
        const runtime = executor?.query(ref)
        const state = runtime?.state ?? store.getWork(ref)
        return state && { attemptId: state.attempt.id, generation: state.task.generation, status: state.task.status, active: runtime?.active }
      },
      async reconcileWarm(signal) {
        if (!signal.aborted && store.recoveryMode() === 'normal') await schedules?.recoverAfterGap(signal)
      },
    })
    resident?.beginRecovery()
    const budgetConfig = inboxBudgetConfig(config)
    const budget = store.createBudget(budgetConfig)
    const attention = store.createAttention({ allowExternal: options.allowAttentionDelivery })
    const gpu = createGpuQueue(config.gpu ?? {}, ref => {
      if (ref.ownerId !== scope.ownerId || ref.profileId !== scope.profileId || !store.canDispatch()
        || store.mediaLeaseHeld()) return false
      const state = store.getWork(ref)
      return Boolean(state && state.task.generation === ref.generation && state.attempt.id === ref.attemptId
        && state.attempt.generation === ref.generation && ['queued', 'running', 'waiting_resource'].includes(state.task.status))
    })
    if (config.media) {
      const registry = capabilityRegistryFor(ctx)
      if (!registry) throw new Error('The media service requires the capability registry')
      media = store.createMediaJobs(registry, config.media, {
        current(access) {
          if (access.ownerId !== scope.ownerId || access.profileId !== scope.profileId) return false
          const state = store.getWork({ ...scope, taskId: taskIdSchema.parse(access.taskId) })
          return Boolean(state && state.task.generation === access.generation && state.attempt.id === access.attemptId
            && state.attempt.generation === access.generation && ['queued', 'running', 'waiting_resource'].includes(state.task.status))
        },
        canLease: () => gpu.snapshot(scope).active === 0,
        artifactAllowed(access, artifact) {
          const sealed = store.artifacts.read({ ...scope, taskId: taskIdSchema.parse(access.taskId) }, artifactIdSchema.parse(artifact.artifactId))
          return Boolean(sealed && sealed.artifact.attemptId === access.attemptId && sealed.generation === access.generation
            && sealed.artifact.contentHash === artifact.contentHash && sealed.artifact.mediaType === artifact.mediaType)
        },
      })
    }
    const routeHasPrice = (route: { provider: string; model: string }) => budgetConfig.routes.some(item =>
      item.provider === route.provider && item.model === route.model && item.pricing.kind === 'known')

    const llm = config.routing && ctx.get('llm')
    const routingStatus = config.routing === undefined ? 'off' : !routeHasPrice(config.routing) ? 'pricing_unavailable'
      : llm ? 'configured' : 'provider_unavailable'
    const assess = config.routing && llm && routingStatus === 'configured' ? createDshRoutingAssessor(llm, config.routing, {
      budget, ...scope, limits: config.computeLimits,
    }) : undefined
    proactive = config.proactive ? createProactive({ store, identity, scope, attention, assess, canAssess: assess?.canAssess,
      assessmentRoute: config.routing && { provider: config.routing.provider, model: config.routing.model },
      assessmentDataScope: config.routing?.dataScope }) : undefined
    const worker = config.worker
    const limits = computeLimitsSchema.parse(config.computeLimits ?? {})
    const context = config.context && createLocalContext({ ctx, store, identity, ownerToken: token, owner, config: config.context,
      worker: worker && { ...worker, outputReserve: limits.maxOutputTokens, maxInputBytes: limits.maxInputBytes } })
    const registry = config.memory && capabilityRegistryFor(ctx)
    if (config.memory && !registry) throw new Error('Enabled memory requires the capability registry')
    const memory = config.memory && registry ? createLocalMemory({ store, identity, registry, config: config.memory }) : undefined
    const knowledge = config.knowledge ? createLocalKnowledge(config.knowledge) : undefined
    const github = config.githubRead
    const connector = github && createReadConnector({ binding: github.binding, projectId: github.projectId,
      transport: github.transport.kind === 'github' ? createGitHubReadTransport({ binding: github.binding })
        : createMcpReadTransport({ binding: github.binding, url: github.transport.url, expectedFingerprint: github.transport.fingerprint }) })
    if (config.desktop) {
      const tools = ctx.get('tools')
      if (!worker || !tools) throw new Error('Desktop workflows require the local Worker and native tools services')
      const controls = createDesktopControl({
        store, identity, config: config.desktop,
        leases: createResourceLeases({ reserve: target => target.kind === 'desktop' ? reserveLocalDesktop() : () => {} }),
        native: () => {
          const provider = ctx.get('computerUse') as { providerName?: string } | undefined
          return provider?.providerName === 'dsh-cua' ? tools.executable('cua') : undefined
        },
        bindBrowser: (profile, agent, signal) => {
          const chrome = ctx.get('dshpaBrowserChrome') as {
            bind?: (owner: typeof agent, origin: string, signal: AbortSignal) => boolean
          } | undefined
          return chrome?.bind?.(agent, new URL(profile.startUrl).origin, signal) === true
        },
        nativeBrowser: (profile, name, execution) => {
          const provider = ctx.get('browserUse') as { providerName?: string } | undefined
          const chrome = ctx.get('dshpaBrowserChrome') as { origins?: readonly string[] } | undefined
          return provider?.providerName === 'chrome-devtools-mcp' && execution.agent
            && chrome?.origins?.includes(new URL(profile.startUrl).origin)
            ? tools.executable(name, execution.agent) : undefined
        },
      })
      desktop = controls
      removeDesktopGuard = tools.guard(call =>
        controls.allows(tools.executable(call.name, call.agent, call.toolSet)) && call.parent === undefined
          ? undefined : 'This desktop deployment admits only owner-leased native tools.')
    }
    if (worker) mkdirSync(config.workRoot, { recursive: true, mode: 0o700 })
    executor = worker ? host.createWorkerExecutor({
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
      prepareContextInput: context?.prepareCached,
      authorizeContextHistory: context?.historyUsable,
      resolveContextRoute: context?.resolveRoute,
      contextWindow: context?.contextWindow,
      onHandback: (ref, eventId) => router?.handback(ref, eventId),
      onObservation: resident?.observe,
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
      proactive: proactive?.consider,
      authorizeDelivery: (state, event) => Boolean(worker && routeHasPrice(worker)
        && (options.authorizeRoutedInput === undefined || options.authorizeRoutedInput(state, event))),
      authorizeWake: options.authorizeEventWake })
    router = eventRouter
    const routing = Object.freeze({
      bindSource(authenticatedMetadata: unknown) {
        const source = sourceBindingSchema.safeParse(authenticatedMetadata)
        return source.success && source.data.sourceInstanceId !== ROUTINE_SOURCE && source.data.sourceInstanceId !== DRAFT_SOURCE
          ? identity.bindSource({ ...source.data, ownerId: local.ownerId, profileId: local.profileId }) : undefined
      },
      releaseSource(token: SourceToken) { identity.release(token) },
      receive: eventRouter.receive,
      status: eventRouter.status,
      snapshot: eventRouter.snapshot,
    })
    const githubDraft = config.githubDraft
    draftRuntime = githubDraft && createGitHubDraftRuntime(githubDraft, scope, options.githubDraftProvider)
    const actionGate = store.createActionGate({ identity, routes: [...(options.actionRoutes ?? []), ...(draftRuntime ? [draftRuntime.route] : [])] })
    const recovery = createRecovery(store, { readSession: createSessionReadback(ctx), effects: draftRuntime ? { routes: [draftRuntime.lookup] } : undefined })
    const draft = githubDraft && draftRuntime ? { projectId: githubDraft.projectId,
      service: createGitHubDraftService({ config: githubDraft, runtime: draftRuntime, store, gate: actionGate, recovery, identity, scope }) } : undefined
    const schedule = config.routines && options.schedule ? createScheduleAdapter({
      store, native: options.schedule,
      currentAuthority(requested) {
        const current = identity.resolveOwner(token)
        return current && requested.ownerId === current.ownerId && requested.profileId === current.profileId
          ? routineAuthority(current) : undefined
      },
      authorizeGoalWake(routine, state) {
        const ref = { ownerId: routine.ownerId, profileId: routine.profileId, taskId: state.task.id }
        return {
          grantsCurrent: state.attempt.mandate.policyVersion === routine.authority?.policyVersion
            && (state.attempt.scope?.capabilities.length ?? 0) === 0,
          budgetAvailable: executor?.canStart(ref, 'local-model', true) === true,
          conditionSatisfied: state.task.status === 'waiting_event' && !executor?.query(ref).active,
        }
      },
    }) : undefined
    schedules = schedule
    const startupRecovery = recovery.reconcileStartup().then(async () => {
      let scheduleError = false
      try { await schedule?.reconcile() } catch { scheduleError = true }
      resident?.recoverySettled(scheduleError)
    }, () => resident?.recoveryUnavailable())
    startup = startupRecovery
    const mobileApprovals = mobileDevices && createMobileApprovals(scope, mobileDevices, identity, store, actionGate)
    if (mobile && mobileDevices && mobileApprovals) {
      mobileHttp = startMobileHttp(mobile, mobileDevices, store.mobileFeed(scope), mobileApprovals)
    }
    const service = createInboxService({
      store, executor, desktop, identity, actionGate, router: eventRouter, ...nativeSessions(ctx, context !== undefined),
      worker: worker && { presetId: 'local-model', cwd: config.workRoot, dataScope: worker.dataScope },
      routines: schedule && createRoutineInbox(store, schedule),
      resident, context, memory, knowledge, proactive,
      mobile: mobile && mobileDevices && mobileHttp && mobileApprovals ? {
        devices: mobileDevices, approvals: mobileApprovals, origin: mobile.origin, available: mobileHttp.available,
      } : undefined,
      githubRead: connector && { connector, scope, projectId: github?.projectId },
      githubDraft: draft,
      configureAttention: (_owner, policy, expectedVersion) => {
        const result = attention.configure(scope, policy, expectedVersion)
        if (result.ok) proactive?.invalidate()
        return result
      },
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
          value = await service.handle(token, envelope.payload, request.signal)
        } catch (error) {
          value = { ok: false, code: error instanceof StorageError ? error.code : 'host_unavailable' }
        }
        return Response.json({
          type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value },
        }, { headers: { 'cache-control': 'no-store' } })
      },
    })
    detachInbox = remove
    if (resident && appReady) {
      detachResident = attachResidentWeb({
        directory: config.storageDirectory, listener, appReady,
        authenticatedUrl: origin => connection.authenticatedUrl(origin),
        liveness: resident.health.liveness, readiness: resident.health.readiness,
        ready: resident.ownerReady, unavailable: resident.ownerUnavailable,
      })
    }

    media?.start(() => console.error('dshpa: media reconciliation failed'))
    return Object.freeze({
      media, store, executor, identity, actionGate, ownerToken, owner, recovery, routing, attention, context, schedules: schedule,
      compute: Object.freeze({ budget, gpu }),
      async dispose() {
        const operations = resident?.close()
        const mobileClosed = mobileHttp?.close()
        const drafts = draftRuntime?.close()
        identity.release(token)
        knowledge?.close()
        connector?.close()
        const detached = remove()
        try {
          eventRouter.close()
          const [workersReleased, gpuReleased] = await Promise.all([executor?.close() ?? true, gpu.close(), schedule?.close(), operations, proactive?.close(), media?.close(), mobileClosed, drafts, desktop?.close()])
          if (!workersReleased || !gpuReleased) throw new Error('Inbox compute cleanup remains unverified')
        } finally {
          try { detachResident?.() } finally { await detached }
        }
        await startupRecovery
        removeDesktopGuard?.()
        store.close()
      },
    })
  } catch (error) {
    const draftsClosed = draftRuntime?.close()
    const desktopClosed = desktop?.close()
    try {
      router?.close()
      removeDesktopGuard?.()
    } finally {
      detachResident?.()
      if (startup || schedules || resident || detachInbox || proactive || media || mobileHttp || desktopClosed || draftsClosed) {
        void Promise.allSettled([startup, schedules?.close(), resident?.close(), detachInbox?.(), proactive?.close(), media?.close(), mobileHttp?.close(), desktopClosed, draftsClosed])
          .then(() => store.close()).catch(() => undefined)
      }
      else store.close()
    }
    throw error
  }
}

export type LocalRoutingService = ReturnType<typeof activateLocalInbox>['routing']
export type LocalAttentionService = ReturnType<typeof activateLocalInbox>['attention']
export type LocalComputeService = ReturnType<typeof activateLocalInbox>['compute']
