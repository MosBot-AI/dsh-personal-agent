import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { SessionId as nativeSessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { z } from 'zod'
import {
  deviceIdSchema, nonEmptyTextSchema, ownerIdSchema, profileIdSchema, profileSchema, utcInstantSchema,
  type Profile, type SessionId,
} from '../domain/model.js'
import { createIdentityBoundary } from '../policy/identity.js'
import type { ActionRoute } from '../policy/dispatch.js'
import type { HostAdapter } from '../runtime/host-adapter.js'
import { StorageError } from '../storage/schema.js'
import { openWorkStore } from '../storage/store.js'
import { INBOX_RPC_ENDPOINT, type InboxSession } from './protocol.js'
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
  worker: z.strictObject({
    provider: nonEmptyTextSchema.max(256),
    model: nonEmptyTextSchema.max(256),
    dataScope: z.array(nonEmptyTextSchema.max(256)).max(64).default([]),
    concurrency: z.int().min(1).max(32).optional(),
  }).optional(),
})

const localIdentitySchema = z.strictObject({
  ownerId: ownerIdSchema,
  profileId: profileIdSchema,
  deviceId: deviceIdSchema,
  verifiedAt: utcInstantSchema,
})

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
  try {
    const local = readLocalIdentity(config.storageDirectory)
    const profile = profileSchema.parse({
      id: local.profileId,
      ownerId: local.ownerId,
      verifiedAccounts: options.verifiedAccounts ?? [],
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
      captureResultSummary: true,
    }) : undefined
    const actionGate = store.createActionGate({ identity, routes: options.actionRoutes ?? [] })
    const service = createInboxService({
      store, executor, identity, actionGate, ...nativeSessions(ctx),
      worker: worker && { presetId: 'local-model', cwd: config.workRoot, dataScope: worker.dataScope },
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
      store, executor, identity, actionGate, ownerToken, owner,
      async dispose() {
        identity.release(token)
        const detached = remove()
        try {
          if (executor && !await executor.close()) throw new Error('Inbox Worker cleanup remains unverified')
        } finally {
          await detached
        }
        store.close()
      },
    })
  } catch (error) {
    store.close()
    throw error
  }
}
