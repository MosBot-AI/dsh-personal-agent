import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { packageArchive, readAlphaArchives, sha256 } from '../../evals/alpha-archives.js'
import { dayMs, summarizeTrial } from '../../evals/owner-trial.js'

const start = { mode: 'owner', startedAt: Date.parse('2026-11-16T19:14:00.000Z') } as const
const zero = { coverage: 'full', acceptedOutcomes: 0, avoidableInterruptions: 0, interventionSeconds: 0, incidents: [] } as const
const noActivity = { ...zero, incidents: [] }

it('distinguishes recorded zero activity, missing periods and the current interval', () => {
  const summary = summarizeTrial(start, new Map([[1, noActivity]]), start.startedAt + 2.5 * dayMs)
  expect(summary.ownerTrialComplete).toBe(false)
  expect(summary.periods.map(period => period.state)).toEqual([
    'recorded', 'missing', 'in-progress', 'upcoming', 'upcoming', 'upcoming', 'upcoming',
  ])
  expect(summary.periods[0]).toMatchObject({ from: '2026-11-16T19:14:00.000Z', observation: noActivity })
})

it('retains early stop observations and rejects a full record for an unfinished period', () => {
  const stopped = start.startedAt + dayMs / 2
  const dayOne = { ...noActivity, coverage: 'partial' as const, acceptedOutcomes: 1, avoidableInterruptions: 2,
    interventionSeconds: 60, incidents: ['Reminder appeared late'] }
  const summary = summarizeTrial(start, new Map([[1, dayOne]]), stopped + dayMs, stopped)
  expect(summary).toMatchObject({ state: 'incomplete', ownerTrialComplete: false,
    totals: { acceptedOutcomes: 1, avoidableInterruptions: 2, interventionSeconds: 60, incidents: 1 } })
  expect(summary.periods[0]?.state).toBe('partial')
  expect(summary.periods[1]?.state).toBe('outside-trial')
  expect(() => summarizeTrial(start, new Map([[1, noActivity]]), stopped + dayMs, stopped)).toThrow('Day 1 exceeds observed time')
})

it('requires seven full periods and an explicit stop and keeps rehearsals distinct', () => {
  const end = start.startedAt + dayMs * 7
  const rows = new Map(Array.from({ length: 7 }, (_, index) => [index + 1, noActivity]))
  expect(summarizeTrial(start, rows, end)).toMatchObject({ state: 'awaiting-stop', ownerTrialComplete: false })
  expect(summarizeTrial(start, rows, end, end)).toMatchObject({ state: 'complete', ownerTrialComplete: true })
  expect(summarizeTrial({ ...start, mode: 'rehearsal' }, rows, end, end)).toMatchObject({
    mode: 'rehearsal', state: 'complete', ownerTrialComplete: false,
  })
  rows.delete(4)
  expect(summarizeTrial(start, rows, end, end).state).toBe('incomplete')
})

it('binds the three selected packages to their archived checksums', () => {
  const repo = fileURLToPath(new URL('../../', import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-alpha-checksums-'))
  try {
    const names = ['personal-agent', 'plugin-api', 'model-routing'].map(pkg => packageArchive(pkg, repo, directory).path)
    const files = [...names, join(directory, 'LICENSE')]
    const original = Buffer.from('fixture')
    for (const path of files) writeFileSync(path, original)
    writeFileSync(join(directory, 'SHA256SUMS'), files.map(path =>
      `${sha256(original)}  ./${path.slice(directory.length + 1)}\n`).join(''))
    writeFileSync(join(directory, 'source-commit.txt'), 'a'.repeat(40))
    expect(readAlphaArchives(repo, directory).releaseSource).toBe('a'.repeat(40))
    writeFileSync(names[1]!, 'modified')
    expect(() => readAlphaArchives(repo, directory)).toThrow('Archive checksum mismatch')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
