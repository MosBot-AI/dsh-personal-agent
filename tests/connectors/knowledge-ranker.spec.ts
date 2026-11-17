import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { it, expect, onTestFinished } from 'vitest'
import { createSocketKnowledgeRanker } from '../../packages/personal-agent/src/connectors/knowledge-ranker.js'

const document = { ref: { id: 'a'.repeat(64), rootId: 'notes' }, path: 'topic.md', revision: 'b'.repeat(64), text: '说明' }
const search = { query: 'What is in the notes?', rootId: 'notes', documents: [document], lexicalIds: [document.ref.id], limit: 1 }
const match = { id: document.ref.id, revision: document.revision, offset: 0, length: 6 }

async function serve(handler: (response: ServerResponse, body: unknown) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-ranker-'))
  const socket = join(directory, 'rank.sock')
  const server = createServer((request, response) => {
    assert.equal(request.url, '/rank')
    assert.equal(request.method, 'POST')
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => handler(response, JSON.parse(Buffer.concat(chunks).toString('utf-8'))))
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  server.listen(socket)
  await once(server, 'listening')
  chmodSync(socket, 0o600)
  return { socket, ranker: createSocketKnowledgeRanker(socket) }
}

it('sends exact scoped bytes and reads revision-bound byte offsets', async () => {
  const { ranker } = await serve((response, body) => {
    expect(body).toEqual({ root: 'notes', query: search.query, lexical: [document.ref.id], limit: 1,
      documents: [{ id: document.ref.id, rootId: 'notes', path: document.path, revision: document.revision, text: document.text }] })
    response.end(JSON.stringify([match]))
  })
  expect(await ranker(search)).toEqual([match])
})

it('refuses a shared socket or an oversized request before dispatch', async () => {
  const { ranker, socket } = await serve(() => assert.fail('the ranker should not receive this input'))
  await expect(ranker({ ...search, documents: [{ ...document, text: 'a'.repeat(512 * 1024 + 1) }] }))
    .rejects.toThrow('exceed the local ranker request limit')
  chmodSync(socket, 0o666)
  await expect(ranker(search)).rejects.toThrow('requires a private Unix socket')
  chmodSync(socket, 0o600)
  chmodSync(dirname(socket), 0o770)
  await expect(ranker(search)).rejects.toThrow('unsafe parent directory')
})

it.each([
  ['oversized reply', 'x'.repeat(8193)],
  ['unknown source', JSON.stringify([{ ...match, id: 'c'.repeat(64) }])],
  ['repeated source', JSON.stringify([match, match])],
  ['non-UTF-8 reply', Buffer.from([0xff])],
])('rejects a %s', async (_name, body) => {
  const { ranker } = await serve(response => response.end(body))
  const second = { ...document, ref: { ...document.ref, id: 'd'.repeat(64) } }
  await expect(ranker({ ...search, documents: [document, second], limit: 2 })).rejects.toThrow()
})

it('aborts an in-flight response when the caller disconnects', async () => {
  const arrived = Promise.withResolvers<void>()
  const controller = new AbortController()
  const { ranker } = await serve(() => arrived.resolve())
  const pending = ranker(search, controller.signal)
  await arrived.promise
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
})
