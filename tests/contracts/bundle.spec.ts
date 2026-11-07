import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const dsh = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const bundleSource = fileURLToPath(new URL('../../packages/personal-agent/', import.meta.url))
const probe = fileURLToPath(new URL('./fixtures/bundle-probe.mjs', import.meta.url))
const profileName = 'dshpa-contract'
const bundleName = '@mosbot-ai/dshpa'
const startupTimeoutMs = 15_000

function runProfile(scenario: 'normal' | 'missing-agents' | 'wrong-version') {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-contract-'))
  try {
    const dshHome = join(directory, 'home')
    const profile = join(dshHome, 'profiles', profileName)
    const installedBundle = join(profile, 'node_modules', bundleName)
    mkdirSync(installedBundle, { recursive: true })

    const manifest = JSON.parse(readFileSync(join(bundleSource, 'package.json'), 'utf8'))
    if (scenario === 'wrong-version') manifest.engines.dsh = '999.0.0'
    writeFileSync(join(installedBundle, 'package.json'), JSON.stringify(manifest))
    copyFileSync(join(bundleSource, 'cordis.patch.yml'), join(installedBundle, 'cordis.patch.yml'))
    cpSync(join(bundleSource, 'lib'), join(installedBundle, 'lib'), { recursive: true })
    copyFileSync(probe, join(profile, 'bundle-probe.mjs'))

    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: profileName,
      private: true,
      dependencies: { [bundleName]: manifest.version },
      dsh: { profile: { bundles: [bundleName] } },
    }))
    writeFileSync(join(profile, 'cordis.patch.yml'), [
      '- insert:',
      ...(scenario === 'missing-agents' ? [] : [
        '    - id: session-projection',
        "      name: '@deepseek-ai/dsh-session-projection'",
        '    - id: agent',
        "      name: '@deepseek-ai/dsh-agent'",
      ]),
      '    - id: bundle-probe',
      '      name: ./bundle-probe.mjs',
      '',
    ].join('\n'))

    // The temporary invocation directory and DSH home contain no .env files.
    // The child inherits only system paths, so provider credentials never reach it.
    const result = spawnSync(process.execPath, [dsh, '--profile', profileName], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        DSH_HOME: dshHome,
        DSH_TELEMETRY_DISABLED: '1',
      },
      encoding: 'utf8',
      timeout: startupTimeoutMs,
    })
    if (result.error) throw result.error
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    return { stdout: result.stdout.trim(), stderr: result.stderr }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('native dshpa profile', () => {
  it('mounts the built bundle and removes its service when the DSH Loader unloads it', () => {
    const result = runProfile('normal')
    expect(result.stdout).toBe('DSHPA_LOADED\nDSHPA_DISPOSED')
    expect(result.stderr).not.toContain('did not activate')
  }, startupTimeoutMs + 1_000)

  it('leaves the bundle inactive and diagnoses a missing agents service', () => {
    const result = runProfile('missing-agents')
    expect(result.stdout).toBe('DSHPA_ABSENT')
    expect(result.stderr).toMatch(/dshpa .*waiting for service: agents/)
  }, startupTimeoutMs + 1_000)

  it('rejects a plugin that requires an incompatible DSH version', () => {
    const result = runProfile('wrong-version')
    expect(result.stdout).toBe('DSHPA_ABSENT')
    expect(result.stderr).toContain('disabling profile plugin row "dshpa"')
    expect(result.stderr).toContain('incompatible with dsh 0.2.2-rc.1')
    expect(result.stderr).toContain('999.0.0')
  }, startupTimeoutMs + 1_000)
})
