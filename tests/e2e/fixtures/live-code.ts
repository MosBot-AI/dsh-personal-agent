import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'

const implementation = 'export function averageReadings(readings) {\n  const valid = readings.filter(Boolean)\n  if (valid.length === 0) return null\n  return valid.reduce((sum, reading) => sum + reading, 0) / valid.length\n}\n'
const tests = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { averageReadings } from './readings.mjs'

test('averages ordinary readings', () => assert.equal(averageReadings([4, 8]), 6))
test('keeps zero readings', () => assert.equal(averageReadings([0, 10]), 5))
test('omits missing readings', () => assert.equal(averageReadings([null, 6, undefined]), 6))
test('returns null for all missing readings', () => assert.equal(averageReadings([null, undefined]), null))
`
const notes = '# Reading summary fixture\n'

export function prepareLiveCode(directory: string) {
  mkdirSync(directory, { mode: 0o700 })
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, env, encoding: 'utf8', timeout: 5_000 })
  const runTests = () => spawnSync('bwrap', [
    '--unshare-all', '--die-with-parent', '--clearenv', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/usr/lib', '/usr/lib', '--ro-bind', process.execPath, '/node', '--dev', '/dev',
    '--ro-bind', directory, '/fixture', '--chdir', '/fixture',
    '/node', '--permission', '--allow-fs-read=/fixture', '--test', '--test-isolation=none', '--test-reporter=tap', 'readings.test.mjs',
  ], { cwd: directory, env, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 })

  writeFileSync(join(directory, 'readings.mjs'), implementation, { mode: 0o600 })
  writeFileSync(join(directory, 'readings.test.mjs'), tests, { mode: 0o600 })
  writeFileSync(join(directory, 'README.md'), notes, { mode: 0o600 })
  git('init', '--quiet', '--template=')
  git('add', '--', 'readings.mjs', 'readings.test.mjs', 'README.md')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Seed reading summary')
  const baseline = runTests()
  expect(baseline.error).toBeUndefined()
  expect(baseline.stderr).toBe('')
  expect(baseline.status).toBe(1)
  expect(baseline.stdout).toContain('not ok 2 - keeps zero readings')
  expect(baseline.stdout).toMatch(/# pass 3\n# fail 1/u)

  return {
    outcome: [
      'Fix this fictional reading summary. A zero is a valid reading. Null and undefined are missing.',
      'Keep averaging valid readings, and return null if all readings are missing. For [0, 10] return 5.',
      'Change only readings.mjs. Return kind ready with empty artifactIds. Put the complete unified diff in the JSON summary string.',
      'Start the patch with --- a/readings.mjs and +++ b/readings.mjs. Use a valid @@ hunk with context. Do not add explanation or a code fence.',
      'Here is the complete source:', implementation,
    ].join('\n'),
    verifyProposal(text: string) {
      expect(git('status', '--porcelain')).toBe('')
      const diff = text.trim().replace(/^```(?:diff|patch)?\n([\s\S]+)\n```$/u, '$1')
      const lines = diff.split('\n')
      if (lines[0] === 'diff --git a/readings.mjs b/readings.mjs') lines.shift()
      expect(lines.slice(0, 2)).toEqual(['--- a/readings.mjs', '+++ b/readings.mjs'])
      expect(lines[2]).toMatch(/^@@ /u)
      expect(lines.slice(2).filter(line => /^(?:diff --git |--- |\+\+\+ )/u.test(line))).toEqual([])
      const patch = join(dirname(directory), 'proposed-readings.patch')
      writeFileSync(patch, lines.join('\n') + '\n', { mode: 0o600 })
      expect(git('apply', '--numstat', patch)).toMatch(/^\d+\t\d+\treadings\.mjs\n$/u)
      git('apply', '--check', patch)
      git('apply', patch)
      expect(git('status', '--porcelain')).toBe(' M readings.mjs\n')
      expect(readFileSync(join(directory, 'readings.test.mjs'), 'utf8')).toBe(tests)
      expect(readFileSync(join(directory, 'README.md'), 'utf8')).toBe(notes)
      git('diff', '--check')
      const result = runTests()
      expect(result.error).toBeUndefined()
      expect(result.stderr).toBe('')
      expect(result.status, result.stdout).toBe(0)
      expect(result.stdout).toMatch(/# pass 4\n# fail 0/u)
    },
  }
}
