// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from 'vitest'
import { mobilePage, mobileScript } from '../../packages/personal-agent/src/client/mobile-page.js'

class TestEventSource extends EventTarget {
  onerror?: () => void
  closed = false

  close() { this.closed = true }

  emit(name: string) { this.dispatchEvent(new Event(name)) }
}

async function mountMobile() {
  vi.useFakeTimers()
  const page = new DOMParser().parseFromString(mobilePage(false), 'text/html')
  const pageEvents = new EventTarget()
  let hidden = false
  let outcome = 'Original task'
  let latency = 0
  let aborted = 0
  Object.defineProperty(page, 'hidden', { get: () => hidden })

  const streams: TestEventSource[] = []
  class FixtureEventSource extends TestEventSource {
    constructor() {
      super()
      streams.push(this)
    }
  }

  const fetch = vi.fn((path: string, { signal }: { signal: AbortSignal }) => {
    const body = path === '/v1/snapshot'
      ? { cursor: 'snapshot-cursor', tasks: [{ outcome, status: 'running' }] }
      : { approvals: [{ id: 'review', kind: 'Test review', dataScope: [], preview: 'Private review', expiresAt: '2099-01-01T00:00:00Z' }] }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve({ ok: true, status: 200, json: async () => body })
      }, latency)
      function onAbort() {
        aborted++
        clearTimeout(timer)
        reject(new DOMException('Request aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  })

  onTestFinished(() => {
    pageEvents.dispatchEvent(new Event('pagehide'))
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  // Execute the delivered script against real DOM nodes with controlled transport and time.
  new Function('document', 'window', 'fetch', 'EventSource', mobileScript)(page, pageEvents, fetch, FixtureEventSource)
  await vi.advanceTimersByTimeAsync(0)

  return {
    page, streams, fetch,
    task: () => page.querySelector('#tasks p')?.textContent,
    status: () => page.querySelector('#status')?.textContent,
    aborted: () => aborted,
    update(nextOutcome: string, delay = 0) { outcome = nextOutcome; latency = delay },
    hide() { hidden = true; page.dispatchEvent(new Event('visibilitychange')) },
  }
}

it('renders a slow refresh during an SSE burst and discards a queued refresh when hidden', async () => {
  const mobile = await mountMobile()
  expect(mobile.task()).toBe('Original task')
  mobile.update('Updated task', 1_250)
  const stream = mobile.streams[0]!
  stream.emit('work')
  await vi.advanceTimersByTimeAsync(1_000)
  stream.emit('work')
  await vi.advanceTimersByTimeAsync(100)
  stream.emit('approvals')
  await vi.advanceTimersByTimeAsync(400)

  expect(mobile.task()).toBe('Updated task')
  expect(mobile.fetch).toHaveBeenCalledTimes(6)
  expect(mobile.aborted()).toBe(0)
  expect(mobile.page.querySelector('#review-items pre')?.textContent).toBe('Private review')

  stream.emit('work')
  await vi.advanceTimersByTimeAsync(100)
  mobile.hide()
  expect(stream.closed).toBe(true)
  expect(mobile.aborted()).toBe(2)
  expect(mobile.task()).toBeUndefined()
  expect(mobile.page.querySelector('#review-items')?.children).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(mobile.fetch).toHaveBeenCalledTimes(6)
  expect(mobile.task()).toBeUndefined()
})

it('refreshes on the new SSE stream after reconnect and ignores the closed stream', async () => {
  const mobile = await mountMobile()
  const old = mobile.streams[0]!
  old.onerror!()
  expect(old.closed).toBe(true)
  expect(mobile.task()).toBeUndefined()
  expect(mobile.status()).toBe('Reconnecting…')

  mobile.update('Reconnected task')
  await vi.advanceTimersByTimeAsync(1_501)
  expect(mobile.task()).toBe('Reconnected task')
  expect(mobile.streams).toHaveLength(2)
  expect(mobile.fetch).toHaveBeenCalledTimes(4)

  mobile.update('New task')
  old.emit('work')
  await vi.advanceTimersByTimeAsync(100)
  expect(mobile.fetch).toHaveBeenCalledTimes(4)
  const current = mobile.streams[1]!
  current.emit('work')
  current.emit('approvals')
  await vi.advanceTimersByTimeAsync(100)
  expect(mobile.task()).toBe('New task')
  expect(mobile.fetch).toHaveBeenCalledTimes(6)
  expect(mobile.status()).toBe('Connected')
})

it('aborts a stalled snapshot and approval refresh, then reconnects and reads fresh work', async () => {
  const mobile = await mountMobile()
  const stalledStream = mobile.streams[0]!
  mobile.update('Stalled task', 60_000)
  stalledStream.emit('work')
  await vi.advanceTimersByTimeAsync(75)
  expect(mobile.fetch).toHaveBeenCalledTimes(4)

  mobile.update('Recovered task')
  stalledStream.emit('approvals')
  await vi.advanceTimersByTimeAsync(9_999)
  expect(mobile.task()).toBe('Original task')
  expect(mobile.aborted()).toBe(0)

  await vi.advanceTimersByTimeAsync(1)
  expect(mobile.aborted()).toBe(2)
  expect(stalledStream.closed).toBe(true)
  expect(mobile.task()).toBeUndefined()
  expect(mobile.page.querySelector('#review-items')?.children).toHaveLength(0)
  expect(mobile.status()).toBe('Reconnecting…')

  await vi.advanceTimersByTimeAsync(1_501)
  expect(mobile.task()).toBe('Recovered task')
  expect(mobile.status()).toBe('Connected')
  expect(mobile.streams).toHaveLength(2)
  expect(mobile.fetch).toHaveBeenCalledTimes(6)
})
