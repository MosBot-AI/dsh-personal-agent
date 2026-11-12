import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, onTestFinished, vi } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxRequest, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { RESIDENT_OWNER_FILE } from '../../packages/personal-agent/src/runtime/resident-web.js'

const run = promisify(execFile)
const dsh = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
const workspace = fileURLToPath(new URL('../../', import.meta.url))
const profileName = 'dshpa-package-install'

function installDiagnostics(profile: string, error: unknown): string {
  const output: unknown[] = []
  if (error instanceof Error) {
    if ('stdout' in error) output.push(error.stdout)
    if ('stderr' in error) output.push(error.stderr)
  }
  const logs = join(profile, '.plugin-manager', 'logs')
  if (existsSync(logs)) {
    const operation = readdirSync(logs, { withFileTypes: true }).find(entry => entry.isDirectory() && entry.name.startsWith('operation-'))
    if (operation) {
      const log = join(logs, operation.name, 'pnpm.log')
      if (existsSync(log)) output.push(readFileSync(log, 'utf8'))
    }
  }
  return output.filter(text => typeof text === 'string').join('\n').split(/\r?\n/u)
    .filter(line => /ERR_PNPM_|\bError:|\[ELIFECYCLE\]/u.test(line))
    .slice(-6).join('\n')
    .replace(/https?:\/\/\S+/gu, '[registry URL]')
    .replace(/\b((?:proxy-)?authorization|_authToken|password|token)\b.*$/gimu, '$1 [redacted]')
    .slice(0, 2_000)
}

it('runs an owner-started native Worker from a fresh DSH tarball install', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshpa-package-install-')))
  const dshHome = join(root, 'home')
  const profile = join(dshHome, 'profiles', profileName)
  const archives = join(root, 'archives')
  const storage = join(dshHome, 'state')
  const workRoot = join(root, 'work')
  const patch = join(root, 'resident.yml')
  const ownerPath = join(storage, RESIDENT_OWNER_FILE)
  const systemEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
  const installEnv = {
    ...systemEnv, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1',
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    PNPM_CONFIG_OFFLINE: process.env.PNPM_CONFIG_OFFLINE,
    PNPM_CONFIG_REGISTRY: process.env.PNPM_CONFIG_REGISTRY,
    PNPM_CONFIG_STORE_DIR: process.env.PNPM_CONFIG_STORE_DIR,
    npm_config_userconfig: process.env.npm_config_userconfig,
  }
  const requests: Array<string | undefined> = []
  const provider = createServer((request, response) => {
    requests.push(request.method)
    request.resume()
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: {
      type: 'invalid_request_error', message: 'Synthetic request-specific rejection',
    } }))
  })
  let resident: ChildProcess | undefined
  onTestFinished(async () => {
    try {
      if (resident?.pid && resident.exitCode === null && resident.signalCode === null) {
        const exited = once(resident, 'exit', { signal: AbortSignal.timeout(5_000) })
        resident.kill('SIGKILL')
        await exited
      }
    } finally {
      try {
        if (provider.listening) {
          provider.closeAllConnections()
          await new Promise<void>(resolve => provider.close(() => resolve()))
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  mkdirSync(archives)
  mkdirSync(workRoot)
  async function pack(directory: string) {
    const cwd = join(workspace, 'packages', directory)
    const { name, version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name: string; version: string }
    await run('pnpm', ['pack', '--pack-destination', archives], { cwd, env: installEnv, timeout: 15_000 })
    return { name, spec: 'file:' + join(archives, `${name.slice(1).replace('/', '-')}-${version}.tgz`) }
  }
  const bundle = await pack('personal-agent')
  const pluginApi = await pack('plugin-api')
  const routing = await pack('model-routing')
  await run(process.execPath, [dsh, '--profile', profileName, '--from-default-profile', 'web', '--dump-config'], {
    cwd: root, env: installEnv, timeout: 20_000,
  })
  const settings = join(profile, 'pnpm-workspace.yaml')
  const defaults = readFileSync(settings, 'utf8')
  expect(defaults).toMatch(/^nodeLinker: hoisted$/m)
  expect(defaults).toMatch(/^autoInstallPeers: false$/m)
  // Resolve the two unpublished workspace dependencies from their tarballs.
  // Preserve DSH's generated settings so it can supply its own native peers.
  appendFileSync(settings, `
overrides:
  ${JSON.stringify(pluginApi.name)}: ${JSON.stringify(pluginApi.spec)}
  ${JSON.stringify(routing.name)}: ${JSON.stringify(routing.spec)}
allowBuilds:
  koffi: true
`)
  try {
    await run(process.execPath, [dsh, 'plugin', '--profile', profileName, 'add', bundle.spec], {
      cwd: root, env: installEnv, timeout: 80_000,
    })
  } catch (error) {
    const details = installDiagnostics(profile, error)
    throw new Error(details ? `DSH tarball installation failed\n${details}` : 'DSH tarball installation failed without pnpm diagnostics')
  }
  expect(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')).toMatch(/^  autoInstallPeers: false$/m)
  const modules = join(profile, 'node_modules')
  const installedRequire = createRequire(join(modules, bundle.name, 'package.json'))
  for (const { name } of [bundle, pluginApi, routing]) {
    expect(realpathSync(installedRequire.resolve(`${name}/package.json`))).toBe(join(modules, name, 'package.json'))
  }
  expect(existsSync(join(modules, '@deepseek-ai/dsh-llm'))).toBe(false)

  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const address = provider.address()
  assert.ok(address && typeof address !== 'string')
  writeFileSync(patch, `- id: llm-deepseek
  config:
    baseURL: http://127.0.0.1:${address.port}
    apiKeyEnv: DSHPA_INSTALL_TEST_KEY
    reasoningEffort: 'off'
    maxTokens: 64
- id: llm-deepseek-account
  disabled: true
- id: llm-retry
  disabled: true
- id: session-title-llm
  disabled: true
- id: dshpa
  config:
    inbox:
      storageDirectory: ${JSON.stringify(storage)}
      workRoot: ${JSON.stringify(workRoot)}
      resident: {}
      worker:
        provider: deepseek-official
        model: deepseek-flash
        concurrency: 1
      computeLimits:
        maxInputBytes: 8192
        maxOutputTokens: 64
        maxTurns: 1
        maxStepsPerTurn: 1
        maxWallTimeMs: 10000
      budget:
        pricingVersion: packaged-install-fixture
        routes:
          - provider: deepseek-official
            model: deepseek-flash
            currency: USD
            pricing:
              kind: known
              inputMicrosPerMillion: 300000
              outputMicrosPerMillion: 1200000
              cacheReadMicrosPerMillion: 6000
              cacheWriteMicrosPerMillion: 300000
              ceilingMicros: 10000
        limits:
          - currency: USD
            ownerDayMicros: 10000
            taskMicros: 10000
            maxCallsPerDay: 1
            maxCallsPerTask: 1
            maxConcurrent: 1
`, { mode: 0o600 })
  const child = spawn('/bin/sh', [join(workspace, 'deploy/run-resident.sh'), process.execPath, dshHome, profileName, patch, '0'], {
    cwd: root, env: { ...systemEnv, DSHPA_INSTALL_TEST_KEY: 'sk-dummy-only-for-loopback' }, stdio: 'ignore',
  })
  resident = child
  const exited = once(child, 'exit')
  void exited.catch(() => {})
  const ownerUrl = await vi.waitFor(() => {
    expect([child.exitCode, child.signalCode]).toEqual([null, null])
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid: number; url: string }
    expect(owner.pid).toBe(child.pid)
    return new URL(owner.url)
  }, { timeout: 20_000 })
  expect(ownerUrl.protocol).toBe('http:')
  expect(ownerUrl.hostname).toBe('127.0.0.1')
  const loopback = { connection: 'close' }
  await vi.waitFor(async () => {
    const response = await fetch(new URL('/dshpa/ready', ownerUrl), { headers: loopback, signal: AbortSignal.timeout(3_000) })
    expect(await response.json()).toMatchObject({ ready: true })
    expect(response.status).toBe(200)
  }, { timeout: 8_000 })

  const auth = await fetch(ownerUrl, { headers: loopback, redirect: 'manual', signal: AbortSignal.timeout(5_000) })
    .catch(() => { throw new Error('The native Web owner sign-in failed') })
  const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
  await auth.body?.cancel()
  expect(auth.status).toBe(303)
  assert.ok(cookie)

  function rpcRequest(method: string, payload: unknown, rpcId: string, authCookie?: string) {
    return fetch(new URL(`/api/${method}`, ownerUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { ...loopback, 'content-type': 'application/json', ...(authCookie === undefined ? {} : { cookie: authCookie }) },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
  }
  const unauthorized = await rpcRequest(INBOX_RPC_ENDPOINT, { type: 'snapshot' }, randomUUID())
  expect(unauthorized.status).toBe(401)
  await unauthorized.body?.cancel()
  async function rpc<T>(method: string, payload: unknown): Promise<T> {
    const rpcId = randomUUID()
    const response = await rpcRequest(method, payload, rpcId, cookie)
    expect(response.status).toBe(200)
    const body = await response.json() as { rpcId: string; result: { ok: boolean; value: T } }
    expect(body.rpcId).toBe(rpcId)
    assert.ok(body.result.ok)
    return body.result.value
  }
  const inbox = (request: InboxRequest) => rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request)
  const { sessionId } = await rpc<{ sessionId: string }>('session/create', { args: { request: { cwd: workRoot } } })
  assert.ok(sessionId)
  const project = await inbox({ type: 'create_project', commandId: 'package-project',
    title: 'Installed Worker test', purpose: 'Exercise the native provider from the installed bundle.' })
  assert.ok(project.ok && project.kind === 'updated' && project.projectId)
  const created = await inbox({ type: 'create_task', commandId: 'package-task', sessionId, projectId: project.projectId,
    outcome: 'Prepare an outline of the synthetic packaging test.' })
  assert.ok(created.ok && created.kind === 'updated' && created.taskId)
  const taskId = created.taskId
  async function task() {
    const response = await inbox({ type: 'snapshot' })
    assert.ok(response.ok && response.kind === 'snapshot')
    const item = response.snapshot.tasks.find(row => row.id === taskId)
    assert.ok(item)
    return item
  }
  const queued = await task()
  expect(queued.status).toBe('queued')
  expect(await inbox({ type: 'start', taskId: queued.id, expectedVersion: queued.version, cursor: 'package-start' }))
    .toMatchObject({ ok: true })
  const parked = await vi.waitFor(async () => {
    const item = await task()
    expect(item).toMatchObject({ status: 'waiting_resource', runtime: 'inactive' })
    return item
  }, { timeout: 12_000 })
  expect(parked.wait?.referenceId).toBe('dshpa:compute:provider_rejected')
  expect(parked.artifacts).toEqual([])
  expect(requests).toEqual(['POST'])

  child.kill('SIGTERM')
  const cleanExit = await Promise.race([
    exited,
    delay(8_000, undefined, { ref: false }).then(() => { throw new Error('The native resident process did not stop') }),
  ])
  expect(cleanExit).toEqual([0, null])
  expect(existsSync(ownerPath)).toBe(false)
}, 170_000)
