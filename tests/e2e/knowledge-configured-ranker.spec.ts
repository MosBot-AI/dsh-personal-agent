import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { openWebHost, prepareWebHost } from './fixtures/web-host.js'

const probe = fileURLToPath(new URL('./fixtures/memory-flow-probe.mjs', import.meta.url))
const socket = process.env.DSHPA_KNOWLEDGE_RANKER_SOCKET
const supported = ['darwin', 'linux'].includes(process.platform) && ['arm64', 'x64'].includes(process.arch)
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function frozenSource(name: string, sha256: string, control: number, path: string) {
  const bytes = readFileSync(new URL(`./fixtures/knowledge-retrieval/${name}.json`, import.meta.url))
  assert.equal(digest(bytes), sha256)
  const fixture = JSON.parse(bytes.toString('utf8')) as {
    negativeControls: { query: string }[]
    documents: Record<string, string>
  }
  const query = fixture.negativeControls[control - 1]?.query
  const text = fixture.documents[path]
  assert.ok(query && text)
  return { query, text }
}

async function openKnowledge(socketPath: string, roots: Record<string, string>) {
  const prepared = prepareWebHost(probe, [
    '- id: dshpa', '  config:', '    inbox:',
    "      storageDirectory: !!js dshHomePath('knowledge-inbox')", '      workRoot: !!js process.cwd()',
    '      knowledge:', '        semanticRanker:', `          socketPath: ${JSON.stringify(socketPath)}`,
    '        roots:', ...Object.keys(roots).flatMap(id => [
      `          - id: ${id}`, `            directory: !!js process.cwd() + '/${id}'`,
    ]),
  ])
  onTestFinished(() => rmSync(prepared.root, { recursive: true, force: true }))
  for (const [id, text] of Object.entries(roots)) {
    const directory = join(prepared.root, id)
    mkdirSync(directory, { mode: 0o700 })
    writeFileSync(join(directory, 'note.md'), text, { mode: 0o600 })
  }
  const host = await openWebHost(probe, { prepared, rpcTimeoutMs: socket ? 120_000 : undefined })
  const owner = await host.exchange()
  return {
    ...host,
    setSource: (id: string, text: string) => writeFileSync(join(prepared.root, id, 'note.md'), text),
    async inbox(request: unknown) {
      const response = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, owner)
      assert.ok(response.status === 200 && response.result?.ok, host.diagnostics())
      return response.result.value
    },
  }
}

it.skipIf(!supported)('preserves filename lookup when the configured semantic provider is unavailable', async () => {
  const missingSocket = fileURLToPath(new URL('./fixtures/absent-ranker.sock', import.meta.url))
  const host = await openKnowledge(missingSocket, { notes: '# Local notes\n\nFor access contact the night desk.\n' })
  expect(await host.inbox({ type: 'knowledge_search', query: 'Which team maintains the night desk?', limit: 1 }))
    .toEqual({ ok: false, code: 'host_unavailable' })
  expect(await host.inbox({ type: 'knowledge_search', query: 'note.md', limit: 1 }))
    .toMatchObject({ ok: true, kind: 'knowledge_search', hits: [{ path: 'note.md', ref: { rootId: 'notes' } }] })
}, 25_000)

it.skipIf(!supported || !socket)('rechecks actual manufacturing passages using the configured ranker on native Web', async () => {
  assert.ok(socket)
  const binoculars = frozenSource('natural', '9ab183fd0c49b7787d79e43547e28a7bdd2a63e0fd2d9649862fea42cb4d856e',
    2, 'learning-room/observatory-desk.md')
  const badge = frozenSource('final-natural', '0ef54d26764807f0577a83f549a3e3e84819011d7b1de180bbd786de1e317bcd',
    7, 'community-notes/echo-room.md')
  const optics = 'North Ridge Optics'
  const studio = '示例印刷室'
  const roots = {
    'maker-missing': binoculars.text,
    'maker-known': `${binoculars.text}\n${optics} made and supplied the handheld binoculars for the lunar evening.\n`,
    'printer-missing': badge.text,
    'printer-known': `${badge.text}\nEcho Room 的临时 visitor badge 由${studio}印制。\n`,
  }
  const host = await openKnowledge(socket, roots)
  const search = (query: string, rootId?: string) => ({ type: 'knowledge_search', query, rootId, limit: 1 })
  const request = search(binoculars.query, 'maker-missing')
  expect((await host.rpc(INBOX_RPC_ENDPOINT, request)).status).toBe(401)
  expect((await host.rpc(INBOX_RPC_ENDPOINT, request, await host.exchange(true))).status).toBe(403)
  expect(await host.inbox(search(binoculars.query, 'unconfigured')))
    .toEqual({ ok: false, code: 'not_found' })
  expect(await host.inbox(request)).toMatchObject({ ok: true, kind: 'knowledge_search', hits: [] })
  expect(await host.inbox(search(badge.query, 'printer-missing')))
    .toMatchObject({ ok: true, kind: 'knowledge_search', hits: [] })

  async function readEvidence(query: string, rootId: keyof typeof roots, marker: string, scoped: boolean) {
    const result = await host.inbox(search(query, scoped ? rootId : undefined))
    assert.ok(result.ok && result.kind === 'knowledge_search', JSON.stringify(result))
    expect(result.hits).toHaveLength(1)
    const hit = result.hits[0]!
    const text = roots[rootId]
    expect(hit.ref.rootId).toBe(rootId)
    expect(hit.snippet).toContain(marker)
    expect(text).toContain(hit.snippet)
    expect(hit.revision).toBe(digest(text))
    expect(await host.inbox({ type: 'knowledge_read', ref: hit.ref, revision: hit.revision, maxBytes: 4096 }))
      .toMatchObject({ kind: 'knowledge_page', text, totalBytes: Buffer.byteLength(text),
        source: { path: 'note.md', ref: hit.ref, revision: hit.revision } })
    return hit
  }

  const hit = await readEvidence(binoculars.query, 'maker-known', optics, true)
  await readEvidence(badge.query, 'printer-known', studio, false)
  host.setSource('maker-known', 'A revision saved after the original search.')
  expect(await host.inbox({ type: 'knowledge_read', ref: hit.ref, revision: hit.revision }))
    .toEqual({ ok: false, code: 'stale_source' })
}, 510_000)
