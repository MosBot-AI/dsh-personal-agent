import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { alphaWorkspaceSettings, readAlphaArchives, sha256 } from './alpha-archives.ts'

const repo = fileURLToPath(new URL('../', import.meta.url))
const profile = 'dshpa-alpha-trial'
export const dayMs = 86_400_000
const days = [1, 2, 3, 4, 5, 6, 7]
const count = z.int().nonnegative().max(1_000_000)
const instant = z.int().nonnegative().max(8_640_000_000_000_000 - days.length * dayMs)
const mode = z.enum(['owner', 'rehearsal'])
const startSchema = z.strictObject({
  mode, startedAt: instant, instance: z.uuid(), profileLockSha256: z.string().regex(/^[a-f0-9]{64}$/u),
})
const stopSchema = z.strictObject({ stoppedAt: instant })
const observation = z.strictObject({
  coverage: z.enum(['full', 'partial']),
  acceptedOutcomes: count,
  avoidableInterruptions: count,
  interventionSeconds: count,
  incidents: z.array(z.string().trim().min(1).max(300)).max(100),
})
type Start = z.infer<typeof startSchema>
type Observation = z.infer<typeof observation>

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function save(path: string, value: unknown, replace = false) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  try {
    if (replace) renameSync(temporary, path)
    else linkSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function dayPath(directory: string, day: number) {
  return join(directory, `day-${day}.json`)
}

function bounds(startedAt: number, day: number) {
  return { from: startedAt + (day - 1) * dayMs, through: startedAt + day * dayMs }
}

export function summarizeTrial(start: Pick<Start, 'mode' | 'startedAt'>, rows: ReadonlyMap<number, Observation>, now: number, stoppedAt?: number) {
  const plannedThrough = start.startedAt + days.length * dayMs
  assert.ok(now >= start.startedAt && (stoppedAt === undefined || (stoppedAt >= start.startedAt && stoppedAt <= now)),
    'Trial timestamps are out of order')
  const observedThrough = Math.min(now, stoppedAt ?? now, plannedThrough)
  for (const day of rows.keys()) assert.ok(days.includes(day), 'Invalid trial day')
  const periods = days.map(day => {
    const { from, through } = bounds(start.startedAt, day)
    const row = rows.get(day)
    if (row) assert.ok(observedThrough > from && (row.coverage === 'partial' || observedThrough >= through), `Day ${day} exceeds observed time`)
    let state: 'recorded' | 'partial' | 'missing' | 'in-progress' | 'upcoming' | 'outside-trial'
    if (row) state = row.coverage === 'full' ? 'recorded' : 'partial'
    else if (observedThrough >= through || (stoppedAt !== undefined && observedThrough > from)) state = 'missing'
    else if (stoppedAt !== undefined) state = 'outside-trial'
    else state = observedThrough > from ? 'in-progress' : 'upcoming'
    return { day, from: new Date(from).toISOString(), through: new Date(through).toISOString(),
      observedThrough: observedThrough > from ? new Date(Math.min(through, observedThrough)).toISOString() : null, state, observation: row ?? null }
  })
  const complete = stoppedAt !== undefined && observedThrough === plannedThrough && periods.every(period => period.state === 'recorded')
  const recorded = [...rows.values()]
  const totals = {
    acceptedOutcomes: recorded.reduce((total, row) => total + row.acceptedOutcomes, 0),
    avoidableInterruptions: recorded.reduce((total, row) => total + row.avoidableInterruptions, 0),
    interventionSeconds: recorded.reduce((total, row) => total + row.interventionSeconds, 0),
    incidents: recorded.reduce((total, row) => total + row.incidents.length, 0),
  }
  return { mode: start.mode, state: complete ? 'complete' : stoppedAt !== undefined ? 'incomplete'
    : observedThrough === plannedThrough ? 'awaiting-stop' : 'running', ownerTrialComplete: start.mode === 'owner' && complete,
  startedAt: new Date(start.startedAt).toISOString(), plannedThrough: new Date(plannedThrough).toISOString(),
  observedThrough: new Date(observedThrough).toISOString(), stoppedAt: stoppedAt === undefined ? null : new Date(stoppedAt).toISOString(),
  periods, totals }
}

function prepare(directory: string, archives: string) {
  const { bundle, pluginApi, routing, manifest, releaseSource, archiveManifestSha256 } = readAlphaArchives(repo, resolve(archives))
  const dsh = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
  const { version: dshVersion } = readJson(join(dirname(dsh), '..', 'package.json')) as { version: string }
  const home = join(directory, 'home')
  const profileDirectory = join(home, 'profiles', profile)
  mkdirSync(directory, { mode: 0o700 })
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1', XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(directory, 'cache'),
    PNPM_CONFIG_OFFLINE: process.env.PNPM_CONFIG_OFFLINE, PNPM_CONFIG_REGISTRY: process.env.PNPM_CONFIG_REGISTRY,
    PNPM_CONFIG_STORE_DIR: process.env.PNPM_CONFIG_STORE_DIR, npm_config_userconfig: process.env.npm_config_userconfig,
  }
  execFileSync(process.execPath, [dsh, '--profile', profile, '--from-default-profile', 'web', '--dump-config'], { timeout: 20_000, env })
  const settings = join(profileDirectory, 'pnpm-workspace.yaml')
  writeFileSync(settings, alphaWorkspaceSettings(readFileSync(settings, 'utf8'), pluginApi, routing), { mode: 0o600 })
  execFileSync(process.execPath, [dsh, 'plugin', '--profile', profile, 'add', bundle.spec], { timeout: 80_000, env })
  for (const pkg of [bundle, pluginApi, routing]) {
    const installed = readJson(join(profileDirectory, 'node_modules', pkg.name, 'package.json'))
    assert.ok(installed && typeof installed === 'object' && 'version' in installed && installed.version === pkg.version,
      `Installed alpha package version differs for ${pkg.name}`)
  }
  mkdirSync(join(home, 'trial-work'), { mode: 0o700 })
  writeFileSync(join(directory, 'resident.yml'), `- id: dshpa
  config:
    inbox:
      storageDirectory: !!js dshHomePath('trial-state')
      workRoot: !!js dshHomePath('trial-work')
      routines: true
      resident: {}
`, { mode: 0o600 })
  writeFileSync(join(directory, 'SHA256SUMS'), manifest, { mode: 0o600 })
  save(join(directory, 'prepared.json'), { profile, releaseSource, archiveManifestSha256, bundleVersion: bundle.version, dshVersion,
    node: process.version, os: process.platform, osRelease: release(), arch: process.arch })
}

function readTrial(directory: string) {
  const prepared = readJson(join(directory, 'prepared.json'))
  const startFile = join(directory, 'start.json')
  if (!existsSync(startFile)) return { prepared, start: undefined, stoppedAt: undefined }
  const start = startSchema.parse(readJson(startFile))
  const stopFile = join(directory, 'stop.json')
  const stoppedAt = existsSync(stopFile) ? stopSchema.parse(readJson(stopFile)).stoppedAt : undefined
  return { prepared, start, stoppedAt }
}

function startTrial(directory: string, selected: string) {
  const selectedMode = mode.parse(selected)
  assert.ok(!readTrial(directory).start, 'This trial has already started')
  const ready = JSON.parse(execFileSync(process.execPath, [join(repo, 'deploy/ops.mjs'), 'ready', join(directory, 'home', 'trial-state')],
    { timeout: 8_000, encoding: 'utf8' })) as { ready: boolean; instance: string }
  assert.ok(ready.ready, 'Start the prepared resident before opting in')
  const profileLock = readFileSync(join(directory, 'home', 'profiles', profile, 'pnpm-lock.yaml'))
  const start = startSchema.parse({ mode: selectedMode, startedAt: Date.now(), instance: ready.instance, profileLockSha256: sha256(profileLock) })
  save(join(directory, 'start.json'), start)
}

function status(directory: string) {
  const { prepared, start, stoppedAt } = readTrial(directory)
  if (!start) return { prepared, state: 'prepared', ownerTrialComplete: false }
  const rows = new Map(days.flatMap(day => existsSync(dayPath(directory, day))
    ? [[day, observation.parse(readJson(dayPath(directory, day)))] as const] : []))
  return { prepared, startInstance: start.instance, profileLockSha256: start.profileLockSha256, ...summarizeTrial(start, rows, Date.now(), stoppedAt) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, rawDirectory, first, second, ...extra] = process.argv.slice(2)
  assert.ok(rawDirectory && extra.length === 0, 'Usage: owner-trial.ts prepare|start|record|stop|status DIRECTORY [ARGUMENTS]')
  const directory = resolve(rawDirectory)
  if (command === 'prepare' && first && second === undefined) prepare(directory, first)
  else if (command === 'start' && first && second === undefined) startTrial(directory, first)
  else if (command === 'record' && first && second) {
    const day = Number(first)
    assert.ok(days.includes(day), 'Choose a trial day from 1 through 7')
    const { start, stoppedAt } = readTrial(directory)
    assert.ok(start, 'Start the trial before recording a day')
    const row = observation.parse(readJson(second))
    summarizeTrial(start, new Map([[day, row]]), Date.now(), stoppedAt)
    save(dayPath(directory, day), row, true)
  } else if (command === 'stop' && first === undefined) {
    const { start, stoppedAt } = readTrial(directory)
    assert.ok(start && stoppedAt === undefined, 'The trial must be running to stop')
    const now = Date.now()
    assert.ok(now >= start.startedAt, 'Trial timestamps are out of order')
    save(join(directory, 'stop.json'), { stoppedAt: now })
  } else assert.ok(command === 'status' && first === undefined, 'Invalid owner trial command or arguments')
  console.log(JSON.stringify(status(directory), null, 2))
}
