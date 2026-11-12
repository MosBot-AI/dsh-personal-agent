import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxRequest, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { RESIDENT_OWNER_FILE } from '../../packages/personal-agent/src/runtime/resident-web.js'
import { restoreWorkStoreBackup } from '../../packages/personal-agent/src/storage/restore.js'
import { prepareWebHost } from './fixtures/web-host.js'

const run = promisify(execFile)
const launcher = fileURLToPath(new URL('../../deploy/run-resident.sh', import.meta.url))
const renderer = fileURLToPath(new URL('../../deploy/render-service.mjs', import.meta.url))
const ops = fileURLToPath(new URL('../../deploy/ops.mjs', import.meta.url))
const loopback = { connection: 'close' }

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, description: string, limit = 8_000): Promise<T> {
  const end = performance.now() + limit
  do {
    const value = await read()
    if (value !== undefined) return value
    await delay(25)
  } while (performance.now() < end)
  throw new Error(`Timed out waiting for ${description}`)
}

function profileOverlay(storage: string, workRoot?: string): string {
  return [
    '- id: schedule', '  inject: [dshpaScheduleResolverReady]',
    '- id: dshpa', '  config:', '    inbox:',
    `      storageDirectory: ${JSON.stringify(storage)}`,
    workRoot === undefined ? "      workRoot: !!js dshHomePath('resident-work')" : `      workRoot: ${JSON.stringify(workRoot)}`,
    '      routines: true',
    '      resident:',
    '        watchdog: { tickMs: 100, heartbeatGapMs: 300, warmTimeoutMs: 3000 }',
    '',
  ].join('\n')
}

function launchResident(profile: ReturnType<typeof prepareWebHost>, overlay: string): ChildProcessWithoutNullStreams {
  const child = spawn('/bin/sh', [launcher, process.execPath, profile.dshHome, profile.profileName, overlay, '0'], {
    cwd: profile.root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  })
  child.stdin.end()
  return child
}

async function expectRejectedLaunch(child: ChildProcessWithoutNullStreams): Promise<void> {
  const [code, signal] = await once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
  expect(typeof code === 'number' && code !== 0).toBe(true)
  expect(signal).toBeNull()
}

it('renders an opt-in login or user service with the foreground launcher', () => {
  const profile = prepareWebHost()
  onTestFinished(() => rmSync(profile.root, { recursive: true, force: true }))
  const overlay = join(profile.root, 'owner profile.yml')
  writeFileSync(overlay, '[]\n', { mode: 0o600 })
  const platform = process.platform === 'darwin' ? 'launchd' : 'systemd'
  const rendered = spawnSync(process.execPath, [renderer, platform, process.execPath, profile.dshHome, profile.profileName, overlay, '3080'], { encoding: 'utf8' })
  expect(rendered.status, rendered.stderr).toBe(0)
  expect(rendered.stdout).toContain('run-resident.sh')
  expect(rendered.stdout).toContain('owner profile.yml')
  const unit = join(profile.root, platform === 'launchd' ? 'org.mosbot.dshpa.test.plist' : 'dshpa-test.service')
  writeFileSync(unit, rendered.stdout, { mode: 0o600 })
  const validated = platform === 'launchd' ? spawnSync('/usr/bin/plutil', ['-lint', unit], { encoding: 'utf8' })
    : spawnSync('systemd-analyze', ['verify', unit], { encoding: 'utf8' })
  expect(validated.status, validated.stderr || validated.error?.message).toBe(0)
  rmSync(unit)
  expect(existsSync(join(profile.dshHome, 'profiles', profile.profileName, 'package.json'))).toBe(true)
})

it.each([
  { configuration: 'the resident bundle is missing', profilePatch: [], missingBundle: true },
  { configuration: 'the resident bundle is disabled', profilePatch: ['- id: dshpa', '  disabled: true'] },
  { configuration: 'the inbox cannot mount without the configured scheduler', profilePatch: ['- id: schedule', '  disabled: true'] },
])('rejects native resident startup when $configuration', async ({ profilePatch, missingBundle }) => {
  const profile = prepareWebHost(undefined, profilePatch)
  let child: ChildProcessWithoutNullStreams | undefined
  onTestFinished(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    } finally {
      rmSync(profile.root, { recursive: true, force: true })
    }
  })
  if (missingBundle) {
    const bundle = '@mosbot-ai/dshpa'
    const directory = join(profile.dshHome, 'profiles', profile.profileName)
    const path = join(directory, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } }
    }
    delete manifest.dependencies[bundle]
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== bundle)
    writeFileSync(path, JSON.stringify(manifest))
    rmSync(join(directory, 'node_modules', bundle), { recursive: true, force: true })
  }
  const storage = join(profile.root, 'resident-state')
  const overlay = join(profile.root, 'resident-activation.yml')
  writeFileSync(overlay, profileOverlay(storage), { mode: 0o600 })
  child = launchResident(profile, overlay)
  await expectRejectedLaunch(child)
  expect(existsSync(join(storage, RESIDENT_OWNER_FILE))).toBe(false)
}, 15_000)

it('runs a native resident host with no browser, catches a suspended wake, backs up and restarts safely', async () => {
  const profile = prepareWebHost()
  const storage = join(profile.root, 'resident-state')
  const overlay = join(profile.root, 'resident-activation.yml')
  const children = new Set<ChildProcessWithoutNullStreams>()
  onTestFinished(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      child.kill('SIGCONT')
      child.kill('SIGKILL')
      await exited
    }
    rmSync(profile.root, { recursive: true, force: true })
  })

  function launch() {
    const child = launchResident(profile, overlay)
    children.add(child)
    return child
  }

  async function start(directory: string, ready: boolean) {
    writeFileSync(overlay, profileOverlay(directory), { mode: 0o600 })
    const child = launch()
    let outputBytes = 0
    child.stdout.on('data', chunk => { outputBytes += chunk.length })
    child.stderr.on('data', chunk => { outputBytes += chunk.length })
    const ownerPath = join(directory, RESIDENT_OWNER_FILE)
    const owner = await waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('The resident native process exited during startup')
      if (!existsSync(ownerPath)) return undefined
      const record = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid: number; instance: string; url: string }
      return record.pid === child.pid ? record : undefined
    }, 'an owner-private resident link', 20_000)
    expect(lstatSync(ownerPath).mode & 0o777).toBe(0o600)
    expect(owner.pid).toBe(child.pid)
    const origin = new URL(owner.url).origin
    const live = await fetch(`${origin}/dshpa/live`, { headers: loopback, signal: AbortSignal.timeout(5_000) })
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({ live: true, instance: owner.instance })
    await waitFor(async () => {
      const response = await fetch(`${origin}/dshpa/ready`, { headers: loopback, signal: AbortSignal.timeout(5_000) })
      const state = await response.json() as { ready: boolean; instance: string }
      return state.ready === ready && state.instance === owner.instance && response.status === (ready ? 200 : 503) ? true : undefined
    }, 'the expected resident readiness')
    const auth = await fetch(owner.url, { headers: loopback, redirect: 'manual', signal: AbortSignal.timeout(5_000) })
    expect(auth.status).toBe(303)
    const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie)
    await auth.body?.cancel()

    async function rpc(payload: InboxRequest): Promise<InboxResponse> {
      const rpcId = randomUUID()
      const response = await fetch(`${origin}/api/${INBOX_RPC_ENDPOINT}`, { method: 'POST', redirect: 'error',
        headers: { ...loopback, cookie: cookie!, 'content-type': 'application/json' }, signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({ type: 'client-request', rpcId, method: INBOX_RPC_ENDPOINT, payload }),
      })
      assert.equal(response.status, 200)
      const body = await response.json() as { rpcId: string; result: { ok: boolean; value: InboxResponse } }
      assert.ok(body.rpcId === rpcId && body.result.ok)
      return body.result.value
    }
    async function snapshot() {
      const value = await rpc({ type: 'snapshot' })
      assert.ok(value.ok && value.kind === 'snapshot' && value.snapshot.schedules)
      return value.snapshot.schedules
    }
    async function stop() {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
      child.kill('SIGTERM')
      const [code, signal] = await exited
      expect(code).toBe(0)
      expect(signal).toBeNull()
      expect(outputBytes).toBe(0)
      expect(existsSync(ownerPath)).toBe(false)
    }
    return { child, owner, origin, rpc, snapshot, stop }
  }

  const invalidWorkRoot = join(profile.root, 'invalid-work-root')
  writeFileSync(invalidWorkRoot, '')
  writeFileSync(overlay, profileOverlay(storage, invalidWorkRoot), { mode: 0o600 })
  await expectRejectedLaunch(launch())
  expect(existsSync(join(storage, RESIDENT_OWNER_FILE))).toBe(false)

  const first = await start(storage, true)
  await expectRejectedLaunch(launch())
  expect(JSON.parse(readFileSync(join(storage, RESIDENT_OWNER_FILE), 'utf8')).pid).toBe(first.child.pid)
  expect((await fetch(`${first.origin}/dshpa/ready`, { headers: { ...loopback, origin: 'https://untrusted.invalid' } })).status).toBe(403)
  expect((await fetch(`${first.origin}/api/${INBOX_RPC_ENDPOINT}`, { method: 'POST', headers: { ...loopback, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'unauthorized-backup', method: INBOX_RPC_ENDPOINT, payload: { type: 'resident_backup' } }),
  })).status).toBe(401)

  const when = new Date(Date.now() + 3_500).toISOString()
  const text = 'PA021 private resident reminder fixture'
  expect(await first.rpc({ type: 'save_routine', commandId: 'resident-create', draft: {
    title: 'Resident check', timing: { kind: 'at', at: when }, target: { kind: 'reminder', text }, misfire: 'latest',
  } })).toMatchObject({ ok: true })
  const draft = (await first.snapshot()).routines[0]!
  expect(await first.rpc({ type: 'arm_routine', commandId: 'resident-arm', routineId: draft.id, expectedRevision: draft.revision }))
    .toMatchObject({ ok: true })
  await waitFor(() => {
    const db = new DatabaseSync(join(storage, 'state.sqlite'), { readOnly: true })
    try { return db.prepare("SELECT 1 FROM routine_mappings WHERE state = 'bound'").get() ? true : undefined }
    finally { db.close() }
  }, 'the committed native binding', 2_500)

  // Stop only the isolated process. HTTP connections are closed and no browser is launched.
  first.child.kill('SIGSTOP')
  try { await delay(Math.max(500, Date.parse(when) - Date.now() + 100)) }
  finally { first.child.kill('SIGCONT') }
  const reminder = await waitFor(async () => (await first.snapshot()).reminders[0], 'the wake after the stopped process resumed')
  expect(reminder).toMatchObject({ intendedAt: when, text })
  const health = await run(process.execPath, [ops, 'inspect', storage], { timeout: 10_000,
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' } })
  expect(JSON.parse(health.stdout)).toMatchObject({ health: { live: true, ready: true },
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'heartbeat_gap' })]) })

  const saved = await run(process.execPath, [ops, 'backup', storage], { timeout: 20_000 })
  const backup = JSON.parse(saved.stdout) as { backup: { name: string; bytes: number }; retention: { status: string } }
  expect(backup.backup.bytes).toBeGreaterThan(0)
  expect(backup.retention.status).toBe('applied')
  const file = join(storage, 'resident-backups', backup.backup.name)
  expect(lstatSync(file).mode & 0o777).toBe(0o600)
  const audit = await run(process.execPath, [ops, 'audit', storage], { timeout: 10_000 })
  expect(JSON.parse(audit.stdout)).toMatchObject({ version: 1, counts: { occurrences: 1 } })
  expect(audit.stdout.includes(text)).toBe(false)
  await first.stop()

  const restarted = await start(storage, true)
  expect(restarted.owner.instance).not.toBe(first.owner.instance)
  expect((await restarted.snapshot()).reminders.map(item => item.id)).toEqual([reminder.id])
  await restarted.stop()

  const restoreDirectory = join(profile.root, 'restored-state')
  restoreWorkStoreBackup(file, restoreDirectory)
  copyFileSync(join(storage, 'local-inbox-identity.json'), join(restoreDirectory, 'local-inbox-identity.json'))
  const restored = await start(restoreDirectory, false)
  expect((await restored.snapshot()).reminders.map(item => item.id)).toEqual([reminder.id])
  expect(await restored.rpc({ type: 'run_routine_now', commandId: 'restore-must-not-run', routineId: draft.id, expectedRevision: 2 }))
    .toEqual({ ok: false, code: 'recovery_required' })
  expect(await restored.rpc({ type: 'resident_status' })).toMatchObject({ ok: true, kind: 'resident', value: {
    health: { live: true, ready: false, degraded: expect.arrayContaining([expect.objectContaining({ code: 'restore_only' })]) },
  } })
  await restored.stop()
}, 65_000)
