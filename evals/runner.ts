import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { journeys, plan, type Journey } from './cases/foundation.ts'

const repo = fileURLToPath(new URL('../', import.meta.url))
const minimumAcceptance = 0.8
const rejectionReasons = ['execution', 'accuracy', 'usability', 'recovery', 'other']
type Run = {
  id: string
  journey: Journey
  exitCode: number
  elapsedMs: number
  outputs: number
  artifactSha256: string | null
}
type Rating = { id: string; decision: 'pending' | 'accepted' | 'rejected'; reason: string; note: string }
type Ratings = { reviewer: string; cases: Rating[] }

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function save(path: string, value: unknown) {
  const pending = path + '.tmp'
  writeFileSync(pending, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(pending, path)
}

function passed(run: Run) {
  return run.exitCode === 0 && run.outputs === journeys[run.journey].outputs && run.artifactSha256 !== null
}

function hasArtifacts(path: string) {
  if (!existsSync(path)) return { outputs: 0, artifactSha256: null }
  const bytes = readFileSync(path)
  const records: unknown = JSON.parse(bytes.toString('utf8'))
  assert.ok(Array.isArray(records) && records.every(record => typeof record?.input === 'string' && typeof record?.output === 'string'),
    'Invalid captured artifact')
  return { outputs: records.length, artifactSha256: digest(bytes) }
}

function collect(archiveDir: string, directory: string) {
  assert.ok(process.env.DEEPSEEK_API_KEY?.trim(), 'Load the authorized DEEPSEEK_API_KEY before collecting')
  const archives = resolve(archiveDir)
  execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: archives, stdio: 'ignore' })
  const releaseSource = readFileSync(join(archives, 'source-commit.txt'), 'utf8').trim()
  assert.match(releaseSource, /^[0-9a-f]{40}$/u, 'The release source commit is missing')
  const archiveManifest = readFileSync(join(archives, 'SHA256SUMS'))
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const fixtureDirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0
  const out = resolve(directory)
  mkdirSync(out, { mode: 0o700 })
  const runs: Run[] = []
  const batch = { releaseSource, archiveManifestSha256: digest(archiveManifest), revision, fixtureDirty,
    node: process.version, platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(), runs }
  writeFileSync(join(out, 'SHA256SUMS'), archiveManifest, { mode: 0o600 })
  save(join(out, 'batch.json'), batch)
  save(join(out, 'scores.json'), { reviewer: '', cases: plan.map(({ id }) => ({ id, decision: 'pending', reason: '', note: '' })) })

  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSHPA_INSTALL_')))
  for (const { id, journey } of plan) {
    const artifact = join(out, id + '.json')
    const env: NodeJS.ProcessEnv = { ...base, DSHPA_INSTALL_ARCHIVES: archives, DSHPA_INSTALL_EVIDENCE_FILE: artifact,
      [journeys[journey].env]: '1', DSHPA_INSTALL_LIVE_DEEPSEEK: journey === 'reminder' ? '0' : '1' }
    if (journey === 'reminder') delete env.DEEPSEEK_API_KEY
    const log = openSync(join(out, id + '.log'), 'wx', 0o600)
    const startedAt = performance.now()
    try {
      const result = spawnSync('pnpm', ['test:install', '--reporter=dot'], { cwd: repo, env, stdio: ['ignore', log, log] })
      if (result.error) throw result.error
      runs.push({ id, journey, exitCode: result.status ?? 1, elapsedMs: Math.round(performance.now() - startedAt), ...hasArtifacts(artifact) })
      save(join(out, 'batch.json'), batch)
      console.log(`${id} ${passed(runs.at(-1)!) ? 'passed' : 'failed'}`)
    } finally {
      closeSync(log)
    }
  }
  const lines = runs.map(run => {
    const artifact = run.artifactSha256 ? `[Artifact](${run.id}.json)` : 'Unavailable'
    return `| ${run.id} | ${passed(run) ? 'Passed' : 'Failed'} | ${artifact} | [Log](${run.id}.log) |`
  })
  writeFileSync(join(out, 'review.md'), ['# Foundation outcome sample', '', 'Record human decisions in [scores.json](scores.json).', '',
    '| Case | Fixture | Evidence | Diagnostic |', '| --- | --- | --- | --- |', ...lines, ''].join('\n'), { mode: 0o600 })
}

export function summarize(runs: Run[], ratings: Ratings) {
  assert.ok(Array.isArray(runs) && runs.length <= plan.length &&
    runs.every((run, index) => run.id === plan[index]?.id && run.journey === plan[index]?.journey),
    'Execution ledger must follow the fixed plan')
  assert.ok(typeof ratings.reviewer === 'string' && Array.isArray(ratings.cases) && ratings.cases.length === plan.length,
    'The review sheet must cover the fixed plan')
  const byId = new Map(runs.map(run => [run.id, run]))
  const decisions = new Map(ratings.cases.map(rating => [rating.id, rating]))
  assert.equal(decisions.size, plan.length, 'Duplicate review case')
  const byJourney = Object.fromEntries(Object.keys(journeys).map(journey => [journey, {
    executed: 0, fixtureFailures: 0, accepted: 0, rejected: 0, pending: 0,
  }]))
  const rejections: Record<string, number> = {}
  let accepted = 0
  let pending = 0
  for (const { id, journey } of plan) {
    const run = byId.get(id)
    const rating = decisions.get(id)
    assert.ok(rating && ['pending', 'accepted', 'rejected'].includes(rating.decision) &&
      typeof rating.reason === 'string' && typeof rating.note === 'string', `Invalid review for ${id}`)
    const counts = byJourney[journey]!
    if (run) {
      counts.executed += 1
      if (!passed(run)) counts.fixtureFailures += 1
    }
    if (rating.decision === 'pending') {
      pending += 1
      counts.pending += 1
      continue
    }
    assert.ok(ratings.reviewer.trim() && run, `A named reviewer and an execution are required for ${id}`)
    if (rating.decision === 'accepted') {
      assert.ok(passed(run), `Failed fixture ${id} cannot be accepted`)
      accepted += 1
      counts.accepted += 1
    } else {
      assert.ok(rejectionReasons.includes(rating.reason) && rating.note.trim(), `Record a reason and note for ${id}`)
      counts.rejected += 1
      rejections[rating.reason] = (rejections[rating.reason] ?? 0) + 1
    }
  }
  const complete = runs.length === plan.length && pending === 0
  const acceptanceRate = complete ? accepted / runs.length : null
  return { planned: plan.length, executed: runs.length, accepted, pending, byJourney, rejections, acceptanceRate,
    targetMet: acceptanceRate === null ? null : acceptanceRate >= minimumAcceptance }
}

function report(directory: string) {
  const { runs } = JSON.parse(readFileSync(join(directory, 'batch.json'), 'utf8')) as { runs: Run[] }
  const ratings = JSON.parse(readFileSync(join(directory, 'scores.json'), 'utf8')) as Ratings
  const summary = summarize(runs, ratings)
  for (const run of runs) {
    const evidence = hasArtifacts(join(directory, run.id + '.json'))
    assert.deepEqual(evidence, { outputs: run.outputs, artifactSha256: run.artifactSha256 }, `Evidence changed for ${run.id}`)
  }
  console.log(JSON.stringify(summary, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2)
  if (command === 'collect' && first && second) collect(first, second)
  else if (command === 'report' && first && !second) report(first)
  else throw new Error('Usage: node evals/runner.ts collect <archives> <new-directory> | report <directory>')
}
