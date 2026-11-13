import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it, onTestFinished } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { openWebHost, prepareWebHost } from './fixtures/web-host.js'

interface Query {
  id: string
  language: 'en' | 'zh' | 'mixed'
  mode: 'keyword' | 'navigation' | 'natural'
  query: string
  relevant: { path: string; anchor: string }[]
}

interface Corpus {
  rubric: Record<string, string>
  documents: Record<string, string>
  queries: Query[]
  negativeControls: Pick<Query, 'language' | 'query'>[]
}

interface ScoredQuery extends Pick<Query, 'id' | 'language' | 'mode'> {
  hits: { path: string; verified: boolean; relevant: boolean }[]
  invalidInput: boolean
}

const corpora = [
  { name: 'original', digest: '8056a9bd95c607b6a654c745d58238db07a5dad1dda836f5c903cf25b64908e5' },
  { name: 'keyword-navigation', digest: 'ab2aa823a81dc7ee986f0b4f200861eeacc957354f82bc9d52b5180f8af0a8f2' },
  { name: 'natural', digest: '9ab183fd0c49b7787d79e43547e28a7bdd2a63e0fd2d9649862fea42cb4d856e' },
  { name: 'final-natural', digest: '0ef54d26764807f0577a83f549a3e3e84819011d7b1de180bbd786de1e317bcd' },
]
const reportDirectory = process.env.DSHPA_KNOWLEDGE_RETRIEVAL_REPORT_DIR
const repository = fileURLToPath(new URL('../../', import.meta.url))
const probe = fileURLToPath(new URL('./fixtures/memory-flow-probe.mjs', import.meta.url))
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const rootId = 'release-corpus'

function summarize(rows: readonly ScoredQuery[]) {
  const hitAt1 = rows.filter(row => row.hits[0]?.relevant).length
  const hitAt3 = rows.filter(row => row.hits.some(hit => hit.relevant)).length
  const hits = rows.flatMap(row => row.hits)
  return {
    queries: rows.length, hitAt1, hitAt3,
    hitAt1Rate: hitAt1 / rows.length, hitAt3Rate: hitAt3 / rows.length,
    noResults: rows.filter(row => !row.invalidInput && row.hits.length === 0).length,
    invalidInput: rows.filter(row => row.invalidInput).length,
    sourceReadbacks: hits.length, verifiedSources: hits.filter(hit => hit.verified).length,
    missesAt1: rows.filter(row => !row.hits[0]?.relevant).map(row => row.id),
    missesAt3: rows.filter(row => !row.hits.some(hit => hit.relevant)).map(row => row.id),
  }
}

function groupBy(rows: readonly ScoredQuery[], group: (row: ScoredQuery) => string) {
  const groups = Map.groupBy(rows, group)
  return Object.fromEntries([...groups].map(([key, groupRows]) => [key, summarize(groupRows)]))
}

it.skipIf(!reportDirectory).each(corpora)('benchmarks the frozen $name knowledge corpus over native Web', async ({ name, digest }) => {
  assert.ok(reportDirectory && isAbsolute(reportDirectory), 'Supply an absolute benchmark report directory')
  const bytes = readFileSync(new URL(`./fixtures/knowledge-retrieval/${name}.json`, import.meta.url))
  assert.equal(sha256(bytes), digest)
  const { rubric, documents, queries, negativeControls } = JSON.parse(bytes.toString('utf8')) as Corpus
  for (const query of queries) {
    assert.ok(query.relevant.length && query.relevant.every(answer => documents[answer.path]?.includes(answer.anchor)), query.id)
  }

  const prepared = prepareWebHost(probe, [
    '- id: dshpa', '  config:', '    inbox:',
    "      storageDirectory: !!js dshHomePath('knowledge-inbox')", '      workRoot: !!js process.cwd()',
    '      knowledge:', '        roots:', `          - id: ${rootId}`,
    `            directory: !!js process.cwd() + '/${rootId}'`, '            include: ["**/*.md"]',
  ])
  onTestFinished(() => rmSync(prepared.root, { recursive: true, force: true }))
  const directory = join(prepared.root, rootId)
  for (const [path, document] of Object.entries(documents)) {
    assert.ok(!posix.isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), path)
    const destination = join(directory, path)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    writeFileSync(destination, document, { mode: 0o600 })
  }

  const host = await openWebHost(probe, { prepared })
  const cookie = await host.exchange()
  const operator = await host.exchange(true)
  const sample = { type: 'knowledge_search', query: queries[0]!.query, rootId, limit: 3 }
  assert.equal((await host.rpc(INBOX_RPC_ENDPOINT, sample)).status, 401)
  assert.equal((await host.rpc(INBOX_RPC_ENDPOINT, sample, operator)).status, 403)

  async function inbox(request: unknown) {
    const response = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, cookie)
    assert.ok(response.status === 200 && response.result?.ok, host.diagnostics())
    return response.result.value
  }

  async function search(query: string, relevant: Query['relevant'] = []) {
    const result = await inbox({ ...sample, query })
    if (!result.ok && result.code === 'invalid_input') return { invalidInput: true, hits: [] }
    assert.ok(result.ok && result.kind === 'knowledge_search', JSON.stringify(result))
    assert.deepEqual(result.roots, [{ id: rootId, status: 'available', files: Object.keys(documents).length }])
    const hits = []
    for (const hit of result.hits) {
      const page = await inbox({ type: 'knowledge_read', ref: hit.ref, revision: hit.revision, maxBytes: 4096 })
      const expected = documents[hit.path]
      const verified = expected !== undefined && page.ok && page.kind === 'knowledge_page'
        && page.source.path === hit.path && page.source.ref.id === hit.ref.id
        && page.source.ref.rootId === rootId && hit.ref.rootId === rootId
        && page.source.revision === hit.revision && hit.revision === sha256(expected)
        && page.text === expected && page.nextOffset === undefined && page.totalBytes === Buffer.byteLength(expected)
      hits.push({ path: hit.path, verified, relevant: verified && relevant.some(answer =>
        answer.path === hit.path && expected.includes(answer.anchor)) })
    }
    return { invalidInput: false, hits }
  }

  const results: ScoredQuery[] = []
  for (const { id, language, mode, query, relevant } of queries) {
    results.push({ id, language, mode, ...await search(query, relevant) })
  }
  const noAnswer = []
  for (const [index, control] of negativeControls.entries()) {
    noAnswer.push({ id: `no-answer-${index + 1}`, language: control.language, ...await search(control.query) })
  }
  const invalidInputs = []
  for (const [id, query] of [['empty', ''], ['over-limit', 'x'.repeat(257)]] as const) {
    invalidInputs.push({ id, ...await search(query) })
  }

  const require = createRequire(import.meta.url)
  const summary = summarize(results)
  const [repoRevision, repoTree] = execFileSync('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'],
    { cwd: repository, encoding: 'utf8' }).trim().split('\n')
  const sourceChanges = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'packages'],
    { cwd: repository, encoding: 'utf8' }).trim().length > 0
  const report = {
    corpus: name, corpusDigest: digest, rubric,
    repoRevision, repoTree, sourceChanges,
    dshVersion: (JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')) as { version: string }).version,
    nodeVersion: process.version, icuVersion: process.versions.icu,
    documents: Object.keys(documents).length, summary,
    byLanguage: groupBy(results, row => row.language),
    byMode: groupBy(results, row => row.mode),
    byLanguageAndMode: groupBy(results, row => `${row.language}:${row.mode}`),
    noAnswer: {
      queries: noAnswer.length,
      empty: noAnswer.filter(row => !row.invalidInput && row.hits.length === 0).length,
      invalidInput: noAnswer.filter(row => row.invalidInput).length,
      returnedHits: noAnswer.filter(row => row.hits.length > 0).length,
      results: noAnswer,
    },
    invalidInputs: { expected: invalidInputs.length, rejected: invalidInputs.filter(row => row.invalidInput).length },
    results,
  }
  mkdirSync(reportDirectory, { recursive: true, mode: 0o700 })
  writeFileSync(join(reportDirectory, `${name}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(`${name}: hit@1 ${summary.hitAt1}/${summary.queries}, hit@3 ${summary.hitAt3}/${summary.queries}; ` +
    `no-answer results ${report.noAnswer.returnedHits}/${report.noAnswer.queries}; invalid positives ${summary.invalidInput}`)

  assert.deepEqual([...results, ...noAnswer, ...invalidInputs].flatMap(row => row.hits.filter(hit => !hit.verified)), [])
  assert.equal(report.invalidInputs.rejected, report.invalidInputs.expected)
  assert.equal(report.noAnswer.empty, report.noAnswer.queries)
  if (name === 'keyword-navigation') assert.deepEqual(summary.missesAt1, [])
  if (name === 'original') {
    const earlierMisses = new Set(['en-03', 'zh-13', 'zh-19'])
    assert.deepEqual(results.filter(row => row.mode === 'keyword' && !row.hits[0]?.relevant && !earlierMisses.has(row.id)), [])
    assert.ok(results.filter(row => row.mode === 'keyword').every(row => row.hits.some(hit => hit.relevant)))
  }
}, 120_000)
