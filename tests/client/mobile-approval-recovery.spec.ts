// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from 'vitest'
import { mobilePage, mobileScript } from '../../packages/personal-agent/src/client/mobile-page.js'

class TestStream extends EventTarget {
  onerror?: () => void
  closed = false

  close() { this.closed = true }
  emit(name: string) { this.dispatchEvent(new Event(name)) }
}

const reviewPath = '/v1/approvals/fixture-review/responses'
const response = (status: number, body: object = {}) => ({ status, ok: status === 200, json: async () => body })

async function mountMobile({ ignorePostAbort = false } = {}) {
  vi.useFakeTimers()
  const page = new DOMParser().parseFromString(mobilePage(false), 'text/html')
  const pageEvents = new EventTarget()
  Object.defineProperty(page, 'hidden', { value: false })

  let version = 1
  let pendingReview = true
  const streams: TestStream[] = []
  const posts: { request: RequestInit; reply: (status: number) => void }[] = []
  class FixtureStream extends TestStream {
    constructor() {
      super()
      streams.push(this)
    }
  }
  const fetch = vi.fn((path: string, request: RequestInit = {}) => {
    if (path === '/v1/pair') return Promise.resolve(response(200))
    if (path === '/v1/snapshot') return Promise.resolve(response(200, {
      cursor: 'fixture-cursor', tasks: [{ outcome: 'Fixture task', status: 'running' }],
    }))
    if (path === '/v1/approvals') return Promise.resolve(response(200, {
      approvals: pendingReview ? [{
        id: 'fixture-review', kind: 'Fixture review', version, digest: 'fixture-digest',
        dataScope: [], preview: 'Exact review version ' + version, expiresAt: '2099-01-01T00:00:00Z',
      }] : [],
    }))
    if (path !== reviewPath) throw new Error('Unexpected request: ' + path)
    return new Promise<ReturnType<typeof response>>((resolve, reject) => {
      posts.push({ request, reply: status => resolve(response(status)) })
      const { signal } = request
      if (!ignorePostAbort) signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })

  onTestFinished(() => {
    pageEvents.dispatchEvent(new Event('pagehide'))
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  new Function('document', 'window', 'fetch', 'EventSource', mobileScript)(page, pageEvents, fetch, FixtureStream)
  await vi.advanceTimersByTimeAsync(0)
  return {
    fetch, posts, streams,
    buttons: () => Array.from(page.querySelectorAll<HTMLButtonElement>('.review-actions button')),
    review: () => page.querySelector('#review-items pre')?.textContent,
    reviewStatus: () => page.querySelector('#review-status')!.textContent,
    showingPairing: () => !page.querySelector<HTMLFormElement>('#pair')!.hidden,
    workVisible: () => !page.querySelector<HTMLElement>('#work')!.hidden,
    reviseReview() { version++ },
    resolveReview() { pendingReview = false },
    async pairAgain() {
      page.querySelector<HTMLInputElement>('#code')!.value = 'fixture-pairing'
      page.querySelector('#pair')!.dispatchEvent(new Event('submit', { cancelable: true }))
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

it('bounds a stalled approval response and reads current review data without resending the decision', async () => {
  const mobile = await mountMobile()
  const approve = mobile.buttons()[0]!
  approve.click()
  expect(mobile.buttons().map(button => button.disabled)).toEqual([true, true])
  expect(mobile.posts).toHaveLength(1)
  expect(mobile.posts[0]!.request.method).toBe('POST')
  expect(JSON.parse(String(mobile.posts[0]!.request.body))).toEqual({
    expectedVersion: 1, digest: 'fixture-digest', decision: 'approve',
  })

  mobile.reviseReview()
  await vi.advanceTimersByTimeAsync(9_999)
  expect(mobile.review()).toBe('Exact review version 1')
  expect(mobile.buttons().map(button => button.disabled)).toEqual([true, true])
  await vi.advanceTimersByTimeAsync(1)

  expect(mobile.posts[0]!.request.signal?.aborted).toBe(true)
  expect(mobile.reviewStatus()).toBe('Could not confirm the response. Check the refreshed review.')
  expect(mobile.fetch.mock.calls.filter(([path]) => path === '/v1/approvals')).toHaveLength(2)
  expect(mobile.review()).toBe('Exact review version 2')
  expect(mobile.buttons().map(button => button.disabled)).toEqual([false, false])
  expect(mobile.posts).toHaveLength(1)
})

it('keeps the replacement session and its in-flight review when an old response returns 401', async () => {
  const mobile = await mountMobile({ ignorePostAbort: true })
  mobile.buttons()[0]!.click()
  const oldStream = mobile.streams[0]!
  oldStream.emit('session-ended')
  expect(oldStream.closed).toBe(true)
  expect(mobile.showingPairing()).toBe(true)

  mobile.reviseReview()
  await mobile.pairAgain()
  expect(mobile.workVisible()).toBe(true)
  expect(mobile.review()).toBe('Exact review version 2')
  const replacement = mobile.streams[1]!
  mobile.buttons()[0]!.click()
  expect(mobile.posts).toHaveLength(2)
  expect(mobile.posts[0]!.request.signal?.aborted).toBe(true)

  mobile.posts[0]!.reply(401)
  await vi.advanceTimersByTimeAsync(0)
  expect(mobile.showingPairing()).toBe(false)
  expect(mobile.workVisible()).toBe(true)
  expect(replacement.closed).toBe(false)
  expect(mobile.reviewStatus()).toBe('')

  replacement.emit('approvals')
  await vi.advanceTimersByTimeAsync(75)
  expect(mobile.buttons().map(button => button.disabled)).toEqual([true, true])
  expect(mobile.posts[1]!.request.signal?.aborted).toBe(false)

  mobile.resolveReview()
  mobile.posts[1]!.reply(200)
  await vi.advanceTimersByTimeAsync(0)
  expect(mobile.reviewStatus()).toBe('Review response recorded.')
  expect(mobile.buttons()).toHaveLength(0)
  expect(mobile.posts).toHaveLength(2)
})

it('keeps a pending approval response across same-session stream recovery', async () => {
  const mobile = await mountMobile()
  mobile.buttons()[0]!.click()
  const post = mobile.posts[0]!

  mobile.streams[0]!.onerror!()
  expect(mobile.streams[0]!.closed).toBe(true)
  await vi.advanceTimersByTimeAsync(1_500)
  expect(mobile.workVisible()).toBe(true)
  expect(mobile.showingPairing()).toBe(false)
  expect(post.request.signal?.aborted).not.toBe(true)
  expect(mobile.buttons().map(button => button.disabled)).toEqual([true, true])

  mobile.streams[1]!.emit('snapshot-required')
  await vi.advanceTimersByTimeAsync(0)
  expect(mobile.streams[1]!.closed).toBe(true)
  expect(mobile.workVisible()).toBe(true)
  expect(post.request.signal?.aborted).not.toBe(true)
  expect(mobile.buttons().map(button => button.disabled)).toEqual([true, true])

  mobile.resolveReview()
  post.reply(200)
  await vi.advanceTimersByTimeAsync(0)
  expect(mobile.reviewStatus()).toBe('Review response recorded.')
  expect(mobile.buttons()).toHaveLength(0)
  expect(mobile.posts).toHaveLength(1)
})

it('shows pairing when the current approval response returns 401', async () => {
  const mobile = await mountMobile()
  mobile.buttons()[0]!.click()
  mobile.posts[0]!.reply(401)
  await vi.advanceTimersByTimeAsync(0)

  expect(mobile.showingPairing()).toBe(true)
  expect(mobile.workVisible()).toBe(false)
  expect(mobile.streams[0]!.closed).toBe(true)
})
