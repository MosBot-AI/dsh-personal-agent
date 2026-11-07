import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId as nativeSessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { sha256DigestSchema, workerCursorSchema, type SessionId } from '../domain/model.js'

export interface SessionReadbackInput {
  readonly sessionId: SessionId
  readonly cwd: string
  readonly cursor: string
  readonly messageId: string
  readonly digest: string
}

export type SessionInputState = 'pending' | 'admitted' | 'cancelled' | 'missing' | 'unknown'
export type SessionReadback = (input: SessionReadbackInput) => Promise<SessionInputState>

const PAGE_SIZE = 512
const MAX_EVENTS = 100_000
const MAX_PENDING = 4_096

/** Digest of the complete model input, including the rendered report instructions. */
export function workerMessageDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function identify(message: UserMessage, input: SessionReadbackInput): 'exact' | 'other' | 'conflict' {
  const { source, id, content } = message
  const cursorMatches = source.kind === 'dshpa-work-input' && source.cursor === input.cursor
  if (!cursorMatches && id !== input.messageId) return 'other'
  const block = content[0]
  if (!cursorMatches || id !== input.messageId || source.kind !== 'dshpa-work-input'
    || (source.digest !== undefined && source.digest !== input.digest)
    || content.length !== 1 || block?.type !== 'text' || workerMessageDigest(block.text) !== input.digest) return 'conflict'
  return 'exact'
}

/** Fold the native inbox without retaining unrelated message content. */
function observeInput(input: SessionReadbackInput) {
  const inbox = { 'next-turn': [] as boolean[], 'next-step': [] as boolean[] }
  let insertions = 0
  let admissions = 0
  let claimed = false
  let cancelled = false
  let conflicted = false
  return {
    append(event: SessionEvent): boolean {
      if (event.type === 'agent/inbox/spliced') {
        const { target, start, removedCount = 0, inserted, outcome } = event.data
        const pending = inbox[target]
        if (!pending || !Number.isSafeInteger(start) || start < 0 || start > pending.length
          || !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > pending.length
          || pending.length - removedCount + inserted.length > MAX_PENDING) return false
        const exact = inserted.map(message => {
          const match = identify(message, input)
          if (match === 'conflict') conflicted = true
          if (match === 'exact') insertions++
          return match === 'exact'
        })
        const removed = pending.splice(start, removedCount, ...exact)
        if (removed.some(Boolean)) {
          if (outcome === 'canceled') cancelled = true
          else claimed = true
        }
      } else if (event.type === 'user/message') {
        const match = identify(event.data, input)
        if (match === 'conflict') conflicted = true
        if (match === 'exact') {
          if (!claimed || cancelled || insertions !== 1) conflicted = true
          admissions++
        }
      }
      return !conflicted && insertions <= 1 && admissions <= 1
    },
    result(): SessionInputState {
      if (conflicted || insertions > 1 || admissions > 1) return 'unknown'
      const pending = inbox['next-turn'].some(Boolean) || inbox['next-step'].some(Boolean)
      if (insertions === 0) return admissions === 0 ? 'missing' : 'unknown'
      if (admissions === 1) return pending || cancelled ? 'unknown' : 'admitted'
      if (cancelled) return pending ? 'unknown' : 'cancelled'
      // Claim without a committed user message cannot prove whether work was
      // entered. Never turn this gap into a replay decision.
      return pending ? 'pending' : 'unknown'
    },
  }
}

/** Read an unchanged cold DSH log. This operation never opens a native Agent. */
export function createSessionReadback(ctx: Context): SessionReadback {
  return async options => {
    const input = { ...options }
    if (!workerCursorSchema.safeParse(input.cursor).success || !sha256DigestSchema.safeParse(input.digest).success
      || typeof input.messageId !== 'string' || input.messageId.length === 0) return 'unknown'
    const id = nativeSessionId(input.sessionId)
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) return 'unknown'
    const cold = () => ctx.get('agents')?.get(id) === undefined && ctx.get('sessions')?.get(id) === undefined
    try {
      if (!cold()) return 'unknown'
      const before = await persistence.stat(id)
      if (!cold()) return 'unknown'
      if (!before) return 'missing'
      if (before.formatStatus === 'migration-required' || before.header.id !== id
        || before.header.cwd !== input.cwd || before.header.isSeeded || before.header.origin !== undefined
        || before.header.parentSession !== undefined
        || (before.eventCount !== undefined && before.eventCount > MAX_EVENTS)) return 'unknown'
      const observation = observeInput(input)
      let count = 0
      const reader = await persistence.open(id, 'read')
      try {
        if (reader.header.id !== id || reader.header.cwd !== input.cwd || reader.header.isSeeded
          || reader.header.origin !== undefined || reader.header.parentSession !== undefined
          || reader.inheritedEventCount !== 0) return 'unknown'
        for (;;) {
          const { events } = await reader.read(count, PAGE_SIZE)
          if (events.length === 0) break
          if (events.length > PAGE_SIZE || count + events.length > MAX_EVENTS) return 'unknown'
          for (const event of events) {
            if (event.seq !== count || !observation.append(event)) return 'unknown'
            count++
          }
        }
      } finally {
        await reader.close()
      }
      const after = await persistence.stat(id)
      if (!cold() || !after || after.revision !== before.revision
        || (before.eventCount !== undefined && before.eventCount !== count)
        || (after.eventCount !== undefined && after.eventCount !== count)) return 'unknown'
      return observation.result()
    } catch {
      return 'unknown'
    }
  }
}
