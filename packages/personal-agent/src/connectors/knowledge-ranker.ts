import { lstatSync, realpathSync } from 'node:fs'
import { request } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { sha256DigestSchema } from '../domain/model.js'

const MAX_DOCUMENTS = 256
const MAX_REQUEST_BYTES = 512 * 1024
const MAX_RESPONSE_BYTES = 8192
const REQUEST_TIMEOUT_MS = 115_000
const decoder = new TextDecoder('utf-8', { fatal: true })

const rankMatchSchema = z.strictObject({ id: sha256DigestSchema, revision: sha256DigestSchema,
  offset: z.int().nonnegative(), length: z.int().positive() })

type RankDocument = Readonly<{
  ref: Readonly<{ id: string; rootId: string }>
  path: string
  revision: string
  text: string
}>

export type KnowledgeQuestionRanker = (input: {
  query: string
  rootId: string | undefined
  documents: readonly RankDocument[]
  lexicalIds: readonly string[]
  limit: number
}, signal?: AbortSignal) => Promise<readonly z.infer<typeof rankMatchSchema>[]>

function privateSocket(path: string): string {
  const owner = process.getuid?.()
  if (owner === undefined) throw new Error('The local knowledge ranker requires Unix socket permissions')
  const parent = realpathSync(dirname(path))
  const ancestors = []
  for (let dir = parent; dir !== dirname(dir); dir = dirname(dir)) ancestors.unshift(dir)
  for (const dir of ancestors) {
    const stats = lstatSync(dir)
    // Shared sticky directories such as /tmp protect entries owned by the host user.
    if (!stats.isDirectory() || (stats.uid !== owner && stats.uid !== 0) || ((stats.mode & 0o022) && !(stats.mode & 0o1000))) {
      throw new Error('The configured knowledge ranker socket has an unsafe parent directory')
    }
  }
  const resolved = join(parent, basename(path))
  const stats = lstatSync(resolved)
  if (!stats.isSocket() || stats.uid !== owner || (stats.mode & 0o077) !== 0) {
    throw new Error('The configured knowledge ranker requires a private Unix socket owned by the host user')
  }
  return resolved
}

/** The profile selects a private, same-user Unix socket for the scoped search. */
export function createSocketKnowledgeRanker(socketPath: string): KnowledgeQuestionRanker {
  return async ({ rootId, query, documents, lexicalIds, limit }, signal) => {
    signal?.throwIfAborted()
    if (documents.length > MAX_DOCUMENTS || documents.reduce((bytes, doc) => bytes + Buffer.byteLength(doc.text), 0) > MAX_REQUEST_BYTES) {
      throw new Error('The scoped documents exceed the local ranker request limit')
    }
    const socket = privateSocket(socketPath)
    const scoped = documents.map(({ ref, ...document }) => ({ ...document, id: ref.id, rootId: ref.rootId }))
    const body = Buffer.from(JSON.stringify({ root: rootId, query, documents: scoped, lexical: lexicalIds.slice(0, 3), limit }))
    if (body.length > MAX_REQUEST_BYTES) throw new Error('The encoded knowledge ranker request is too large')
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const client = request({ socketPath: socket, path: '/rank', method: 'POST',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      }, response => {
        response.on('error', reject)
        if (response.statusCode !== 200) {
          response.destroy()
          reject(new Error('The local knowledge ranker returned an unsuccessful status'))
          return
        }
        const chunks: Buffer[] = []
        let length = 0
        response.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('The local knowledge ranker response is too large'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve(Buffer.concat(chunks, length)))
      })
      client.on('error', reject)
      client.end(body)
    })
    signal?.throwIfAborted()
    const matches = z.array(rankMatchSchema).max(Math.min(scoped.length, limit)).parse(JSON.parse(decoder.decode(raw)))
    const allowed = new Set(scoped.map(document => document.id))
    if (matches.some(({ id }) => !allowed.delete(id))) throw new Error('The local ranker returned an invalid source list')
    return matches
  }
}
