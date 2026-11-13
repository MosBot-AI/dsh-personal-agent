import { execFile } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, onTestFinished } from 'vitest'

const run = promisify(execFile)
const dsh = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const profileName = 'dshpa-browser-tarball'

export async function installBrowserProfile(probe: string, patch: readonly string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshpa-browser-install-')))
  let prepared = false
  onTestFinished(() => { if (!prepared) rmSync(root, { recursive: true, force: true }) })
  const dshHome = join(root, 'home')
  const profile = join(dshHome, 'profiles', profileName)
  const archives = join(root, 'archives')
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || join(root, 'cache'),
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    PNPM_CONFIG_OFFLINE: process.env.PNPM_CONFIG_OFFLINE,
    PNPM_CONFIG_REGISTRY: process.env.PNPM_CONFIG_REGISTRY,
    PNPM_CONFIG_STORE_DIR: process.env.PNPM_CONFIG_STORE_DIR,
    npm_config_userconfig: process.env.npm_config_userconfig,
  }
  mkdirSync(archives)
  async function pack(directory: string) {
    const cwd = join(workspace, 'packages', directory)
    const { name, version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name: string; version: string }
    await run('pnpm', ['pack', '--pack-destination', archives], { cwd, env, timeout: 15_000 })
    return { name, spec: 'file:' + join(archives, `${name.slice(1).replace('/', '-')}-${version}.tgz`) }
  }
  const core = await pack('personal-agent')
  const browser = await pack('browser-chrome')
  const pluginApi = await pack('plugin-api')
  const routing = await pack('model-routing')
  await run(process.execPath, [dsh, '--profile', profileName, '--from-default-profile', 'web', '--dump-config'], {
    cwd: root, env, timeout: 20_000,
  })
  const settings = join(profile, 'pnpm-workspace.yaml')
  const defaults = readFileSync(settings, 'utf8')
  expect(defaults).toMatch(/^nodeLinker: hoisted$/m)
  expect(defaults).toMatch(/^autoInstallPeers: false$/m)
  // These workspace packages are unpublished. Resolve them from their archives while retaining DSH's peer policy.
  appendFileSync(settings, `
overrides:
  ${JSON.stringify(pluginApi.name)}: ${JSON.stringify(pluginApi.spec)}
  ${JSON.stringify(routing.name)}: ${JSON.stringify(routing.spec)}
allowBuilds:
  koffi: true
`)
  for (const bundle of [core, browser]) {
    try {
      await run(process.execPath, [dsh, 'plugin', '--profile', profileName, 'add', bundle.spec], {
        cwd: root, env, timeout: 80_000,
      })
    } catch (error) {
      const output = error instanceof Error && 'stdout' in error && 'stderr' in error
        ? [error.stdout, error.stderr].filter(value => typeof value === 'string') : []
      const logs = join(profile, '.plugin-manager', 'logs')
      if (existsSync(logs)) {
        for (const entry of readdirSync(logs)) {
          const log = join(logs, entry, 'pnpm.log')
          if (existsSync(log)) output.push(readFileSync(log, 'utf8'))
        }
      }
      const diagnostic = output.join('\n').split(/\r?\n/u).filter(line => /ERR_PNPM_|\bError:|\[ELIFECYCLE\]/u.test(line))
        .slice(-4).join('\n').replace(/https?:\/\/\S+/gu, '[registry URL]')
        .replace(/\b((?:proxy-)?authorization|_authToken|password|token)\b.*$/gimu, '$1 [redacted]')
      throw new Error(`DSH could not install ${bundle.name}${diagnostic ? '\n' + diagnostic : ''}`)
    }
    const manifest = join(profile, 'node_modules', bundle.name, 'package.json')
    expect(realpathSync(manifest)).toBe(manifest)
  }
  for (const peer of ['dsh-mcp-client', 'dsh-scope']) {
    expect(existsSync(join(profile, 'node_modules', '@deepseek-ai', peer))).toBe(false)
  }
  copyFileSync(probe, join(profile, 'web-flow-probe.mjs'))
  writeFileSync(join(profile, 'cordis.patch.yml'), [...patch,
    '- insert:', '    - id: web-flow-probe', '      name: ./web-flow-probe.mjs', '',
  ].join('\n'), { mode: 0o600 })
  prepared = true
  return { root, dshHome, profileName }
}
