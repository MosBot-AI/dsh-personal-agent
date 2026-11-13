import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { onTestFinished, vi } from 'vitest'

interface Reply {
  id?: number
  result?: unknown
  error?: unknown
}

const startupTimeoutMs = 10_000
const commandTimeoutMs = 8_000
const recoveryHandshakeTimeoutMs = 8_000
const shutdownGraceMs = 2_000
export const chromeStartupRetryAllowanceMs = recoveryHandshakeTimeoutMs + 2 * shutdownGraceMs

class ChromeStartupTimeout extends Error {}

function launchChrome(executable: string, profile: string, pin: string, handshakeTimeoutMs: number) {
  const startedAt = performance.now()
  const child = spawn(executable, [
    '--headless',
    // This disposable profile must not wait for a locked Linux desktop keyring.
    ...(process.platform === 'linux' ? ['--password-store=basic'] : []),
    '--remote-debugging-pipe', '--user-data-dir=' + profile,
    '--ignore-certificate-errors-spki-list=' + pin,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const input = child.stdio[3] as Writable | null
  const output = child.stdio[4] as Readable | null
  const waiting = new Map<number, (reason?: string, result?: unknown) => void>()
  let firstReplyMs: number | undefined
  let failure: string | undefined
  const stop = (reason: string) => {
    if (failure) return
    failure = reason
    for (const finish of waiting.values()) finish(reason)
  }
  const processExited = 'Chrome process exited'
  child.once('error', () => stop('Chrome process error'))
  child.once('exit', () => stop(processExited))
  let closed = false
  const close = new Promise<void>(resolve => child.once('close', () => {
    closed = true
    stop(processExited)
    resolve()
  }))
  const isRunning = () => child.exitCode === null && child.signalCode === null && child.pid !== undefined
  let disposal: Promise<void> | undefined
  function dispose() {
    return disposal ??= stopProcess()
  }
  async function stopProcess() {
    stop('Chrome test finished')
    if (isRunning()) child.kill('SIGTERM')
    input?.destroy()
    output?.destroy()
    if (closed) return
    const escalate = setTimeout(() => { if (isRunning()) child.kill('SIGKILL') }, shutdownGraceMs)
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([close, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Chrome process and pipes did not close after termination')),
          2 * shutdownGraceMs)
      })])
    } finally {
      clearTimeout(escalate)
      clearTimeout(deadline)
    }
  }
  // The caller already reports errors from cleanup it starts before retrying.
  onTestFinished(() => disposal ? disposal.catch(() => undefined) : dispose())
  assert.ok(input && output)
  const pipeError = () => stop('Chrome DevTools pipe error')
  input.on('error', pipeError)
  output.on('error', pipeError)
  let pipeEnded = false
  function pipeClosed() {
    pipeEnded = true
    input?.off('close', pipeClosed)
    output?.off('end', pipeClosed).off('close', pipeClosed)
    // Give an exiting child a chance to report its exit status before pipe EOF.
    setImmediate(() => stop(child.exitCode !== null || child.signalCode !== null
      ? processExited : 'Chrome DevTools pipe closed'))
  }
  output.once('end', pipeClosed)
  output.once('close', pipeClosed)
  input.once('close', pipeClosed)
  let data = ''
  output.setEncoding('utf8').on('data', chunk => {
    data += chunk
    let delimiter
    while ((delimiter = data.indexOf('\0')) !== -1) {
      const json = data.slice(0, delimiter)
      data = data.slice(delimiter + 1)
      let reply: Reply
      try { reply = JSON.parse(json) as Reply } catch { stop('Invalid Chrome DevTools reply'); return }
      const finish = reply?.id === undefined ? undefined : waiting.get(reply.id)
      if (!finish) continue
      firstReplyMs ??= Math.round(performance.now() - startedAt)
      finish(reply.error ? 'Chrome DevTools rejected the command' : undefined, reply.result)
    }
  })

  let next = 0
  function call<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const commandStartedAt = performance.now()
    const startup = method === 'Browser.getVersion'
    const commandError = (reason: string) =>
      `${startup ? 'Chrome DevTools startup' : 'Chrome DevTools command'} (${method}): ${reason}. ` +
      `Elapsed ${Math.round(performance.now() - commandStartedAt)} ms, first reply ${firstReplyMs === undefined ? 'none' : `${firstReplyMs} ms`}, ` +
      `exit code ${child.exitCode ?? 'none'}, signal ${child.signalCode ?? 'none'}.`
    const closedReason = () => isRunning() ? 'Chrome DevTools pipe closed' : processExited
    if (failure || pipeEnded) return Promise.reject(new Error(commandError(failure ?? closedReason())))
    const id = ++next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pipeEnded || !isRunning()) finish(closedReason())
        else finish('Timed out waiting for a reply', undefined, startup)
      }, startup ? handshakeTimeoutMs : commandTimeoutMs)
      function finish(reason?: string, result?: unknown, startupTimedOut = false) {
        clearTimeout(timer)
        waiting.delete(id)
        if (reason) {
          const message = commandError(reason)
          reject(startupTimedOut ? new ChromeStartupTimeout(message) : new Error(message))
        } else resolve(result as T)
      }
      waiting.set(id, finish)
      try {
        input!.write(JSON.stringify({ id, method, params, sessionId }) + '\0')
      } catch {
        finish('Chrome DevTools command could not be sent')
      }
    })
  }

  return { call, dispose }
}

export async function openHeadlessChrome(executable: string, profile: string, certificate: Buffer) {
  const key = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })
  const pin = createHash('sha256').update(key).digest('base64')
  let browser = launchChrome(executable, profile, pin, startupTimeoutMs)
  let testFinished = false
  onTestFinished(() => { testFinished = true })
  try {
    await browser.call('Browser.getVersion')
  } catch (error) {
    if (!(error instanceof ChromeStartupTimeout)) throw error
    process.stderr.write(`Initial Chrome startup attempt: ${error.message}\n`)
    await browser.dispose()
    if (testFinished) throw error
    browser = launchChrome(executable, `${profile}-retry-${randomUUID()}`, pin, recoveryHandshakeTimeoutMs)
    await browser.call('Browser.getVersion')
  }
  const { call } = browser
  const { targetId } = await call<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  const send = <T>(method: string, params?: object) => call<T>(method, params, sessionId)
  const evaluate = async <T>(expression: string): Promise<T> => {
    const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true })
    if (reply.exceptionDetails) throw new Error('The browser could not evaluate the test step')
    return reply.result.value
  }
  return {
    send, evaluate,
    async switchToAnotherTab() {
      const other = await call<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
      await call('Target.activateTarget', { targetId: other.targetId })
      return async () => {
        await call('Target.activateTarget', { targetId })
        await call('Target.closeTarget', { targetId: other.targetId })
      }
    },
    async waitFor(expression: string) {
      await vi.waitFor(async () => {
        if (!await evaluate<boolean>(expression)) throw new Error('The browser state did not match the test step')
      }, { timeout: 9_000, interval: 100 })
    },
  }
}
