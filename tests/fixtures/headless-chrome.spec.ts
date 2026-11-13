import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { rootCertificates } from 'node:tls'
import { afterEach, expect, it, vi } from 'vitest'
import { openHeadlessChrome } from '../e2e/fixtures/headless-chrome.js'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))

function fakeChrome(options: { replies?: Record<string, { result?: unknown; error?: unknown }>; delayClose?: boolean } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, input, output],
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      if (!options.delayClose) exit(null, signal)
    }),
  })
  function exit(code: number | null, signal: NodeJS.Signals | null = null) {
    child.exitCode = code
    child.signalCode = signal
    child.emit('exit')
    if (!options.delayClose) child.emit('close')
  }
  const methods: string[] = []
  input.on('data', (chunk: Buffer) => {
    const { id, method } = JSON.parse(chunk.toString().slice(0, -1))
    methods.push(method)
    const reply = options.replies?.[method]
    if (reply) output.write(JSON.stringify({ id, ...reply }) + '\0')
  })
  spawn.mockReturnValueOnce(child)
  return { child, exit, input, output, methods }
}

const handshake = { result: { userAgent: 'private-cdp-marker' } }
const open = () => openHeadlessChrome('fixture-chrome', 'private-profile-marker', Buffer.from(rootCertificates[0]!))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  spawn.mockReset()
})

it('retries startup once in a fresh profile after the old process and pipes close', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const first = fakeChrome({ delayClose: true })
  const second = fakeChrome({ replies: {
    'Browser.getVersion': handshake,
    'Target.createTarget': { result: { targetId: 'fixture-target' } },
    'Target.attachToTarget': { result: { sessionId: 'fixture-session' } },
  } })
  const pending = open()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(first.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  expect(first.input.destroyed && first.output.destroyed).toBe(true)
  expect(spawn).toHaveBeenCalledTimes(1)
  first.exit(null, 'SIGTERM')
  await vi.advanceTimersByTimeAsync(0)
  expect(spawn).toHaveBeenCalledTimes(1)
  first.child.emit('close')
  await pending
  expect(spawn).toHaveBeenCalledTimes(2)
  const profileArg = (index: number) => (spawn.mock.calls[index]?.[1] as string[])
    .find(arg => arg.startsWith('--user-data-dir='))
  expect(profileArg(0)).toBe('--user-data-dir=private-profile-marker')
  expect(profileArg(1)).toMatch(/^--user-data-dir=private-profile-marker-retry-[a-f0-9-]+$/)
  expect(first.methods).toEqual(['Browser.getVersion'])
  expect(second.methods).toEqual(['Browser.getVersion', 'Target.createTarget', 'Target.attachToTarget'])
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/Initial Chrome startup attempt: .*first reply none/))
  expect(warn.mock.calls[0]?.[0]).not.toContain('private-profile-marker')
})

it('reports persistent handshake stalls without a third attempt', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const first = fakeChrome()
  const second = fakeChrome()
  const rejection = expect(open()).rejects.toThrow(/startup \(Browser\.getVersion\): Timed out waiting for a reply/)
  await vi.advanceTimersByTimeAsync(18_000)
  await rejection
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(first.methods).toEqual(['Browser.getVersion'])
  expect(second.methods).toEqual(['Browser.getVersion'])
  expect(warn).toHaveBeenCalledTimes(1)
})

it('fails without restarting when the first process does not close after termination', async () => {
  vi.useFakeTimers()
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const first = fakeChrome({ delayClose: true })
  const rejection = expect(open()).rejects.toThrow('Chrome process and pipes did not close after termination')
  await vi.advanceTimersByTimeAsync(14_000)
  await rejection
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(first.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  first.exit(null, 'SIGKILL')
  first.child.emit('close')
})

it('keeps the ordinary command deadline after a successful handshake', async () => {
  vi.useFakeTimers()
  const fixture = fakeChrome({ replies: { 'Browser.getVersion': handshake } })
  const result = open().catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(8_000)
  const error = await result
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toMatch(/command \(Target\.createTarget\): Timed out waiting for a reply.*first reply \d+ ms/)
  expect(message).not.toMatch(/private-(?:cdp|profile)-marker/)
  expect(fixture.methods).toEqual(['Browser.getVersion', 'Target.createTarget'])
  expect(spawn).toHaveBeenCalledTimes(1)
})

it('reports premature exit with its status before the startup deadline', async () => {
  const fixture = fakeChrome()
  const rejection = expect(open()).rejects.toThrow(
    /startup \(Browser\.getVersion\): Chrome process exited.*exit code 17, signal none/,
  )
  fixture.exit(17)
  await rejection
  expect(spawn).toHaveBeenCalledTimes(1)
})

it.each(['input', 'output'] as const)('reports a closed DevTools %s pipe while the process remains alive', async pipe => {
  const fixture = fakeChrome()
  const rejection = expect(open()).rejects.toThrow(
    /startup \(Browser\.getVersion\): Chrome DevTools pipe closed.*exit code none, signal none/,
  )
  fixture[pipe].destroy()
  await rejection
  expect(spawn).toHaveBeenCalledTimes(1)
})

it('does not retry an explicit handshake rejection or print its payload', async () => {
  fakeChrome({ replies: { 'Browser.getVersion': { error: { message: 'private-rejection-marker' } } } })
  const result = await open().catch((error: Error) => error)
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toContain('Chrome DevTools rejected the command')
  expect((result as Error).message).not.toContain('private-rejection-marker')
  expect(spawn).toHaveBeenCalledTimes(1)
})
