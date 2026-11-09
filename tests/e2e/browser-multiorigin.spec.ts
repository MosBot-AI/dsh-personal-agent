import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxPort, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { openWebHost, prepareWebHost } from './fixtures/web-host.js'

const probe = fileURLToPath(new URL('./fixtures/browser-flow-probe.mjs', import.meta.url))
const bundle = fileURLToPath(new URL('../../packages/browser-chrome/', import.meta.url))
const chrome = process.env.DSHPA_TEST_CHROME

async function localServer(listener: RequestListener): Promise<string> {
  const server = createServer(listener)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

function updated(response: InboxResponse) {
  assert.ok(response.ok && response.kind === 'updated', JSON.stringify(response))
  return response
}

it.skipIf(!chrome)('isolates two approved profiles before frames, fetches, popups and redirects', async () => {
  async function site() {
    const state = { other: '', saved: '', foreign: [] as string[] }
    const url = await localServer((request, response) => {
      if (['/frame', '/click', '/popup', '/redirect-target'].includes(request.url ?? '')) {
        state.foreign.push(`${request.method} ${request.url}`)
        response.end('An unrelated task must not reach this path.')
      } else if (request.url === '/redirect') {
        response.writeHead(302, { location: state.other + '/redirect-target' }).end()
      } else if (request.method === 'POST' && request.url === '/save') {
        request.setEncoding('utf8')
        request.on('data', text => { state.saved += text })
        request.on('end', () => response.end('Saved'))
      } else response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
<title>Task origin fixture</title><label>Message <input id="message"></label>
<button id="save">Save message</button><p id="status" role="status"></p>
<iframe title="Other approved profile" src="${state.other}/frame"></iframe>
<script>
document.querySelector('#save').onclick = () => {
  document.querySelector('#status').textContent = 'Saved';
  const value = document.querySelector('#message').value;
  void fetch('/save', { method: 'POST', body: value });
  void fetch(${JSON.stringify(state.other + '/click')}, { mode: 'no-cors', method: 'POST', body: value }).catch(() => {});
  window.open(${JSON.stringify(state.other + '/popup')});
};
</script>`)
    })
    return { url, state }
  }
  const a = await site()
  const b = await site()
  a.state.other = b.url
  b.state.other = a.url
  const prepared = prepareWebHost(probe, [
    '- id: dshpa-browser-chrome', '  disabled: false', '  config:',
    `    executablePath: ${JSON.stringify(chrome)}`, `    allowedOrigins: [${JSON.stringify(a.url)}, ${JSON.stringify(b.url)}]`,
    '- id: dshpa', '  config:', '    inbox:', "      storageDirectory: !!js dshHomePath('browser-inbox')",
    '      workRoot: !!js process.cwd()', '      worker:', '        provider: pa031-browser-fixture',
    '        model: browser-worker', '        concurrency: 2', '        unmetered: true',
    '      desktop:', '        browserProfiles:', '          - id: first', `            startUrl: ${JSON.stringify(a.url + '/')}`,
    '          - id: second', `            startUrl: ${JSON.stringify(b.url + '/')}`,
  ], [bundle])
  onTestFinished(() => rmSync(prepared.root, { recursive: true, force: true }))
  const host = await openWebHost(probe, { prepared })
  const cookie = await host.exchange()
  const inbox: InboxPort = async request => {
    const reply = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, cookie)
    assert.ok(reply.status === 200 && reply.result?.ok, JSON.stringify(reply))
    return reply.result.value
  }
  const snapshot = async () => {
    const result = await inbox({ type: 'snapshot' })
    assert.ok(result.ok && result.kind === 'snapshot')
    return result.snapshot
  }
  const projectId = updated(await inbox({ type: 'create_project', commandId: 'multi-origin-project',
    title: 'Two scoped sites', purpose: 'Keep each task inside its approved origin.' })).projectId
  assert.ok(projectId)
  for (const [index, target] of [a, b, a].entries()) {
    const redirect = index === 2
    const taskId = updated(await inbox({ type: 'create_task', commandId: `multi-origin-${index}`, projectId,
      sessionId: 'pa031-browser-primary', outcome: redirect ? `Open ${target.url}/redirect` : 'Save the approved fixture value.' })).taskId
    assert.ok(taskId)
    const initial = await snapshot()
    const selected = initial.desktopTargets?.find(item => item.startUrl === target.url + '/')
    const task = initial.tasks.find(item => item.id === taskId)
    assert.ok(selected && task)
    updated(await inbox({ type: 'desktop_start', taskId, expectedVersion: task.version, application: selected.application,
      cursor: redirect ? 'pa031-browser-redirect' : index === 0 ? 'pa031-browser-live' : 'pa031-browser-other' }))
    const deadline = performance.now() + 15_000
    let row = task
    while (performance.now() < deadline) {
      row = (await snapshot()).tasks.find(item => item.id === taskId)!
      if ((row.status === 'verifying' || row.status === 'waiting_environment') && row.runtime === 'inactive') break
      await delay(40)
    }
    expect(row, host.diagnostics()).toMatchObject({ status: redirect ? 'waiting_environment' : 'verifying', runtime: 'inactive' })
    if (!redirect) {
      expect(target.state.saved).toBe('PA031 verified browser value')
      updated(await inbox({ type: 'accept_result', taskId, expectedVersion: row.version }))
    }
    expect(a.state.foreign).toEqual([])
    expect(b.state.foreign).toEqual([])
  }
}, 55_000)
