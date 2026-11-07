import { createHash } from 'node:crypto'
import { closeSync } from 'node:fs'
import { isAbsolute, matchesGlob, posix } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import { indexText, keywordScore, keywordSnippet, knowledgeTerms, textPage, type IndexedText } from '../context/search-index.js'
import { sha256DigestSchema } from '../domain/model.js'
import {
  directoryStat, fileStamp, identity, knowledgeFileOperations, openKnowledgeRoot, readKnowledgeFile, type KnowledgeFiles,
} from './knowledge-files.js'

const rootId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u)
const extensions = z.enum(['.md', '.markdown', '.txt', '.rst', '.csv', '.json'])
const pattern = z.string().min(1).max(256).refine(value => !isAbsolute(value) && !/[\\\p{Cc}]/u.test(value))
const rootSchema = z.strictObject({
  id: rootId,
  directory: z.string().min(2).max(2048).refine(value => value.startsWith('/') && value !== '/'
    && !/[\\\p{Cc}]/u.test(value) && value.split('/').slice(1).every(part => part && part !== '.' && part !== '..')),
  include: z.array(pattern).min(1).max(16).default(['**/*']),
  exclude: z.array(pattern).max(16).default([]),
  types: z.array(extensions).min(1).max(6).default(['.md', '.markdown', '.txt']),
  maxFileBytes: z.int().min(1).max(1024 * 1024).default(128 * 1024),
  maxFiles: z.int().min(1).max(1024).default(256),
})

export const localKnowledgeConfigSchema = z.strictObject({
  roots: z.array(rootSchema).min(1).max(8).refine(roots => new Set(roots.map(root => root.id)).size === roots.length),
})
type RootConfig = z.infer<typeof rootSchema>
const knowledgeRefSchema = z.strictObject({ rootId, id: sha256DigestSchema })
export const knowledgeRequestSchemas = [
  z.strictObject({ type: z.literal('knowledge_status') }),
  z.strictObject({ type: z.literal('knowledge_search'), rootId: rootId.optional(),
    query: z.string().trim().min(1).max(256), limit: z.int().min(1).max(20).default(10) }),
  z.strictObject({ type: z.literal('knowledge_read'), ref: knowledgeRefSchema, revision: sha256DigestSchema,
    offset: z.int().nonnegative().default(0), maxBytes: z.int().min(4).max(4096).default(1024) }),
] as const
const requestSchema = z.discriminatedUnion('type', knowledgeRequestSchemas)

type Reference = z.infer<typeof knowledgeRefSchema>
type Source = { ref: Reference; path: string; revision: string }
type Row = { source: Source; text: IndexedText; stamp: string }
type Root = { config: RootConfig; pinned?: string; rows: Map<string, Row>; invalid: Map<string, string>;
  status: 'available' | 'limited' | 'unavailable' }
type RootStatus = { id: string; status: Root['status']; files: number }

const ENTRY_LIMIT = 8192
const DEPTH_LIMIT = 16
const INDEX_LIMIT = 4 * 1024 * 1024
const PATH_LIMIT = 768
const fail = <T extends string>(code: T) => ({ ok: false as const, code })

function sourceId(root: RootConfig, path: string): string {
  return createHash('sha256').update(JSON.stringify(['knowledge-v1', root.id, root.directory, path])).digest('hex')
}

function excluded(root: RootConfig, path: string): boolean {
  return root.exclude.some(glob => matchesGlob(path, glob) || matchesGlob(`${path}/`, glob))
}

function included(root: RootConfig, path: string): boolean {
  const extension = posix.extname(path).toLowerCase()
  return root.types.some(type => type === extension) && root.include.some(glob => matchesGlob(path, glob))
}

/** Read-only connector. Its derived text index stays in process and is rebuilt on demand. */
export function createLocalKnowledge(input: z.input<typeof localKnowledgeConfigSchema>) {
  const config = localKnowledgeConfigSchema.parse(input)
  const roots = new Map<string, Root>(config.roots.map(root => [root.id, {
    config: root, rows: new Map(), invalid: new Map(), status: 'unavailable',
  }]))
  const files = knowledgeFileOperations()
  let closed = false
  let refreshing: Promise<void> | undefined

  function openRoot(root: Root, operations: KnowledgeFiles) {
    const fd = openKnowledgeRoot(operations, root.config.directory)
    if (fd === undefined) return undefined
    const stat = directoryStat(fd)
    if (stat) {
      const key = identity(stat)
      if (root.pinned === undefined || root.pinned === key) {
        root.pinned = key
        return { fd, device: stat.dev }
      }
    }
    closeSync(fd)
    return undefined
  }

  function withFile<T>(root: Root, path: string, read: (fd: number, device: bigint) => T): T | undefined {
    if (!files || closed) return undefined
    try {
      const anchor = openRoot(root, files)
      if (!anchor) return undefined
      let fd = anchor.fd
      try {
        const parts = path.split('/')
        const file = parts.pop()!
        for (const part of parts) {
          const next = files.open(fd, part, true)
          if (next === undefined) return undefined
          closeSync(fd)
          fd = next
          if (directoryStat(fd)?.dev !== anchor.device) return undefined
        }
        const child = files.open(fd, file, false)
        if (child === undefined) return undefined
        try { return read(child, anchor.device) } finally { closeSync(child) }
      } finally { closeSync(fd) }
    } catch { return undefined }
  }

  async function scan(root: Root, operations: KnowledgeFiles): Promise<void> {
    const { config, rows: previous } = root
    const rows = new Map<string, Row>()
    const invalid = new Map<string, string>()
    let remaining = ENTRY_LIMIT
    let bytes = 0
    let remainingRead = INDEX_LIMIT * 2
    let visited = 0
    let limited = false
    let inaccessible = false

    async function walk(directory: number, device: bigint, prefix: string, depth: number): Promise<void> {
      const result = operations.entries(directory, remaining)
      if (!result) { inaccessible = true; return }
      remaining -= result.examined
      limited ||= result.limited
      for (const entry of result.items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited % 32 === 0) await setImmediate()
        if (closed) return
        if (rows.size >= config.maxFiles) { limited = true; return }
        const path = prefix + entry.name
        if (path.length > PATH_LIMIT || excluded(config, path)) continue
        if (entry.kind === 'directory') {
          if (depth >= DEPTH_LIMIT || remaining === 0) { limited = true; continue }
          const child = operations.open(directory, entry.name, true)
          if (child === undefined) { inaccessible = true; continue }
          try {
            if (directoryStat(child)?.dev === device) await walk(child, device, path + '/', depth + 1)
            else inaccessible = true
          } finally { closeSync(child) }
        } else if (included(config, path)) {
          const child = operations.open(directory, entry.name, false)
          if (child === undefined) continue
          try {
            const metadata = fileStamp(child, device, config.maxFileBytes)
            if (!metadata) continue
            const id = sourceId(config, path)
            if (root.invalid.get(id) === metadata.stamp) { invalid.set(id, metadata.stamp); continue }
            const prior = previous.get(id)
            const cached = prior?.stamp === metadata.stamp ? prior : undefined
            if (!cached) {
              if (metadata.size > remainingRead) { limited = true; continue }
              remainingRead -= metadata.size
            }
            const fresh = cached ? undefined : readKnowledgeFile(child, device, config.maxFileBytes)
            const text = cached?.text ?? (fresh && indexText(fresh.bytes))
            if (!text) {
              if (fresh) invalid.set(id, fresh.stamp)
              continue
            }
            if (bytes + text.indexedBytes > INDEX_LIMIT) { limited = true; continue }
            bytes += text.indexedBytes
            rows.set(id, cached ?? { source: { ref: { rootId: config.id, id }, path, revision: text.revision }, text, stamp: fresh!.stamp })
          } catch { /* An unreadable or changing file has no derived entry. */ }
          finally { closeSync(child) }
        }
      }
    }

    root.status = 'unavailable'
    try {
      const anchor = openRoot(root, operations)
      if (!anchor) return
      try {
        await walk(anchor.fd, anchor.device, '', 0)
      } finally { closeSync(anchor.fd) }
      if (closed) return
      const current = openRoot(root, operations)
      if (!current) return
      closeSync(current.fd)
      root.status = limited || inaccessible ? 'limited' : 'available'
    } catch { /* A failed root never publishes its previous contents. */ }
    finally {
      const usable = root.status !== 'unavailable' && !closed
      root.rows = usable ? rows : new Map()
      root.invalid = usable ? invalid : new Map()
    }
  }

  function refresh() {
    if (!refreshing && files && !closed) {
      refreshing = (async () => {
        for (const root of roots.values()) {
          if (closed) break
          await scan(root, files)
        }
      })().finally(() => { refreshing = undefined })
    }
    return refreshing
  }

  function statuses(): RootStatus[] {
    return [...roots.values()].map(root => ({ id: root.config.id, status: root.status, files: root.rows.size }))
  }

  function currentRow(root: Root, row: Row): boolean {
    const stamp = withFile(root, row.source.path, (fd, device) => fileStamp(fd, device, root.config.maxFileBytes)?.stamp)
    if (stamp === row.stamp) return true
    root.rows.delete(row.source.ref.id)
    return false
  }

  return {
    async handle(input: unknown, current: () => boolean, signal?: AbortSignal) {
      const parsed = requestSchema.safeParse(input)
      if (!parsed.success) return fail('invalid_input')
      if (!current() || closed || signal?.aborted) return fail('permission_denied')
      const request = parsed.data
      const id = request.type === 'knowledge_read' ? request.ref.rootId : request.type === 'knowledge_search' ? request.rootId : undefined
      const root = id === undefined ? undefined : roots.get(id)
      if (id !== undefined && !root) return fail('not_found')
      if (request.type !== 'knowledge_read' || !root?.rows.has(request.ref.id)) await refresh()
      if (!current() || closed || signal?.aborted) return fail('permission_denied')
      if (request.type === 'knowledge_status') return { ok: true as const, kind: 'knowledge_status' as const, roots: statuses() }
      if (request.type === 'knowledge_search') {
        const terms = knowledgeTerms(request.query)
        if (!terms) return fail('invalid_input')
        const candidates = [...(root ? [root] : roots.values())].flatMap(origin => [...origin.rows.values()].flatMap(row => {
          const score = keywordScore(row.text, row.source.path, terms)
          return score ? [{ origin, row, score }] : []
        })).sort((a, b) => b.score - a.score || a.row.source.path.localeCompare(b.row.source.path))
        const hits = []
        for (const { origin, row } of candidates) {
          if (!currentRow(origin, row)) continue
          hits.push({ ...row.source, snippet: keywordSnippet(row.text, terms) })
          if (hits.length >= request.limit) break
        }
        return { ok: true as const, kind: 'knowledge_search' as const, roots: statuses(), hits }
      }

      const row = root?.rows.get(request.ref.id)
      if (!root || !row) return fail('source_unavailable')
      const loaded = withFile(root, row.source.path, (fd, device) => readKnowledgeFile(fd, device, root.config.maxFileBytes))
      const currentStamp = withFile(root, row.source.path, (fd, device) => fileStamp(fd, device, root.config.maxFileBytes)?.stamp)
      if (!loaded || currentStamp !== loaded.stamp) {
        root.rows.delete(row.source.ref.id)
        return fail('source_unavailable')
      }
      const revision = createHash('sha256').update(loaded.bytes).digest('hex')
      if (revision !== row.source.revision) root.rows.delete(row.source.ref.id)
      if (revision !== request.revision || revision !== row.source.revision) return fail('stale_source')
      const page = textPage(loaded.bytes, request.offset, request.maxBytes)
      return page ? { ok: true as const, kind: 'knowledge_page' as const, source: row.source, ...page } : fail('invalid_input')
    },
    close() {
      closed = true
      for (const root of roots.values()) { root.rows.clear(); root.invalid.clear() }
    },
  }
}

export type LocalKnowledge = ReturnType<typeof createLocalKnowledge>
