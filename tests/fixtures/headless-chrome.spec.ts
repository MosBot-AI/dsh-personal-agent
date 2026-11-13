import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { rootCertificates } from 'node:tls'
import { afterEach, expect, it, vi } from 'vitest'
import { openHeadlessChrome } from '../e2e/fixtures/headless-chrome.js'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))

function startChrome() {
  const input = new PassThrough()
  const output = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, input, output],
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      child.signalCode = signal
      child.emit('exit')
      child.emit('close')
    },
  })
  const methods: string[] = []
  let replyToHandshake = false
  input.on('data', (chunk: Buffer) => {
    const { id, method } = JSON.parse(chunk.toString().slice(0, -1))
    methods.push(method)
    if (method === 'Browser.getVersion' && replyToHandshake) {
      output.write(JSON.stringify({ id, result: { userAgent: 'private-cdp-marker' } }) + '\0')
    }
  })
  spawn.mockReturnValue(child)
  return {
    child, output, methods,
    open(handshake = false) {
      replyToHandshake = handshake
      return openHeadlessChrome('fixture-chrome', 'private-profile-marker', Buffer.from(rootCertificates[0]!))
    },
  }
}

afterEach(() => vi.useRealTimers())

it('reports a startup timeout before attempting to create a target', async () => {
  vi.useFakeTimers()
  const fixture = startChrome()
  const rejection = expect(fixture.open()).rejects.toThrow(
    /startup \(Browser\.getVersion\): Timed out waiting for a reply.*first reply none/,
  )
  await vi.advanceTimersByTimeAsync(10_000)
  await rejection
  expect(fixture.methods).toEqual(['Browser.getVersion'])
})

it('keeps the ordinary command deadline after a successful handshake', async () => {
  vi.useFakeTimers()
  const fixture = startChrome()
  const result = fixture.open(true).catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(8_000)
  const error = await result
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toMatch(/command \(Target\.createTarget\): Timed out waiting for a reply.*first reply \d+ ms/)
  expect(message).not.toMatch(/private-(?:cdp|profile)-marker/)
  expect(fixture.methods).toEqual(['Browser.getVersion', 'Target.createTarget'])
})

it('reports premature exit with its status before the startup deadline', async () => {
  const fixture = startChrome()
  const rejection = expect(fixture.open()).rejects.toThrow(
    /startup \(Browser\.getVersion\): Chrome process exited.*exit code 17, signal none/,
  )
  fixture.child.exitCode = 17
  fixture.child.emit('exit')
  fixture.child.emit('close')
  await rejection
})

it('reports a closed DevTools pipe while the process remains alive', async () => {
  const fixture = startChrome()
  const rejection = expect(fixture.open()).rejects.toThrow(
    /startup \(Browser\.getVersion\): Chrome DevTools pipe closed.*exit code none, signal none/,
  )
  fixture.output.destroy()
  await rejection
})
