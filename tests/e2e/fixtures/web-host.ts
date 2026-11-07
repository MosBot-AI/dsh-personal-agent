import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { onTestFinished } from 'vitest'

const require = createRequire(import.meta.url)
const dsh = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const bundleSource = fileURLToPath(new URL('../../../packages/personal-agent/', import.meta.url))
const bundleName = '@mosbot-ai/dshpa'
const profileName = 'dshpa-web-flow'
const startupTimeoutMs = 20_000
const responseTimeoutMs = 8_000

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

function redact(line: string): string {
  return line.replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1?[redacted]')
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 2_000)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}

export async function openWebHost(probe: string, options: { patch?: readonly string[]; configOnly?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dshpa-web-flow-'))
  const dshHome = join(root, 'home')
  const profile = join(dshHome, 'profiles', profileName)
  const installed = join(profile, 'node_modules', bundleName)
  let child: ChildProcessWithoutNullStreams | undefined
  onTestFinished(async () => {
    try {
      if (child) await stop(child)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  mkdirSync(installed, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(bundleSource, 'package.json'), 'utf8')) as { version: string }
  for (const file of ['package.json', 'cordis.patch.yml']) {
    copyFileSync(join(bundleSource, file), join(installed, file))
  }
  for (const directory of ['lib', 'locale']) {
    cpSync(join(bundleSource, directory), join(installed, directory), { recursive: true })
  }
  symlinkSync(join(bundleSource, 'node_modules'), join(installed, 'node_modules'), 'junction')
  copyFileSync(probe, join(profile, 'web-flow-probe.mjs'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: profileName,
    private: true,
    dependencies: { [bundleName]: manifest.version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', bundleName] } },
  }))
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    ...(options.patch ?? []),
    '- insert:',
    '    - id: web-flow-probe',
    '      name: ./web-flow-probe.mjs',
    '',
  ].join('\n'))

  const processHandle = spawn(process.execPath, [dsh, '--profile', profileName, '--no-open', '--port', '0'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      DSHPA_WEB_FLOW_CONFIG_ONLY: options.configOnly ? '1' : undefined,
    },
  })
  child = processHandle
  processHandle.stdin.end()
  const output = createInterface({ input: processHandle.stdout })
  const diagnostics = createInterface({ input: processHandle.stderr })
  let recentDiagnostics = ''
  diagnostics.on('line', line => { recentDiagnostics = (recentDiagnostics + redact(line) + '\n').slice(-6_000) })

  const launchUrl = await new Promise<URL>((resolve, reject) => {
    let ready = false
    let launch: URL | undefined
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the native DSH Web host')), startupTimeoutMs)
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null) => finish(new Error(`Native DSH Web host exited with ${code}`))
    const onLine = (line: string) => {
      const address = /^dsh web: (http:\/\/127\.0\.0\.1:[0-9]+\/\?\S+)$/u.exec(line)?.[1]
      if (address) launch = new URL(address)
      if (line === 'DSHPA_WEB_FLOW_READY') ready = true
      if (launch && ready) finish(undefined, launch)
    }
    function finish(error?: Error, value?: URL) {
      clearTimeout(timer)
      processHandle.off('error', onError)
      processHandle.off('exit', onExit)
      output.off('line', onLine)
      if (value) resolve(value)
      else reject(new Error(`${redact(error?.message ?? 'Invalid native DSH Web readiness')}\n${recentDiagnostics}`))
    }
    processHandle.once('error', onError)
    processHandle.once('exit', onExit)
    output.on('line', onLine)
  })
  const origin = launchUrl.origin

  async function exchange(operator = false): Promise<string> {
    const url = new URL(launchUrl)
    if (operator) url.pathname = '/connect'
    // Keep the fixture launch token and cookies inside the harness. Redirects
    // are handled explicitly to avoid credential-bearing error messages.
    let response: Response
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(responseTimeoutMs) })
    } catch {
      throw new Error('Native Web authentication exchange failed')
    }
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
    if (response.status !== (operator ? 302 : 303) || !cookie) {
      throw new Error(`Native Web authentication returned HTTP ${response.status}`)
    }
    await response.body?.cancel()
    return cookie
  }

  function get(path: string, cookie?: string): Promise<Response> {
    const url = new URL(path, origin)
    if (url.origin !== origin) throw new Error('Fixture request must remain on the native local host')
    return fetch(url, { headers: cookie ? { cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(responseTimeoutMs) })
  }

  async function rpc<T>(method: string, payload: unknown, cookie?: string, claimedOrigin?: string) {
    const rpcId = randomUUID()
    let response: Response
    try {
      response = await fetch(new URL(`/api/${method}`, origin), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie === undefined ? {} : { cookie }),
          ...(claimedOrigin === undefined ? {} : { origin: claimedOrigin }),
        },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        redirect: 'manual',
        signal: AbortSignal.timeout(responseTimeoutMs),
      })
    } catch (error) {
      throw new Error(`Native Web RPC ${method} failed\n${recentDiagnostics}`, { cause: error })
    }
    if (!response.ok) {
      await response.body?.cancel()
      return { status: response.status, result: undefined }
    }
    const message = await response.json() as { type: string; rpcId: string; result: Result<T> }
    if (message.type !== 'server-response' || message.rpcId !== rpcId) throw new Error('Invalid native RPC envelope')
    return { status: response.status, result: message.result }
  }

  return { root, get, exchange, rpc, diagnostics: () => recentDiagnostics }
}
