import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { it, onTestFinished } from 'vitest'
import {
  INBOX_RPC_ENDPOINT, type InboxRequest, type InboxResponse,
} from '../../packages/personal-agent/src/inbox/protocol.js'
import { openWebHost, prepareWebHost } from './fixtures/web-host.js'

interface SearchInput {
  id: string
  query: string
  language: string
}
interface Query extends SearchInput {
  mode: string
  relevant: { path: string; anchor: string }[]
}
interface Corpus {
  documents: Record<string, string>
  queries: Query[]
  negativeControls: (Omit<SearchInput, 'id'> & { id?: string })[]
}
type KnowledgeSource = Extract<InboxResponse, { kind: 'knowledge_page' }>['source']
interface VerifiedAnchor {
  queryId: string
  sha256: string
  byteOffset: number
  bytes: number
}
interface VerifiedDocument {
  path: string
  rootId: string
  refId: string
  revision: string
  contentSha256: string
  bytes: number
  anchors: VerifiedAnchor[]
}

const corpusPath = process.env.DSHPA_SEMANTIC_CORPUS
const reportPath = process.env.DSHPA_SEMANTIC_LEXICAL_REPORT
const repository = fileURLToPath(new URL('../../', import.meta.url))
const probe = fileURLToPath(new URL('./fixtures/memory-flow-probe.mjs', import.meta.url))
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const rootId = 'release-corpus'
const limit = 3
const warmSampleCount = 100

function peakRssKiB(pid: number | undefined) {
  assert.ok(pid, 'Native Web host PID is required for peak RSS')
  const peak = /^VmHWM:\s+(\d+)\s+kB$/mu.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
  assert.ok(peak && Number(peak[1]) > 0, 'Native Web host VmHWM must be available')
  return Number(peak[1])
}

it.skipIf(corpusPath === undefined && reportPath === undefined)('benchmarks the native lexical retrieval baseline', async () => {
  assert.ok(corpusPath && isAbsolute(corpusPath), 'Supply an absolute DSHPA_SEMANTIC_CORPUS file path')
  assert.ok(reportPath && isAbsolute(reportPath), 'Supply an absolute DSHPA_SEMANTIC_LEXICAL_REPORT file path')
  assert.notEqual(resolve(reportPath), resolve(corpusPath), 'The report must be a separate file')
  assert.equal(process.platform, 'linux', 'This benchmark reads native host RSS from Linux procfs')
  const corpusBytes = readFileSync(corpusPath)
  const corpusDigest = sha256(corpusBytes)
  const { documents, queries, negativeControls } = JSON.parse(corpusBytes.toString('utf8')) as Corpus
  const entries = Object.entries(documents)
  assert.ok(entries.length && queries.length && Array.isArray(negativeControls), 'Supply a retrieval corpus')
  for (const [path, body] of entries) {
    assert.ok(path.length <= 256 && !/[\\\p{Cc}]/u.test(path)
      && path.split('/').every(part => part && part !== '.' && part !== '..')
      && typeof body === 'string', 'Every corpus document must have a searchable relative path and text')
  }
  const controls = negativeControls.map((control, index) => ({ ...control, id: control.id ?? `no-answer-${index + 1}` }))
  const inputs = [...queries, ...controls]
  assert.equal(new Set(inputs.map(({ id }) => id)).size, inputs.length, 'Query IDs must be unique')
  for (const { id, query, language } of inputs) {
    assert.ok(id && typeof id === 'string' && typeof query === 'string' && language, 'Every query needs an ID, text and language')
  }
  const annotations = new Map<string, { queryId: string; anchor: string }[]>()
  for (const { id, mode, relevant } of queries) {
    assert.ok(mode && relevant.length, `Missing query mode or relevant sources for ${id}`)
    for (const { path, anchor } of relevant) {
      assert.ok(Object.hasOwn(documents, path) && anchor && documents[path]!.includes(anchor), `Invalid source annotation for ${id}`)
      const sources = annotations.get(path) ?? []
      sources.push({ queryId: id, anchor })
      annotations.set(path, sources)
    }
  }

  const prepared = prepareWebHost(probe, [
    '- id: dshpa', '  config:', '    inbox:',
    "      storageDirectory: !!js dshHomePath('knowledge-inbox')", '      workRoot: !!js process.cwd()',
    '      knowledge:', '        roots:', `          - id: ${rootId}`,
    `            directory: !!js process.cwd() + '/${rootId}'`, '            include: ["**/*"]',
  ])
  onTestFinished(() => rmSync(prepared.root, { recursive: true, force: true }))
  for (const [path, body] of entries) {
    const destination = join(prepared.root, rootId, path)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    writeFileSync(destination, body, { flag: 'wx', mode: 0o600 })
  }

  const startupStarted = performance.now()
  const host = await openWebHost(probe, { prepared, configOnly: true })
  const hostStartupMs = performance.now() - startupStarted
  const owner = await host.exchange()
  const expectedRoots = [{ id: rootId, status: 'available', files: entries.length }]

  async function inbox(request: InboxRequest) {
    const response = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, owner)
    assert.ok(response.status === 200 && response.result?.ok, host.diagnostics())
    return response.result.value
  }

  function searchRequest(query: string): InboxRequest {
    return { type: 'knowledge_search', query, rootId, limit }
  }

  async function search(query: string) {
    const started = performance.now()
    const result = await inbox(searchRequest(query))
    const elapsedMs = performance.now() - started
    if (!result.ok && result.code === 'invalid_input') return { invalidInput: true, hits: [], elapsedMs }
    assert.ok(result.ok && result.kind === 'knowledge_search', 'Native knowledge search failed')
    assert.deepEqual(result.roots, expectedRoots)
    return { invalidInput: false, hits: result.hits, elapsedMs }
  }

  const indexStarted = performance.now()
  const status = await inbox({ type: 'knowledge_status' })
  const indexMs = performance.now() - indexStarted
  assert.ok(status.ok && status.kind === 'knowledge_status')
  assert.deepEqual(status.roots, expectedRoots)
  const cold = await search(queries[0]!.query)
  const warmMs: number[] = []
  const warmIds: string[] = []
  const ranked = new Map<string, Awaited<ReturnType<typeof search>>>()
  for (let index = 0; index < Math.max(warmSampleCount, inputs.length); index += 1) {
    const { id, query } = inputs[index % inputs.length]!
    const result = await search(query)
    warmMs.push(result.elapsedMs)
    warmIds.push(id)
    if (!ranked.has(id)) ranked.set(id, result)
  }
  const peakRss = peakRssKiB(host.pid)
  const operator = await host.exchange(true)
  const sample = searchRequest(queries[0]!.query)
  assert.equal((await host.rpc(INBOX_RPC_ENDPOINT, sample)).status, 401)
  assert.equal((await host.rpc(INBOX_RPC_ENDPOINT, sample, operator)).status, 403)

  async function readSource(source: KnowledgeSource, body: string) {
    const bytes = Buffer.byteLength(body)
    let offset = 0
    const pages: string[] = []
    while (true) {
      const page = await inbox({ type: 'knowledge_read', ref: source.ref, revision: source.revision, offset, maxBytes: 4096 })
      assert.ok(page.ok && page.kind === 'knowledge_page', `Native source read failed for ${source.path}`)
      assert.deepEqual(page.source, { path: source.path, ref: source.ref, revision: source.revision })
      assert.equal(page.totalBytes, bytes)
      pages.push(page.text)
      offset += Buffer.byteLength(page.text)
      if (page.nextOffset === undefined) break
      assert.ok(page.text.length && page.nextOffset === offset && offset < bytes)
    }
    const text = pages.join('')
    assert.ok(offset === bytes && text === body && source.revision === sha256(text), `Source content differs for ${source.path}`)
    return text
  }

  const evidence = new Map<string, VerifiedDocument>()
  for (const [path, body] of entries) {
    const exact = await search(path)
    const source = exact.hits[0]
    assert.ok(source?.path === path && source.ref.rootId === rootId, `Exact path search failed for ${path}`)
    const text = await readSource(source, body)
    const anchors = (annotations.get(path) ?? []).map(({ queryId, anchor }) => {
      const index = text.indexOf(anchor)
      assert.ok(index >= 0, `Authenticated source lacks the annotated answer for ${queryId}`)
      return { queryId, sha256: sha256(anchor), byteOffset: Buffer.byteLength(text.slice(0, index)), bytes: Buffer.byteLength(anchor) }
    })
    evidence.set(path, { path, rootId, refId: source.ref.id, revision: source.revision,
      contentSha256: sha256(text), bytes: Buffer.byteLength(text), anchors })
  }

  function checkedPaths(hits: readonly KnowledgeSource[]) {
    return hits.map(hit => {
      const source = evidence.get(hit.path)
      assert.ok(source && source.refId === hit.ref.id && source.rootId === hit.ref.rootId && source.revision === hit.revision,
        `Ranked hit failed exact source verification for ${hit.path}`)
      return hit.path
    })
  }

  function reportRow({ id, language }: SearchInput) {
    const result = ranked.get(id)!
    const paths = checkedPaths(result.hits)
    return { id, language, paths, verifiedPaths: paths, elapsedMs: result.elapsedMs, invalidInput: result.invalidInput }
  }

  const [repoRevision, repoTree] = execFileSync('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'],
    { cwd: repository, encoding: 'utf8' }).trim().split('\n')
  const require = createRequire(import.meta.url)
  const report = {
    corpusDigest, indexMs, coldFirstMs: cold.elapsedMs, warmMs, warmIds, peakRssKiB: peakRss,
    results: queries.map(query => ({ ...reportRow(query), mode: query.mode })),
    noAnswer: controls.map(reportRow),
    documents: [...evidence.values()],
    metadata: {
      repoRevision, repoTree, limit, hostStartupMs, coldIndexAndSearchMs: indexMs + cold.elapsedMs,
      coldQuery: { id: queries[0]!.id, paths: checkedPaths(cold.hits), invalidInput: cold.invalidInput },
      dshVersion: (JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')) as { version: string }).version,
      nodeVersion: process.version, icuVersion: process.versions.icu,
      platform: process.platform, architecture: process.arch, kernel: release(),
      latencyScope: 'Native authenticated RPC round trip. Initial index via knowledge_status. Cold search follows indexing. Warm samples cycle through corpus queries then controls.',
      rssScope: 'Linux VmHWM of the native DSH Web host after timed RPCs and before source verification.',
    },
  }
  await host.close()
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}, 120_000)
