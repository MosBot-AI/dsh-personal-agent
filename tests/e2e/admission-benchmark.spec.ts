import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, release, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { it, onTestFinished, vi } from 'vitest'
import { INBOX_RPC_ENDPOINT, type InboxRequest, type InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWebHost, prepareWebHost } from './fixtures/web-host.js'

const require = createRequire(import.meta.url)
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const probe = fileURLToPath(new URL('./fixtures/admission-benchmark-probe.mjs', import.meta.url))
const sessionId = 'admission-benchmark-session'
const workerCursors = ['held-worker-1', 'held-worker-2', 'held-worker-3', 'held-worker-4']
const sampleCount = 1_000
const warmupCount = 20
const p95TargetMs = 1_000
const evidencePath = process.env.DSHPA_ADMISSION_EVIDENCE_DIR

it.skipIf(!evidencePath)('measures authenticated native command admission with four held background Workers', async () => {
  assert.ok(evidencePath)
  const evidenceDir = resolve(evidencePath)
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  const sourceModified = execFileSync('git', ['status', '--porcelain', '--', 'packages', 'package.json', 'pnpm-lock.yaml'],
    { cwd: repositoryRoot, encoding: 'utf8' }).length > 0
  const { version: dshVersion } = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')) as { version: string }
  const prepared = prepareWebHost(probe, [
    '- id: dshpa', '  config:', '    inbox:',
    "      storageDirectory: !!js dshHomePath('admission-benchmark-inbox')",
    '      workRoot: !!js process.cwd()',
    '      worker:', '        provider: dshpa-admission-benchmark-fixture', '        model: controlled-hold',
    '        concurrency: 4', '        unmetered: true',
  ])
  onTestFinished(() => rmSync(prepared.root, { recursive: true, force: true }))
  const host = await openWebHost(probe, { prepared })
  const cookie = await host.exchange()
  const path = join(prepared.dshHome, 'admission-benchmark-inbox', DATABASE_FILENAME)
  const trace = join(prepared.dshHome, 'fixture-streams.jsonl')
  const streams = () => readFileSync(trace, 'utf8').trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line) as string).sort()

  function readDatabase<T>(query: (db: DatabaseSync) => T): T {
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      return query(database)
    } finally {
      database.close()
    }
  }

  function countState() {
    return readDatabase(database => {
      const counts = database.prepare(`
        SELECT (SELECT count(*) FROM tasks) AS tasks,
               (SELECT count(*) FROM attempts) AS attempts,
               (SELECT count(*) FROM commands) AS commands,
               (SELECT count(*) FROM source_events) AS source_events,
               (SELECT count(*) FROM work_events) AS work_events
      `).get()
      assert.ok(counts)
      return {
        tasks: Number(counts.tasks), attempts: Number(counts.attempts), commands: Number(counts.commands),
        source_events: Number(counts.source_events), work_events: Number(counts.work_events),
        databaseBytes: statSync(path).size,
        walBytes: statSync(path + '-wal', { throwIfNoEntry: false })?.size ?? 0,
      }
    })
  }
  async function rpc(request: InboxRequest) {
    const response = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, cookie)
    assert.equal(response.status, 200, host.diagnostics())
    assert.ok(response.result?.ok, host.diagnostics())
    return response.result.value
  }
  async function update(request: InboxRequest) {
    const response = await rpc(request)
    assert.ok(response.ok && response.kind === 'updated', JSON.stringify(response))
    return response
  }
  async function snapshot() {
    const response = await rpc({ type: 'snapshot' })
    assert.ok(response.ok && response.kind === 'snapshot', JSON.stringify(response))
    return response.snapshot
  }

  assert.equal((await host.rpc(INBOX_RPC_ENDPOINT, { type: 'snapshot' })).status, 401)
  const { projectId } = await update({ type: 'create_project', commandId: 'admission-project',
    title: 'Command admission fixture', purpose: 'Measure owner command acknowledgement under four controlled jobs.' })
  assert.ok(projectId)
  const requestFor = (commandId: string): InboxRequest => ({
    type: 'create_task', projectId, commandId, sessionId, outcome: 'Admission fixture ' + commandId,
  })
  const workers: { cursor: string; taskId: string }[] = []
  for (const cursor of workerCursors) {
    const { taskId } = await update(requestFor(cursor))
    assert.ok(taskId)
    workers.push({ cursor, taskId })
  }
  const queued = await snapshot()
  for (const { cursor, taskId } of workers) {
    const task = queued.tasks.find(task => task.id === taskId)
    assert.ok(task)
    assert.equal(task.status, 'queued')
    await update({ type: 'start', taskId, expectedVersion: task.version, cursor })
  }
  await vi.waitFor(() => assert.deepEqual(streams(), workerCursors), { timeout: 8_000 })

  const workerIds = workers.map(worker => worker.taskId)
  const workerRecords = () => readDatabase(database => database.prepare(`
    SELECT tasks.id AS taskId, tasks.record ->> '$.status' AS taskStatus,
           attempts.id AS attemptId, attempts.status AS attemptStatus, attempts.record ->> '$.sessionId' AS sessionId
    FROM tasks JOIN attempts ON attempts.id = tasks.attempt_id
    WHERE tasks.id IN (?, ?, ?, ?) ORDER BY tasks.id
  `).all(...workerIds))
  const initialRecords = workerRecords()
  assert.equal(initialRecords.length, workerCursors.length)
  assert.equal(new Set(initialRecords.map(row => row.sessionId)).size, workerCursors.length)
  for (const row of initialRecords) {
    assert.equal(row.taskStatus, 'running')
    assert.equal(row.attemptStatus, 'running')
    assert.equal(typeof row.sessionId, 'string')
  }

  async function verifySlots() {
    const current = await snapshot()
    assert.deepEqual(current.usage?.workerSlots, { active: workerCursors.length, limit: workerCursors.length })
    assert.deepEqual(streams(), workerCursors)
    assert.deepEqual(workerRecords(), initialRecords)
    return current
  }
  const initial = await verifySlots()
  for (const id of workerIds) {
    const task = initial.tasks.find(item => item.id === id)
    assert.ok(task)
    assert.equal(task.status, 'running')
    assert.equal(task.runtime, 'active')
  }
  for (let i = 0; i < warmupCount; i++) {
    const { taskId } = await update(requestFor('admission-warmup-' + i))
    assert.ok(taskId)
  }
  const before = countState()
  const timingsMs: number[] = []
  const admitted = new Map<string, string>()
  const windowStart = performance.now()
  for (let i = 0; i < sampleCount; i++) {
    const commandId = 'admission-sample-' + i
    const request = requestFor(commandId)
    const started = performance.now()
    const response = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, cookie)
    timingsMs.push(performance.now() - started)
    assert.equal(response.status, 200, host.diagnostics())
    assert.ok(response.result?.ok, host.diagnostics())
    const acknowledged = response.result.value
    assert.ok(acknowledged.ok && acknowledged.kind === 'updated' && acknowledged.taskId, JSON.stringify(acknowledged))
    admitted.set(commandId, acknowledged.taskId)
    if ((i + 1) % 100 === 0) await verifySlots()
  }
  const elapsedMs = performance.now() - windowStart
  assert.equal(new Set(admitted.values()).size, sampleCount)
  const finalWhileRunning = countState()
  for (const key of ['tasks', 'attempts', 'commands', 'source_events', 'work_events'] as const) {
    assert.equal(finalWhileRunning[key] - before[key], sampleCount, key)
  }
  const starts = streams()
  await host.close()

  const finalAfterStop = countState()
  const receipts = readDatabase(database => database.prepare(`
    SELECT command_id, task_id, tasks.record ->> '$.status' AS status
    FROM commands JOIN tasks ON tasks.id = commands.task_id
    WHERE command_id GLOB 'admission-sample-*'
  `).all())
  assert.equal(receipts.length, sampleCount)
  for (const receipt of receipts) {
    assert.equal(receipt.task_id, admitted.get(String(receipt.command_id)))
    assert.equal(receipt.status, 'queued')
  }

  const sorted = [...timingsMs].sort((a, b) => a - b)
  const nearestRank = (percentile: number) => sorted[Math.ceil(percentile * sorted.length) - 1]!
  const p95 = nearestRank(0.95)
  const results = {
    revision, sourceModified,
    transport: 'authenticated native DSH Web loopback JSON RPC',
    command: 'create_task',
    unit: 'ms',
    clock: 'performance.now',
    percentile: 'nearest rank',
    workerSlots: workerCursors.length,
    fixtureModelStreamStarts: starts,
    activeWorkerVerification: 'four exact task/attempt/session records and active slots checked every 100 measured commands',
    modelNetworkCalls: 0,
    admissionPattern: 'serial',
    warmupCount,
    sampleCount,
    persistedAcknowledgments: admitted.size,
    elapsedMs,
    p50: nearestRank(0.50),
    p95, p95TargetMs, metP95Target: p95 <= p95TargetMs,
    p99: nearestRank(0.99),
    max: sorted.at(-1),
    before, finalWhileRunning, finalAfterStop,
    environment: { os: process.platform, kernel: release(), arch: process.arch, node: process.version,
      dsh: dshVersion, cpuModel: cpus()[0]?.model.trim(), logicalCpus: cpus().length, memoryBytes: totalmem() },
    timingsMs,
  }
  writeFileSync(join(evidenceDir, 'admission-latency.json'), JSON.stringify(results, null, 2) + '\n', { mode: 0o600 })
  const { timingsMs: omitted, ...summary } = results
  console.log('DSHPA_ADMISSION_BENCH ' + JSON.stringify(summary))
  assert.ok(results.metP95Target, 'Controlled measurement exceeds the proposed p95 target')
}, 120_000)
