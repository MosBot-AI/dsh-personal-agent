import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const dsh = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const bundleSource = fileURLToPath(new URL('../../packages/personal-agent/', import.meta.url))
const profileName = 'dshpa-contract'
const bundleName = '@mosbot-ai/dshpa'
export const nativeProfileTimeoutMs = 15_000

export const nativeAgentRows = [
  'llm',
  'session',
  'session-projection',
  'system-prompt',
  'tools',
  'tool-executor-native',
  'agent',
  'agent-loop',
].flatMap(id => [`    - id: ${id}`, `      name: '@deepseek-ai/dsh-${id}'`])

export const nativeSessionPersistenceRows = [
  '    - id: session-persistence-jsonl',
  "      name: '@deepseek-ai/dsh-session-persistence-jsonl'",
  '      config:',
  "        root: !!js dshHomePath('sessions')",
]

interface NativeProfileOptions {
  probe: string
  patchRows: string[]
  trailingRows?: string[]
  requiredDshVersion?: string
}

export function createNativeProfile(options: NativeProfileOptions) {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-contract-'))
  const dshHome = join(directory, 'home')
  const profile = join(dshHome, 'profiles', profileName)
  const installedBundle = join(profile, 'node_modules', bundleName)
  const dispose = () => rmSync(directory, { recursive: true, force: true })

  try {
    mkdirSync(installedBundle, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(bundleSource, 'package.json'), 'utf8'))
    if (options.requiredDshVersion) manifest.engines.dsh = options.requiredDshVersion
    writeFileSync(join(installedBundle, 'package.json'), JSON.stringify(manifest))
    copyFileSync(join(bundleSource, 'cordis.patch.yml'), join(installedBundle, 'cordis.patch.yml'))
    cpSync(join(bundleSource, 'lib'), join(installedBundle, 'lib'), { recursive: true })
    copyFileSync(options.probe, join(profile, 'contract-probe.mjs'))

    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: profileName,
      private: true,
      dependencies: { [bundleName]: manifest.version },
      dsh: { profile: { bundles: [bundleName] } },
    }))
    writeFileSync(join(profile, 'cordis.patch.yml'), [
      '- insert:',
      ...options.patchRows,
      '    - id: contract-probe',
      '      name: ./contract-probe.mjs',
      ...(options.trailingRows ?? []),
      '',
    ].join('\n'))
  } catch (error) {
    dispose()
    throw error
  }

  return {
    run(phase?: string) {
      // The invocation directory and DSH home are isolated. Only system paths
      // and fixture settings enter the child, so provider credentials stay out.
      const result = spawnSync(process.execPath, [dsh, '--profile', profileName], {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: '1',
          DSHPA_CONTRACT_PHASE: phase,
        },
        encoding: 'utf8',
        timeout: nativeProfileTimeoutMs,
      })
      if (result.error) throw result.error
      return {
        stdout: result.stdout.trim(),
        stderr: result.stderr,
        status: result.status,
        signal: result.signal,
      }
    },
    dispose,
  }
}
