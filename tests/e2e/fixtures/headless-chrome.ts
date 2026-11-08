import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { onTestFinished, vi } from 'vitest'

interface Reply {
  id?: number
  result?: unknown
  error?: unknown
}

export async function openHeadlessChrome(executable: string, profile: string, certificate: Buffer) {
  const key = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })
  const pin = createHash('sha256').update(key).digest('base64')
  const child = spawn(executable, [
    '--headless', '--remote-debugging-pipe', '--user-data-dir=' + profile,
    '--ignore-certificate-errors-spki-list=' + pin,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const input = child.stdio[3] as Writable | null
  const output = child.stdio[4] as Readable | null
  const waiting = new Map<number, { finish: (error?: Error, result?: unknown) => void }>()
  let failure: Error | undefined
  const stop = (error: Error) => {
    failure = error
    for (const request of waiting.values()) request.finish(error)
  }
  child.once('error', error => stop(error))
  const exited = new Promise<void>(resolve => child.once('close', () => {
    stop(new Error('The isolated Chrome process closed'))
    resolve()
  }))
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) child.kill('SIGKILL')
    }, 2_000)
    try { await exited } finally { clearTimeout(timer) }
  })
  assert.ok(input && output)
  const sendError = () => stop(new Error('Chrome DevTools pipe failed'))
  input.on('error', sendError)
  output.on('error', sendError)
  let data = ''
  output.setEncoding('utf8').on('data', chunk => {
    data += chunk
    let delimiter
    while ((delimiter = data.indexOf('\0')) !== -1) {
      const json = data.slice(0, delimiter)
      data = data.slice(delimiter + 1)
      let reply: Reply
      try { reply = JSON.parse(json) as Reply } catch { sendError(); return }
      if (reply.id === undefined) continue
      waiting.get(reply.id)?.finish(reply.error ? new Error('Chrome DevTools command failed') : undefined, reply.result)
    }
  })

  let next = 0
  function call<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (failure) return Promise.reject(failure)
    const id = ++next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Chrome did not respond to ' + method)), 8_000)
      function finish(error?: Error, result?: unknown) {
        clearTimeout(timer)
        waiting.delete(id)
        if (error) reject(error)
        else resolve(result as T)
      }
      waiting.set(id, { finish })
      input!.write(JSON.stringify({ id, method, params, sessionId }) + '\0')
    })
  }

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
    async waitFor(expression: string) {
      await vi.waitFor(async () => {
        if (!await evaluate<boolean>(expression)) throw new Error('The browser state did not match the test step')
      }, { timeout: 9_000, interval: 100 })
    },
  }
}
