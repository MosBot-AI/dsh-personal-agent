import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { projectIdSchema, sha256DigestSchema, utcInstantSchema } from '../domain/model.js'

const id = z.int().positive()
const login = z.string().regex(/^[a-zA-Z\d][a-zA-Z\d-]{0,38}$/u)
const repo = z.string().regex(/^[a-zA-Z\d_.-]{1,100}$/u).refine(name => name !== '.' && name !== '..')
export const connectorBindingSchema = z.strictObject({
  account: z.strictObject({ id, login }),
  repository: z.strictObject({ id, owner: login, name: repo }),
})
export type ConnectorBinding = z.infer<typeof connectorBindingSchema>
const operation = z.enum(['issues', 'comments'])
const cursor = z.uuid()
const project = projectIdSchema.max(256).optional()
export const connectorRequestSchemas = [
  z.strictObject({ type: z.literal('connector_status'), projectId: project }),
  z.strictObject({ type: z.literal('connector_read'), projectId: project, read: z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('issues'), cursor: cursor.optional() }),
    z.strictObject({ operation: z.literal('comments'), issue: id, cursor: cursor.optional() }),
  ]) }),
] as const
const requestSchema = z.union(connectorRequestSchemas)

export const PAGE_SIZE = 20
const PAGE_LIMIT = 10
const DEADLINE_MS = 10_000
const CURSOR_MS = 5 * 60_000
const CURSOR_LIMIT = 128
const WINDOW_MS = 60_000
const WINDOW_LIMIT = 20

const inspectionSchema = z.strictObject({
  binding: connectorBindingSchema, fingerprint: sha256DigestSchema,
  capabilities: z.array(operation).length(2).refine(values => new Set(values).size === 2),
})
const rowSchema = z.strictObject({
  id, number: id, kind: z.enum(['issue', 'pull', 'comment']),
  author: z.string().regex(/^[a-zA-Z\d][a-zA-Z\d-]{0,38}(?:\[bot\])?$/u), authorId: id.optional(),
  createdAt: utcInstantSchema, updatedAt: utcInstantSchema,
  title: z.string().max(512).optional(), text: z.string().max(4096),
}).refine(row => row.updatedAt >= row.createdAt && (row.kind === 'comment') === (row.title === undefined))
const pageSchema = z.strictObject({
  binding: connectorBindingSchema, fingerprint: sha256DigestSchema, operation, issue: id.optional(), page: id,
  items: z.array(rowSchema).max(PAGE_SIZE), hasNext: z.boolean(),
})
type Selector = { operation: 'issues' } | { operation: 'comments'; issue: number }
export type ConnectorPageRequest = Selector & { page: number }
export type ConnectorRecord = Omit<z.infer<typeof rowSchema>, 'createdAt' | 'updatedAt'> & {
  createdAt: string; updatedAt: string; url: string
}
type CursorState = { request: ConnectorPageRequest; expiresAt: number; seen: Set<number> }

export interface ReadConnectorSession {
  inspect(signal: AbortSignal): Promise<unknown>
  read(request: ConnectorPageRequest, signal: AbortSignal): Promise<unknown>
  current(): boolean
}
export interface ReadConnectorTransport {
  readonly expectedFingerprint: string
  open(signal: AbortSignal, authorize: () => boolean): Promise<ReadConnectorSession>
}

type Failure = 'permission_denied' | 'invalid_input' | 'invalid_cursor' | 'invalid_result' | 'capability_changed'
  | 'credential_unavailable' | 'provider_unavailable' | 'rate_limited' | 'busy'
const fail = (code: Failure, retryAt?: string) => ({ ok: false as const, code, ...(retryAt ? { retryAt } : {}) })
export class ConnectorError extends Error {
  constructor(readonly code: Failure, readonly retryAt?: string) { super(code) }
}

export function connectorDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function sameConnectorBinding(a: ConnectorBinding, b: ConnectorBinding): boolean {
  return a.account.id === b.account.id && a.account.login.toLowerCase() === b.account.login.toLowerCase()
    && a.repository.id === b.repository.id && a.repository.owner.toLowerCase() === b.repository.owner.toLowerCase()
    && a.repository.name.toLowerCase() === b.repository.name.toLowerCase()
}

function itemUrl(binding: ConnectorBinding, row: z.infer<typeof rowSchema>): string {
  const path = `https://github.com/${binding.repository.owner}/${binding.repository.name}`
  if (row.kind === 'comment') return `${path}/issues/${row.number}#issuecomment-${row.id}`
  return `${path}/${row.kind === 'pull' ? 'pull' : 'issues'}/${row.number}`
}

/** A read capability is bound once to owner-selected identities and a versioned transport. */
export function createReadConnector(options: {
  binding: ConnectorBinding; projectId?: string; transport: ReadConnectorTransport; now?: () => number
}) {
  const binding = connectorBindingSchema.parse(options.binding)
  const { transport, projectId } = options
  const fingerprint = sha256DigestSchema.parse(transport.expectedFingerprint)
  const now = options.now ?? Date.now
  const cursors = new Map<string, CursorState>()
  let window: number[] = []
  let active = false
  let retryAt = 0
  let closed = false
  const life = new AbortController()

  async function handle(raw: unknown, authorize: () => boolean, requestSignal?: AbortSignal) {
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success) return fail('invalid_input')
    const request = parsed.data
    const permitted = () => !closed && !requestSignal?.aborted && authorize()
    if (!permitted() || request.projectId !== projectId) return fail('permission_denied')
    let read: ConnectorPageRequest | undefined
    let seen = new Set<number>()
    const at = now()
    if (request.type === 'connector_read') {
      const selector = request.read
      const issue = selector.operation === 'comments' ? selector.issue : undefined
      read = selector.operation === 'issues' ? { operation: selector.operation, page: 1 }
        : { operation: selector.operation, issue: selector.issue, page: 1 }
      if (selector.cursor) {
        const saved = cursors.get(selector.cursor)
        if (!saved || saved.expiresAt <= at || saved.request.operation !== selector.operation
          || (saved.request.operation === 'comments' && saved.request.issue !== issue)) return fail('invalid_cursor')
        read = saved.request
        seen = new Set(saved.seen)
      }
    }
    if (active) return fail('busy')
    if (retryAt > at) return fail('rate_limited', new Date(retryAt).toISOString())
    window = window.filter(value => value > at - WINDOW_MS)
    if (window.length >= WINDOW_LIMIT) return fail('rate_limited', new Date(window[0]! + WINDOW_MS).toISOString())
    window.push(at)
    active = true
    const signals = [life.signal, AbortSignal.timeout(DEADLINE_MS)]
    if (requestSignal) signals.push(requestSignal)
    const signal = AbortSignal.any(signals)

    try {
      const session = await transport.open(signal, permitted)
      if (!permitted() || signal.aborted || !session.current()) return fail('permission_denied')
      const verified = inspectionSchema.safeParse(await session.inspect(signal))
      if (!permitted() || signal.aborted || !session.current()) return fail('permission_denied')
      if (!verified.success) return fail('invalid_result')
      if (!sameConnectorBinding(verified.data.binding, binding)) return fail('permission_denied')
      if (verified.data.fingerprint !== fingerprint) return fail('capability_changed')
      if (!read) return { ok: true as const, kind: 'connector_status' as const, binding: structuredClone(binding), fingerprint }

      const result = pageSchema.safeParse(await session.read({ ...read }, signal))
      if (!permitted() || signal.aborted || !session.current()) return fail('permission_denied')
      if (!result.success) return fail('invalid_result')
      const page = result.data
      if (!sameConnectorBinding(page.binding, binding)) return fail('permission_denied')
      if (page.fingerprint !== fingerprint) return fail('capability_changed')
      const issue = read.operation === 'comments' ? read.issue : undefined
      if (page.operation !== read.operation || page.issue !== issue || page.page !== read.page
        || page.items.some(item => issue === undefined ? item.kind === 'comment' : item.kind !== 'comment' || item.number !== issue)) {
        return fail('invalid_result')
      }
      const items: ConnectorRecord[] = []
      for (const item of page.items) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        items.push({ ...item, url: itemUrl(binding, item) })
      }
      let nextCursor: string | undefined
      if (page.hasNext && read.page < PAGE_LIMIT) {
        for (const [key, state] of cursors) if (state.expiresAt <= at) cursors.delete(key)
        if (cursors.size >= CURSOR_LIMIT) cursors.delete(cursors.keys().next().value!)
        nextCursor = randomUUID()
        cursors.set(nextCursor, { request: { ...read, page: read.page + 1 }, expiresAt: now() + CURSOR_MS, seen })
      }
      return { ok: true as const, kind: 'connector_page' as const, binding: structuredClone(binding), fingerprint, items,
        ...(nextCursor ? { nextCursor } : {}) }
    } catch (error) {
      if (!permitted()) return fail('permission_denied')
      if (error instanceof ConnectorError) {
        if (error.code === 'rate_limited') {
          const deadline = Date.parse(error.retryAt ?? '')
          const time = now()
          retryAt = Number.isFinite(deadline) && deadline > time
            ? Math.min(deadline, time + 7 * 86_400_000) : time + WINDOW_MS
          return fail(error.code, new Date(retryAt).toISOString())
        }
        return fail(error.code)
      }
      return fail('provider_unavailable')
    } finally { active = false }
  }

  return { handle, close() { closed = true; life.abort(); cursors.clear() } }
}

export type ReadConnector = ReturnType<typeof createReadConnector>
