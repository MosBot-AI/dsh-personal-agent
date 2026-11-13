import assert from 'node:assert/strict'
import { createServer, type RequestListener, type ServerResponse } from 'node:http'
import { rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxPort, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { installBrowserProfile } from './fixtures/installed-browser.js'
import { openWebHost, prepareWebHost } from './fixtures/web-host.js'

const probe = fileURLToPath(new URL('./fixtures/browser-flow-probe.mjs', import.meta.url))
const bundle = fileURLToPath(new URL('../../packages/browser-chrome/', import.meta.url))
const chrome = process.env.DSHPA_TEST_CHROME
const installModes = process.env.DSHPA_TEST_BROWSER_TARBALL === '1' ? ['workspace', 'tarball'] : ['workspace']

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

it.skipIf(!chrome).each(installModes)('routes a verified task through isolated Chrome and blocks a second origin (%s)', async mode => {
  let blockedRequests = 0
  const excluded = await localServer((_request, response) => {
    blockedRequests++
    response.end('Should never reach the excluded origin.')
  })
  let saved = ''
  let hold: ServerResponse | undefined
  const origin = await localServer((request, response) => {
    if (request.url === '/hold') { hold = response; return }
    if (request.method === 'POST' && request.url === '/save') {
      request.setEncoding('utf8')
      request.on('data', text => { saved += text })
      request.on('end', () => response.end('Saved'))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
<title>Scoped browser fixture</title>
<label>Message <input id="message"></label>
<button id="save">Save message</button><p id="status" role="status"></p>
<iframe title="Excluded origin" src="${excluded}/frame"></iframe>
<script>
document.querySelector('#save').onclick = () => {
  document.querySelector('#status').textContent = 'Saved';
  void fetch('/save', { method: 'POST', body: document.querySelector('#message').value });
  void fetch(${JSON.stringify(excluded + '/click')}, { mode: 'no-cors' }).catch(() => {});
};
</script>`)
  })
  const patch = [
    '- id: dshpa-browser-chrome', '  disabled: false', '  config:',
    `    executablePath: ${JSON.stringify(chrome)}`, `    allowedOrigins: [${JSON.stringify(origin)}]`,
    '- id: dshpa', '  config:', '    inbox:', "      storageDirectory: !!js dshHomePath('browser-inbox')",
    '      workRoot: !!js process.cwd()', '      worker:', '        provider: pa031-browser-fixture',
    '        model: browser-worker', '        concurrency: 2', '        unmetered: true',
    '      desktop:', '        browserProfiles:', '          - id: fixture', `            startUrl: ${JSON.stringify(origin + '/')}`,
  ]
  const prepared = mode === 'tarball' ? await installBrowserProfile(probe, patch) : prepareWebHost(probe, patch, [bundle])
  onTestFinished(() => rmSync(prepared.root, { recursive: true, force: true }))
  const host = await openWebHost(probe, { prepared })
  expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'snapshot' })).toMatchObject({ status: 401 })
  const cookie = await host.exchange()
  const inbox: InboxPort = async request => {
    const reply = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, cookie)
    assert.ok(reply.status === 200 && reply.result?.ok, JSON.stringify(reply))
    return reply.result.value
  }
  async function snapshot() {
    const value = await inbox({ type: 'snapshot' })
    assert.ok(value.ok && value.kind === 'snapshot')
    return value.snapshot
  }
  const projectId = updated(await inbox({ type: 'create_project', commandId: 'browser-project',
    title: 'Browser scope', purpose: 'Verify isolated browser work.' })).projectId
  assert.ok(projectId)
  const taskId = updated(await inbox({ type: 'create_task', projectId, commandId: 'browser-task',
    sessionId: 'pa031-browser-primary', outcome: 'Save a message on the isolated test page.' })).taskId
  assert.ok(taskId)
  const initial = await snapshot()
  const target = initial.desktopTargets?.[0]
  const task = initial.tasks.find(row => row.id === taskId)
  assert.ok(target && task)
  expect(target.startUrl).toBe(origin + '/')
  updated(await inbox({ type: 'desktop_start', taskId, expectedVersion: task.version,
    cursor: 'pa031-browser-live', application: target.application }))
  const deadline = performance.now() + 15_000
  let row = task
  while (performance.now() < deadline) {
    row = (await snapshot()).tasks.find(candidate => candidate.id === taskId)!
    if ((row.status === 'verifying' && row.runtime === 'inactive') || row.status === 'waiting_environment') break
    await delay(40)
  }
  expect(row, host.diagnostics()).toMatchObject({ status: 'verifying', runtime: 'inactive' })
  expect(saved).toBe('PA031 verified browser value')
  expect(blockedRequests).toBe(0)
  updated(await inbox({ type: 'accept_result', taskId, expectedVersion: row.version }))
  expect((await snapshot()).tasks.find(candidate => candidate.id === taskId)).toMatchObject({ status: 'completed' })

  async function create(name: string, outcome: string) {
    const result = updated(await inbox({ type: 'create_task', projectId: projectId!, commandId: name,
      sessionId: 'pa031-browser-primary', outcome }))
    assert.ok(result.taskId)
    return result.taskId
  }
  async function read(id: string) {
    const current = (await snapshot()).tasks.find(candidate => candidate.id === id)
    assert.ok(current)
    return current
  }
  const held = await create('browser-hold', `Open ${origin}/hold`)
  const contender = await create('browser-contender', 'Wait for the same browser profile.')
  const launch = async (id: string, cursor: string) => inbox({ type: 'desktop_start', taskId: id,
    expectedVersion: (await read(id)).version, cursor, application: target.application })
  updated(await launch(held, 'pa031-browser-hold'))
  const holdDeadline = performance.now() + 8_000
  while (!hold && performance.now() < holdDeadline) await delay(30)
  assert.ok(hold, host.diagnostics())
  const activity = (await snapshot()).desktopActivities?.find(item => item.taskId === held)
  assert.ok(activity?.inFlight)
  try {
    expect(await launch(contender, 'pa031-browser-contender')).toEqual({ ok: false, code: 'resource_busy' })
    updated(await inbox({ type: 'desktop_takeover', taskId: held, leaseId: activity.leaseId }))
    expect((await snapshot()).desktopActivities).toContainEqual(expect.objectContaining({ taskId: held, phase: 'human' }))
  } finally { hold.end('The test navigation can now drain.') }
  const drainDeadline = performance.now() + 10_000
  let drained = await read(held)
  while (drained.runtime !== 'inactive' && performance.now() < drainDeadline) {
    await delay(30)
    drained = await read(held)
  }
  expect(drained, host.diagnostics()).toMatchObject({ status: 'waiting_environment', runtime: 'inactive',
    wait: { referenceId: 'dshpa-desktop-wait:desktop_taken_over' } })
  updated(await inbox({ type: 'desktop_release', taskId: held, leaseId: activity.leaseId }))
  expect((await snapshot()).desktopActivities).toEqual([])

}, process.env.DSHPA_TEST_BROWSER_TARBALL === '1' ? 240_000 : 55_000)
