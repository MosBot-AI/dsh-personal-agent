import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxPort, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { openWebHost, prepareWebHost } from './fixtures/web-host.js'

const probe = fileURLToPath(new URL('./fixtures/cross-pr-flow-probe.mjs', import.meta.url))
const bundle = fileURLToPath(new URL('../../packages/browser-chrome/', import.meta.url))
const chrome = process.env.DSHPA_TEST_CHROME
const updated = (value: InboxResponse) => {
  assert.ok(value.ok && value.kind === 'updated', JSON.stringify(value))
  return value
}

it.skipIf(!chrome)('accepts exact draft and leased browser results in one host without crossing task authority', async () => {
  let saved = ''
  let held: ServerResponse | undefined
  const server = createServer((request, response) => {
    if (request.url === '/save' && request.method === 'POST') {
      request.setEncoding('utf8')
      request.on('data', value => { saved += value })
      request.on('end', () => response.end('Saved'))
    } else if (request.url === '/') {
      held = response
    } else response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    held?.end()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const prepared = prepareWebHost(probe, ['- id: dshpa-browser-chrome', '  disabled: false', '  config:',
    `    executablePath: ${JSON.stringify(chrome)}`, `    allowedOrigins: [${JSON.stringify(origin)}]`], [bundle])
  onTestFinished(() => rmSync(prepared.root, { recursive: true, force: true }))
  const host = await openWebHost(probe, { prepared })
  const cookie = await host.exchange()
  const inbox: InboxPort = async request => {
    const response = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, cookie)
    assert.ok(response.status === 200 && response.result?.ok, JSON.stringify(response))
    return response.result.value
  }
  const snapshot = async () => {
    const result = await inbox({ type: 'snapshot' })
    assert.ok(result.ok && result.kind === 'snapshot')
    return result.snapshot
  }
  const task = async (id: string) => {
    const current = (await snapshot()).tasks.find(row => row.id === id)
    assert.ok(current)
    return current
  }
  const create = async (commandId: string) => {
    const id = updated(await inbox({ type: 'create_task', commandId, projectId: 'draft-fixture-project',
      sessionId: 'draft-fixture-session', outcome: 'Verify one exact accepted result.' })).taskId
    assert.ok(id)
    return id
  }
  const draftId = await create('cross-draft')
  const browserId = await create('cross-browser')
  const draft = await inbox({ type: 'github_draft_prepare', taskId: draftId, expectedVersion: (await task(draftId)).version,
    commandId: 'cross-prepare', draft: { title: 'Exact fixture draft', body: 'Verify scoped readback.', content: '# Exact fixture\n' } })
  assert.ok(draft.ok && draft.kind === 'github_draft' && draft.draft)
  const target = (await snapshot()).desktopTargets?.find(row => row.startUrl === origin + '/')
  assert.ok(target)
  expect(await inbox({ type: 'desktop_start', taskId: draftId, expectedVersion: (await task(draftId)).version,
    cursor: 'cross-denied-desktop', application: target.application })).toEqual({ ok: false, code: 'permission_denied' })
  const launching = inbox({ type: 'desktop_start', taskId: browserId, expectedVersion: (await task(browserId)).version,
    cursor: 'pa031-browser-live', application: target.application })
  // Keep the browser's native readiness probe in flight while the same host
  // approves, publishes and accepts the separate owner action.
  void launching.catch(() => undefined)
  const page = await vi.waitFor(() => { assert.ok(held); return held }, { timeout: 6500 })
  try {
    expect(await inbox({ type: 'github_draft_prepare', taskId: browserId, expectedVersion: (await task(browserId)).version,
      commandId: 'cross-denied-draft', draft: { title: 'Denied', body: 'Must not replace browser work.', content: 'Denied' } }))
      .toEqual({ ok: false, code: 'version_conflict' })
    const approval = (await snapshot()).approvals.find(row => row.taskId === draftId)
    assert.ok(approval)
    updated(await inbox({ type: 'approval', requestId: approval.id, expectedVersion: approval.version,
      digest: approval.digest, decision: 'approve' }))
    expect(await inbox({ type: 'github_draft_dispatch', taskId: draftId, operationId: draft.draft.payload.operationId,
      expectedVersion: (await task(draftId)).version })).toMatchObject({ ok: true })
    const ready = await vi.waitFor(async () => {
      const row = await task(draftId)
      expect(row.status).toBe('verifying')
      return row
    }, { timeout: 4000 })
    updated(await inbox({ type: 'accept_result', taskId: draftId, expectedVersion: ready.version }))
    expect((await task(draftId)).status).toBe('completed')
  } finally {
    page.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Cross-PR fixture</title>
<label>Message <input id="message"></label><button id="save">Save message</button><p id="status"></p>
<script>document.querySelector('#save').onclick = () => {
 document.querySelector('#status').textContent = 'Saved';
 void fetch('/save', { method: 'POST', body: document.querySelector('#message').value });
};</script>`)
  }
  updated(await launching)
  const browserReady = await vi.waitFor(async () => {
    const row = await task(browserId)
    expect(row).toMatchObject({ status: 'verifying', runtime: 'inactive' })
    return row
  }, { timeout: 10_000 })
  expect(saved).toBe('PA031 verified browser value')
  updated(await inbox({ type: 'accept_result', taskId: browserId, expectedVersion: browserReady.version }))
  expect((await task(browserId)).status).toBe('completed')
  expect(await inbox({ type: 'github_draft_inspect', taskId: draftId })).toMatchObject({ draft: {
    effect: 'confirmed', receipt: 'https://github.com/TestOrg/DedicatedTest/pull/9',
  } })
}, 35_000)
