import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, onTestFinished, vi } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxRequest, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { RESIDENT_OWNER_FILE } from '../../packages/personal-agent/src/runtime/resident-web.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { restoreWorkStoreBackup } from '../../packages/personal-agent/src/storage/restore.js'
import { SCHEMA_VERSION, V15_BACKUP_SUFFIX } from '../../packages/personal-agent/src/storage/schema.js'

const run = promisify(execFile)
const dsh = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
const workspace = fileURLToPath(new URL('../../', import.meta.url))
const profileName = 'dshpa-package-install'
const previousCheckout = process.env.DSHPA_INSTALL_UPGRADE_FROM
const archiveDirectory = process.env.DSHPA_INSTALL_ARCHIVES
const liveProvider = process.env.DSHPA_INSTALL_LIVE_DEEPSEEK === '1'
const liveKey = liveProvider ? process.env.DEEPSEEK_API_KEY?.trim() : undefined
if (previousCheckout !== undefined && !isAbsolute(previousCheckout)) {
  throw new Error('DSHPA_INSTALL_UPGRADE_FROM requires an absolute path to a built schema-15 checkout')
}
if (archiveDirectory !== undefined && (!isAbsolute(archiveDirectory) || previousCheckout !== undefined)) {
  throw new Error('DSHPA_INSTALL_ARCHIVES requires an absolute path and cannot be combined with DSHPA_INSTALL_UPGRADE_FROM')
}
if (liveProvider && (!liveKey || previousCheckout)) {
  throw new Error('Live DeepSeek requires DEEPSEEK_API_KEY and the current package')
}

function packageArchive(directory: string, checkout: string, destination: string) {
  const cwd = join(checkout, 'packages', directory)
  const { name, version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name: string; version: string }
  const path = join(destination, `${name.slice(1).replace('/', '-')}-${version}.tgz`)
  return { cwd, name, path, spec: 'file:' + path }
}

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

it(liveProvider ? 'runs a native Worker with live DeepSeek and retains the accepted result'
  : previousCheckout
  ? 'upgrades and restores work from an installed schema-15 package'
  : 'runs a native Worker from a fresh tarball install and retains its task across plugin removal', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshpa-package-install-')))
  const dshHome = join(root, 'home')
  const profile = join(dshHome, 'profiles', profileName)
  const archives = join(root, 'archives')
  const storage = join(dshHome, 'state')
  const workRoot = join(root, 'work')
  const patch = join(root, 'resident.yml')
  const systemEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
  const installEnv = {
    ...systemEnv, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1',
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || join(root, 'cache'),
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
  const workFile = join(workRoot, 'owner-notes.md')
  const workContents = '# Owner notes\n\nKeep this file when removing the plugin.\n'
  writeFileSync(workFile, workContents, { mode: 0o600 })
  async function archivesFor(checkout: string, destination: string, packed: boolean) {
    const packages = [
      packageArchive('personal-agent', checkout, destination),
      packageArchive('plugin-api', checkout, destination),
      packageArchive('model-routing', checkout, destination),
    ] as const
    if (!packed) mkdirSync(destination, { recursive: true })
    for (const archive of packages) {
      if (!packed) {
        await run('pnpm', ['pack', '--pack-destination', destination], { cwd: archive.cwd, env: installEnv, timeout: 15_000 })
      }
      expect(lstatSync(archive.path).isFile(), `${archive.name} archive is missing`).toBe(true)
    }
    return packages
  }
  const initialCheckout = previousCheckout ?? workspace
  const [bundle, pluginApi, routing] = await archivesFor(initialCheckout,
    archiveDirectory ?? join(archives, 'initial'), archiveDirectory !== undefined)
  await run(process.execPath, [dsh, '--profile', profileName, '--from-default-profile', 'web', '--dump-config'], {
    cwd: root, env: installEnv, timeout: 20_000,
  })
  const settings = join(profile, 'pnpm-workspace.yaml')
  const defaults = readFileSync(settings, 'utf8')
  expect(defaults).toMatch(/^nodeLinker: hoisted$/m)
  expect(defaults).toMatch(/^autoInstallPeers: false$/m)
  // Resolve the two unpublished workspace dependencies from their tarballs.
  // Preserve DSH's generated settings so it can supply its own native peers.
  function chooseDependencies(api: typeof pluginApi, modelRouting: typeof routing) {
    writeFileSync(settings, defaults + `
overrides:
  ${JSON.stringify(api.name)}: ${JSON.stringify(api.spec)}
  ${JSON.stringify(modelRouting.name)}: ${JSON.stringify(modelRouting.spec)}
allowBuilds:
  koffi: true
`)
  }
  chooseDependencies(pluginApi, routing)
  async function manageBundle(action: 'add' | 'remove', target: string) {
    try {
      await run(process.execPath, [dsh, 'plugin', '--profile', profileName, action, target], {
        cwd: root, env: installEnv, timeout: 80_000,
      })
    } catch (error) {
      const details = installDiagnostics(profile, error)
      throw new Error(`DSH plugin ${action} failed${details ? `\n${details}` : ' without pnpm diagnostics'}`)
    }
  }
  await manageBundle('add', bundle.spec)
  expect(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')).toMatch(/^  autoInstallPeers: false$/m)
  const modules = join(profile, 'node_modules')
  const installedRequire = createRequire(join(modules, bundle.name, 'package.json'))
  for (const { name } of [bundle, pluginApi, routing]) {
    expect(realpathSync(installedRequire.resolve(`${name}/package.json`))).toBe(join(modules, name, 'package.json'))
  }
  expect(existsSync(join(modules, '@deepseek-ai/dsh-llm'))).toBe(false)

  let providerUrl = 'https://api.deepseek.com/anthropic'
  if (!liveProvider) {
    provider.listen(0, '127.0.0.1')
    await once(provider, 'listening')
    const address = provider.address()
    assert.ok(address && typeof address !== 'string')
    providerUrl = `http://127.0.0.1:${address.port}`
  }
  const outputLimit = liveProvider ? 256 : 64
  const overlay = (stateDir: string) => `- id: llm-deepseek
  config:
    baseURL: ${providerUrl}
    apiKeyEnv: DSHPA_INSTALL_TEST_KEY
    reasoningEffort: 'off'
    maxTokens: ${outputLimit}
- id: llm-deepseek-account
  disabled: true
- id: llm-retry
  disabled: true
- id: session-title-llm
  disabled: true
- id: dshpa
  config:
    inbox:
      storageDirectory: ${JSON.stringify(stateDir)}
      workRoot: ${JSON.stringify(workRoot)}
      resident: {}
      worker:
        provider: deepseek-official
        model: deepseek-flash
        concurrency: 1
      computeLimits:
        maxInputBytes: 8192
        maxOutputTokens: ${outputLimit}
        maxTurns: 1
        maxStepsPerTurn: 1
        maxWallTimeMs: ${liveProvider ? 30000 : 10000}
      budget:
        pricingVersion: ${liveProvider ? 'deepseek-flash-peak-2026-11-14' : 'packaged-install-fixture'}
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
`
  const loopback = { connection: 'close' }
  async function startResident(stateDir = storage, ready = true) {
    writeFileSync(patch, overlay(stateDir), { mode: 0o600 })
    const ownerPath = join(stateDir, RESIDENT_OWNER_FILE)
    const child = spawn('/bin/sh', [join(workspace, 'deploy/run-resident.sh'), process.execPath, dshHome, profileName, patch, '0'], {
      cwd: root, env: { ...systemEnv, DSHPA_INSTALL_TEST_KEY: liveKey ?? 'sk-dummy-only-for-loopback' }, stdio: 'ignore',
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
    await vi.waitFor(async () => {
      const response = await fetch(new URL('/dshpa/ready', ownerUrl), { headers: loopback, signal: AbortSignal.timeout(3_000) })
      expect(await response.json()).toMatchObject({ ready })
      expect(response.status).toBe(ready ? 200 : 503)
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
    return {
      rpc,
      inbox: (request: InboxRequest) => rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request),
      async stop() {
        child.kill('SIGTERM')
        const cleanExit = await Promise.race([
          exited,
          delay(8_000, undefined, { ref: false }).then(() => { throw new Error('The native resident process did not stop') }),
        ])
        expect(cleanExit).toEqual([0, null])
        expect(existsSync(ownerPath)).toBe(false)
      },
    }
  }
  const { rpc, inbox, stop } = await startResident()
  const { sessionId } = await rpc<{ sessionId: string }>('session/create', { args: { request: { cwd: workRoot } } })
  assert.ok(sessionId)
  const project = await inbox({ type: 'create_project', commandId: 'package-project',
    title: 'Installed Worker test', purpose: 'Exercise the native provider from the installed bundle.' })
  assert.ok(project.ok && project.kind === 'updated' && project.projectId)
  const created = await inbox({ type: 'create_task', commandId: 'package-task', sessionId, projectId: project.projectId,
    outcome: liveProvider
      ? 'The fictional pilot has 7 blue folders and 5 green folders. Calculate the total and use this format as your short summary: "Total folders: <number>." Return a ready report with an empty artifactIds array.'
      : 'Prepare an outline of the synthetic packaging test.' })
  assert.ok(created.ok && created.kind === 'updated' && created.taskId)
  const taskId = created.taskId
  async function task(readInbox = inbox) {
    const response = await readInbox({ type: 'snapshot' })
    assert.ok(response.ok && response.kind === 'snapshot')
    const item = response.snapshot.tasks.find(row => row.id === taskId)
    assert.ok(item)
    return item
  }
  const queued = await task()
  expect(queued.status).toBe('queued')
  expect(await inbox({ type: 'start', taskId: queued.id, expectedVersion: queued.version, cursor: 'package-start' }))
    .toMatchObject({ ok: true })
  if (liveProvider) {
    const candidate = await vi.waitFor(async () => {
      const item = await task()
      expect(item).toMatchObject({ status: 'verifying', runtime: 'inactive', canAccept: true })
      return item
    }, { timeout: 35_000 })
    expect(candidate.artifacts).toHaveLength(1)
    const artifactId = candidate.artifacts[0]!.id
    const readResult = (readInbox = inbox) => readInbox({ type: 'artifact', taskId, artifactId })
    const artifact = await readResult()
    expect(artifact).toMatchObject({ ok: true, kind: 'artifact', artifact: { mediaType: 'text/markdown', text: 'Total folders: 12.' } })
    expect(await inbox({ type: 'accept_result', taskId, expectedVersion: candidate.version })).toMatchObject({ ok: true })
    const completed = await task()
    expect(completed.status).toBe('completed')
    await stop()
    const reopened = await startResident()
    expect(await task(reopened.inbox)).toMatchObject({ id: taskId, status: 'completed', version: completed.version, runtime: 'inactive' })
    expect(await readResult(reopened.inbox)).toEqual(artifact)
    await reopened.stop()
    const db = new DatabaseSync(join(storage, DATABASE_FILENAME), { readOnly: true })
    try {
      const charges = db.prepare('SELECT provider, model, status, usage, actual_micros FROM budget_reservations WHERE task_id = ?').all(taskId)
      expect(charges).toEqual([expect.objectContaining({ provider: 'deepseek-official', model: 'deepseek-flash', status: 'settled',
        usage: expect.any(String), actual_micros: expect.any(Number) })])
      const charge = charges[0]!
      const usage = JSON.parse(String(charge.usage)) as { inputTokens: number; outputTokens: number }
      expect(usage.outputTokens).toBeGreaterThan(0)
      expect(usage.outputTokens).toBeLessThanOrEqual(outputLimit)
      console.log(JSON.stringify({ taskId, artifactId, model: charge.model, usage,
        estimatedCostMicrosUsd: charge.actual_micros }))
    } finally { db.close() }
    return
  }
  const parked = await vi.waitFor(async () => {
    const item = await task()
    expect(item).toMatchObject({ status: 'waiting_resource', runtime: 'inactive' })
    return item
  }, { timeout: 12_000 })
  expect(parked.wait?.referenceId).toBe('dshpa:compute:provider_rejected')
  expect(parked.artifacts).toEqual([])
  expect(requests).toEqual(['POST'])
  const expected = { id: taskId, status: parked.status, runtime: parked.runtime,
    version: parked.version, wait: { referenceId: parked.wait?.referenceId }, artifacts: [] }

  await stop()
  const database = join(storage, DATABASE_FILENAME)
  const identity = join(storage, 'local-inbox-identity.json')
  if (!previousCheckout) {
    const databaseBeforeRemoval = readFileSync(database)
    const identityBeforeRemoval = readFileSync(identity)
    await manageBundle('remove', bundle.name)
    expect(existsSync(join(modules, bundle.name))).toBe(false)
    assert.ok(readFileSync(database).equals(databaseBeforeRemoval), 'Plugin removal changed the WorkStore')
    assert.ok(readFileSync(identity).equals(identityBeforeRemoval), 'Plugin removal changed the owner identity')
    expect(readFileSync(workFile, 'utf8')).toBe(workContents)

    await manageBundle('add', bundle.spec)
    expect(realpathSync(installedRequire.resolve(`${bundle.name}/package.json`))).toBe(join(modules, bundle.name, 'package.json'))
    const reopened = await startResident()
    expect(await task(reopened.inbox)).toMatchObject(expected)
    await reopened.stop()
    expect(readFileSync(workFile, 'utf8')).toBe(workContents)
    expect(requests).toEqual(['POST'])
    return
  }

  const backup = database + V15_BACKUP_SUFFIX
  function inspectDatabase(path: string) {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      return {
        schema: db.prepare('PRAGMA user_version').get()?.user_version,
        tasks: db.prepare('SELECT * FROM tasks').all(),
        projects: db.prepare('SELECT * FROM projects').all(),
      }
    } finally { db.close() }
  }
  const before = inspectDatabase(database)
  const identityBytes = readFileSync(identity)
  expect(before.schema).toBe(15)
  expect(before.tasks).toHaveLength(1)
  expect(existsSync(backup)).toBe(false)
  expect(readFileSync(join(modules, bundle.name, 'lib/storage/schema.js'), 'utf8')).toContain('SCHEMA_VERSION = 15')
  const [current, currentApi, currentRouting] = await archivesFor(workspace, join(archives, 'current'), false)
  chooseDependencies(currentApi, currentRouting)
  await manageBundle('add', current.spec)
  expect(readFileSync(join(modules, current.name, 'lib/storage/schema.js'), 'utf8'))
    .toContain(`SCHEMA_VERSION = ${SCHEMA_VERSION}`)
  expect(inspectDatabase(database)).toEqual(before)
  const upgraded = await startResident()
  expect(await task(upgraded.inbox)).toMatchObject(expected)
  await upgraded.stop()
  const migrated = { ...before, schema: SCHEMA_VERSION }
  expect(inspectDatabase(database)).toEqual(migrated)
  expect(inspectDatabase(backup)).toEqual(before)
  expect(lstatSync(backup).mode & 0o777).toBe(0o600)
  expect(readFileSync(identity).equals(identityBytes)).toBe(true)
  expect(readFileSync(workFile, 'utf8')).toBe(workContents)
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const backupDigest = digest(backup)
  const upgradedDigest = digest(database)
  const restoredDir = join(root, 'restored')
  restoreWorkStoreBackup(backup, restoredDir)
  copyFileSync(identity, join(restoredDir, 'local-inbox-identity.json'))
  const restored = await startResident(restoredDir, false)
  const restoredSnapshot = await restored.inbox({ type: 'snapshot' })
  expect(restoredSnapshot).toMatchObject({ ok: true, kind: 'snapshot', snapshot: { recoveryMode: 'restore' } })
  expect(await task(restored.inbox)).toMatchObject(expected)
  expect(await restored.inbox({ type: 'start', taskId, expectedVersion: parked.version, cursor: 'must-not-replay' }))
    .toEqual({ ok: false, code: 'recovery_required' })
  await restored.stop()
  expect(inspectDatabase(join(restoredDir, DATABASE_FILENAME))).toEqual(migrated)
  expect(digest(backup)).toBe(backupDigest)
  expect(digest(database)).toBe(upgradedDigest)
  expect(requests).toEqual(['POST'])
}, 340_000)
