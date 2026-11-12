import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
const personalAgent = join(workspace, 'packages', 'personal-agent')

it('builds the same Web client in different checkout layouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshpa-client-build-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))

  function buildClient(checkout: string): string {
    const stagedPackage = join(checkout, 'packages', 'personal-agent')
    const scripts = join(stagedPackage, 'scripts')
    mkdirSync(scripts, { recursive: true })
    for (const name of ['src', 'locale', 'package.json', 'tsconfig.json']) {
      cpSync(join(personalAgent, name), join(stagedPackage, name), { recursive: true })
    }
    cpSync(join(workspace, 'tsconfig.json'), join(checkout, 'tsconfig.json'))
    const build = join(scripts, 'build-client.mjs')
    cpSync(join(personalAgent, 'scripts', 'build-client.mjs'), build)
    symlinkSync(join(workspace, 'node_modules'), join(checkout, 'node_modules'), 'junction')
    execFileSync(process.execPath, [build], { cwd: stagedPackage, timeout: 10_000 })
    const client = readFileSync(join(stagedPackage, 'lib', 'client.js'))
    return createHash('sha256').update(client).digest('hex')
  }

  expect(buildClient(join(root, 'checkout'))).toBe(buildClient(join(root, 'nested', 'checkout')))
}, 25_000)
