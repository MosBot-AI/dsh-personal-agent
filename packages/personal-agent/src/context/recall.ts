import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { sha256DigestSchema, utcInstantSchema, type Artifact, type SourceEvent, type SourceEventId, type UtcInstant } from '../domain/model.js'
import { ROUTINE_SOURCE } from '../domain/routines.js'
import type { WorkState } from '../domain/transitions.js'
import type { WorkRef, WorkStore } from '../storage/store.js'
import { contextPointerId, contextPointerKey, contextPointerSchema, type ContextPointer } from './checkpoint.js'

const DEFAULT_PAGE_BYTES = 1_024
const MAX_PAGE_BYTES = 4_096
const SUMMARY_BYTES = 256
const MAX_ADJACENT = 4
const MAX_ADJACENT_CANDIDATES = 4
const MAX_SEARCH_CANDIDATES = 12
const MAX_SEARCH_BYTES = 8_192
const MAX_PROVENANCE = 64
const LOCAL_SOURCE = 'dshpa-local-inbox'

const cursorFormat = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/u
const cursorSchema = z.strictObject({
  version: z.literal(1), binding: sha256DigestSchema, revision: sha256DigestSchema,
  digest: sha256DigestSchema, offset: z.int().positive(),
})
type Cursor = z.infer<typeof cursorSchema>

export const contextRecallRequestSchema = z.strictObject({
  ref: contextPointerSchema,
  cursor: z.string().max(556).optional(),
  maxBytes: z.int().min(4).max(MAX_PAGE_BYTES).default(DEFAULT_PAGE_BYTES),
})

export const contextSearchRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(256), limit: z.int().min(1).max(10).default(5),
})

type EvidenceBase = { readonly scope: WorkRef; readonly state: WorkState }
export type RecallEvidence = EvidenceBase & (
  | { readonly kind: 'task'; readonly ref: Extract<ContextPointer, { kind: 'task' }> }
  | { readonly kind: 'event'; readonly ref: Extract<ContextPointer, { kind: 'event' }>; readonly event: SourceEvent }
  | { readonly kind: 'artifact'; readonly ref: Extract<ContextPointer, { kind: 'artifact' }>; readonly artifact: Artifact }
)

export interface RecallSummary {
  readonly ref: ContextPointer
  readonly revision: string
  readonly summary: string
  readonly truncated: boolean
}

export interface RecallPage {
  readonly ref: ContextPointer
  readonly revision: string
  readonly digest: string
  readonly text: string
  readonly totalBytes: number
  readonly nextCursor?: string
  readonly adjacent: readonly RecallSummary[]
}

type FailureCode = 'invalid_input' | 'not_found' | 'permission_denied' | 'source_unavailable' | 'invalid_cursor' | 'stale_cursor'
type Failure = { readonly ok: false; readonly code: FailureCode }
type Result<T> = { readonly ok: true; readonly value: T } | Failure
type Document = { readonly ref: ContextPointer; readonly revision: string; readonly bytes: Buffer }
type Store = Pick<WorkStore, 'getWork' | 'getContextSource' | 'getContextArtifact' | 'listContextPointers'>

export interface RecallOptions {
  readonly store: Store
  readonly authorize: (authority: unknown, evidence: RecallEvidence) => boolean
  readonly now?: () => UtcInstant
}

function fail(code: FailureCode): Failure { return { ok: false, code } }
function ok<T>(value: T): Result<T> { return { ok: true, value } }
function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }

function sameScope(left: Pick<WorkRef, 'ownerId' | 'profileId'>, right: Pick<WorkRef, 'ownerId' | 'profileId'>): boolean {
  return left.ownerId === right.ownerId && left.profileId === right.profileId
}

function binding(scope: WorkRef, ref: ContextPointer): string {
  return sha256(JSON.stringify([scope.ownerId, scope.profileId, scope.taskId, ref.kind, contextPointerId(ref)]))
}

function byteEnd(bytes: Buffer, offset: number, limit: number): number {
  let end = Math.min(offset + limit, bytes.length)
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return end
}

function summarize(document: Document): RecallSummary {
  const end = byteEnd(document.bytes, 0, SUMMARY_BYTES)
  const summary = document.bytes.toString('utf8', 0, end).replace(/[\p{Cc}\s]+/gu, ' ').trim()
  return { ref: document.ref, revision: document.revision, summary, truncated: end < document.bytes.length }
}

function searchText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

function taskText({ task }: WorkState): string {
  return [task.requestedOutcome, ...task.constraints, ...task.acceptance.criteria].join('\n')
}

/** Project only the textual intake field. Metadata and arbitrary provider bodies stay out of recall. */
function eventText(event: SourceEvent): string | undefined {
  const body = event.body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  if (event.sourceInstanceId === ROUTINE_SOURCE && body.kind === 'routine_wake') return 'Routine wake recorded.'
  if (event.sourceInstanceId === LOCAL_SOURCE) {
    if (body.kind === 'inbox-task' && typeof body.outcome === 'string') return body.outcome
    if (body.kind === 'inbox-answer' && typeof body.text === 'string') return body.text
    return undefined
  }
  return event.actor.accountId !== undefined && (body.kind === 'event' || body.kind === 'candidate')
    && typeof body.text === 'string' && body.text.length <= 8_192 ? body.text : undefined
}

/** A reference is lookup data. Only the caller's current authority can disclose its bytes. */
export function createRecall(options: RecallOptions) {
  const { store } = options
  const now = options.now ?? (() => utcInstantSchema.parse(new Date().toISOString()))
  const cursorKey = randomBytes(32)
  const mac = (body: string) => createHmac('sha256', cursorKey).update(body).digest()

  function encodeCursor(cursor: Cursor): string {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url')
    return `${body}.${mac(body).toString('base64url')}`
  }

  function decodeCursor(token: string): Cursor | undefined {
    if (!cursorFormat.test(token)) return undefined
    const [body, signature] = token.split('.') as [string, string]
    const tag = Buffer.from(signature, 'base64url')
    if (tag.length !== 32 || tag.toString('base64url') !== signature || !timingSafeEqual(mac(body), tag)) return undefined
    try {
      const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))
      return parsed.success ? parsed.data : undefined
    } catch { return undefined }
  }

  function allowed(authority: unknown, evidence: RecallEvidence): boolean {
    try { return options.authorize(authority, structuredClone(evidence)) === true } catch { return false }
  }

  function current(scope: WorkRef, authority: unknown): Result<WorkState> {
    const state = store.getWork(scope)
    if (!state || state.task.id !== scope.taskId || !sameScope(state.task, scope)) return fail('not_found')
    const ref = { kind: 'task', taskId: scope.taskId } as const
    if (!allowed(authority, { kind: 'task', ref, scope, state })) return fail('permission_denied')
    return ok(state)
  }

  function source(scope: WorkRef, state: WorkState, authority: unknown, eventId: SourceEventId, at: UtcInstant): Result<SourceEvent> {
    const ref = { kind: 'event', eventId } as const
    const event = store.getContextSource(scope, eventId, at)
    if (!event || event.id !== eventId || !sameScope(event, scope)) return fail('source_unavailable')
    return allowed(authority, { kind: 'event', ref, scope, state, event }) ? ok(event) : fail('permission_denied')
  }

  function provenance(scope: WorkRef, state: WorkState, authority: unknown, ids: readonly SourceEventId[], at: UtcInstant): Failure | undefined {
    if (ids.length > MAX_PROVENANCE) return fail('source_unavailable')
    for (const id of new Set(ids)) {
      const linked = source(scope, state, authority, id, at)
      if (!linked.ok) return linked
    }
    return undefined
  }

  function read(scope: WorkRef, state: WorkState, authority: unknown, ref: ContextPointer, at: UtcInstant): Result<Document> {
    if (ref.kind === 'task') {
      if (ref.taskId !== scope.taskId) return fail('permission_denied')
      return provenance(scope, state, authority, state.task.provenance.sourceEventIds, at)
        ?? ok({ ref, revision: String(state.task.version), bytes: Buffer.from(taskText(state)) })
    }
    if (ref.kind === 'event') {
      const linked = source(scope, state, authority, ref.eventId, at)
      if (!linked.ok) return linked
      const text = eventText(linked.value)
      return text?.trim() ? ok({ ref, revision: sha256(linked.value.externalRevision), bytes: Buffer.from(text) }) : fail('source_unavailable')
    }
    const sealed = store.getContextArtifact(scope, ref.artifactId, at)
    if (!sealed || sealed.taskId !== scope.taskId || sealed.artifact.id !== ref.artifactId
      || !sameScope(sealed.artifact, scope)) return fail('source_unavailable')
    const artifact = sealed.artifact
    if (!allowed(authority, { kind: 'artifact', ref, scope, state, artifact })) return fail('permission_denied')
    return provenance(scope, state, authority, artifact.provenance.sourceEventIds, at)
      ?? ok({ ref, revision: String(sealed.version), bytes: Buffer.from(sealed.bytes) })
  }

  function candidates(scope: WorkRef, at: UtcInstant, limit: number): ContextPointer[] {
    const events = store.listContextPointers(scope, { kind: 'event', limit, at }).items.slice(0, limit)
    const artifacts = store.listContextPointers(scope, { kind: 'artifact', limit, at }).items.slice(0, limit)
    const pointers: ContextPointer[] = [{ kind: 'task', taskId: scope.taskId }]
    for (let index = 0; index < limit; index++) {
      const event = events[index]
      const artifact = artifacts[index]
      if (event) pointers.push(event)
      if (artifact) pointers.push(artifact)
    }
    return pointers
  }

  function adjacent(scope: WorkRef, state: WorkState, authority: unknown, ref: ContextPointer, at: UtcInstant): RecallSummary[] {
    const summaries: RecallSummary[] = []
    const key = contextPointerKey(ref)
    for (const candidate of candidates(scope, at, MAX_ADJACENT_CANDIDATES)) {
      if (contextPointerKey(candidate) === key) continue
      const document = read(scope, state, authority, candidate, at)
      if (document.ok) summaries.push(summarize(document.value))
      if (summaries.length >= MAX_ADJACENT) break
    }
    return summaries
  }

  return Object.freeze({
    lookup(scope: WorkRef, authority: unknown, input: unknown): { readonly ok: true; readonly page: RecallPage } | Failure {
      const parsed = contextRecallRequestSchema.safeParse(input)
      if (!parsed.success) return fail('invalid_input')
      const { ref, maxBytes, cursor: token } = parsed.data
      const key = binding(scope, ref)
      const cursor = token === undefined ? undefined : decodeCursor(token)
      if (token !== undefined && (!cursor || cursor.binding !== key)) return fail('invalid_cursor')
      try {
        const state = current(scope, authority)
        if (!state.ok) return state
        const at = now()
        const result = read(scope, state.value, authority, ref, at)
        if (!result.ok) return result
        const { bytes, revision } = result.value
        const digest = sha256(bytes)
        const revisionHash = sha256(revision)
        const offset = cursor?.offset ?? 0
        if (cursor && (cursor.digest !== digest || cursor.revision !== revisionHash || offset >= bytes.length
          || (bytes[offset]! & 0xc0) === 0x80)) return fail('stale_cursor')
        const end = byteEnd(bytes, offset, maxBytes)
        return { ok: true, page: { ref, revision, digest, text: bytes.toString('utf8', offset, end), totalBytes: bytes.length,
          ...(end < bytes.length ? { nextCursor: encodeCursor({ version: 1, binding: key, digest, revision: revisionHash, offset: end }) } : {}),
          adjacent: cursor ? [] : adjacent(scope, state.value, authority, ref, at) } }
      } catch { return fail('source_unavailable') }
    },
    summary(scope: WorkRef, authority: unknown, input: unknown): { readonly ok: true; readonly summary: RecallSummary } | Failure {
      const ref = contextPointerSchema.safeParse(input)
      if (!ref.success) return fail('invalid_input')
      try {
        const state = current(scope, authority)
        if (!state.ok) return state
        const result = read(scope, state.value, authority, ref.data, now())
        return result.ok ? { ok: true, summary: summarize(result.value) } : result
      } catch { return fail('source_unavailable') }
    },
    search(scope: WorkRef, authority: unknown, input: unknown): { readonly ok: true; readonly hits: readonly RecallSummary[] } | Failure {
      const parsed = contextSearchRequestSchema.safeParse(input)
      if (!parsed.success) return fail('invalid_input')
      const query = searchText(parsed.data.query)
      const terms = [...new Set(query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [query])]
      if (!query || terms.length > 8 || Buffer.byteLength(query) > 1_024) return fail('invalid_input')
      try {
        const state = current(scope, authority)
        if (!state.ok) return state
        const at = now()
        const hits: RecallSummary[] = []
        for (const ref of candidates(scope, at, MAX_SEARCH_CANDIDATES)) {
          const document = read(scope, state.value, authority, ref, at)
          if (!document.ok) continue
          const { bytes } = document.value
          const normalized = searchText(bytes.toString('utf8', 0, byteEnd(bytes, 0, MAX_SEARCH_BYTES)))
          if (terms.every(term => normalized.includes(term))) hits.push(summarize(document.value))
          if (hits.length >= parsed.data.limit) break
        }
        return { ok: true, hits }
      } catch { return fail('source_unavailable') }
    },
  })
}
