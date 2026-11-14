// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from 'vitest'
import { mobilePage, mobileScript } from '../../packages/personal-agent/src/client/mobile-page.js'

async function mountMobile() {
  vi.useFakeTimers()
  const page = new DOMParser().parseFromString(mobilePage(false), 'text/html')
  const pageEvents = new EventTarget()
  let hidden = false
  let enrolled = false
  let holdSessionReads = false
  Object.defineProperty(page, 'hidden', { get: () => hidden })
  const form = page.querySelector<HTMLFormElement>('#pair')!
  const code = page.querySelector<HTMLInputElement>('#code')!
  const button = form.querySelector('button')!
  const posts: { request: RequestInit; reply: (status: number) => void }[] = []
  const heldReads: RequestInit[] = []
  const response = (status: number, body: object = {}) => ({ status, ok: status === 200, json: async () => body })
  const fetch = vi.fn((path: string, request: RequestInit) => {
    if (path === '/v1/pair') {
      // Allow a late response after cancellation to verify that retired callbacks do nothing.
      return new Promise<ReturnType<typeof response>>(resolve => posts.push({ request, reply: status => resolve(response(status)) }))
    }
    if (holdSessionReads && (path === '/v1/snapshot' || path === '/v1/approvals')) {
      heldReads.push(request)
      return new Promise<ReturnType<typeof response>>(() => {})
    }
    if (path === '/v1/snapshot') return Promise.resolve(response(enrolled ? 200 : 401, {
      cursor: null, tasks: [{ outcome: 'Enrolled task', status: 'running' }],
    }))
    if (path === '/v1/approvals') return Promise.resolve(response(enrolled ? 200 : 401, { approvals: [] }))
    throw new Error('Unexpected request: ' + path)
  })
  class FixtureStream extends EventTarget {
    close() {}
  }
  onTestFinished(() => {
    pageEvents.dispatchEvent(new Event('pagehide'))
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  new Function('document', 'window', 'fetch', 'EventSource', mobileScript)(page, pageEvents, fetch, FixtureStream)
  await vi.advanceTimersByTimeAsync(0)
  return {
    form, button, posts, heldReads,
    status: () => page.querySelector('#status')?.textContent,
    task: () => page.querySelector('#tasks p')?.textContent,
    submit(value: string) {
      code.value = value
      form.dispatchEvent(new Event('submit', { cancelable: true }))
    },
    enroll() { enrolled = true },
    holdSessionReads() { holdSessionReads = true },
    setHidden(value: boolean) {
      hidden = value
      page.dispatchEvent(new Event('visibilitychange'))
    },
  }
}

it('re-enables pairing when a stalled submission has no current session', async () => {
  const mobile = await mountMobile()
  mobile.submit('original-code')
  expect(mobile.button.disabled).toBe(true)
  mobile.submit('ignored-code')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(mobile.posts).toHaveLength(1)
  expect(mobile.posts[0]!.request.signal?.aborted).toBe(true)
  expect(mobile.button.disabled).toBe(false)
  expect(mobile.form.hidden).toBe(false)
  expect(mobile.status()).toBe('Could not confirm pairing. Get a new code from the local inbox.')
  mobile.submit('new-code')
  expect(mobile.posts.map(post => JSON.parse(String(post.request.body)).code)).toEqual(['original-code', 'new-code'])
})

it('returns to a usable form when the pairing confirmation reads also stall', async () => {
  const mobile = await mountMobile()
  mobile.submit('original-code')
  mobile.holdSessionReads()
  await vi.advanceTimersByTimeAsync(19_999)
  expect(mobile.button.disabled).toBe(true)
  expect(mobile.heldReads).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(mobile.heldReads.every(read => read.signal?.aborted)).toBe(true)
  expect(mobile.button.disabled).toBe(false)
  expect(mobile.form.hidden).toBe(false)
  expect(mobile.posts).toHaveLength(1)
})

it('recovers an enrolled session after timeout without repeating the pairing POST', async () => {
  const mobile = await mountMobile()
  mobile.submit('original-code')
  mobile.enroll()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(mobile.posts).toHaveLength(1)
  expect(mobile.posts[0]!.request.signal?.aborted).toBe(true)
  expect(mobile.form.hidden).toBe(true)
  expect(mobile.task()).toBe('Enrolled task')
  mobile.posts[0]!.reply(401)
  await vi.advanceTimersByTimeAsync(0)
  expect(mobile.form.hidden).toBe(true)
  expect(mobile.task()).toBe('Enrolled task')
})

it('retires a pairing submission when hidden and ignores its reply after returning', async () => {
  const mobile = await mountMobile()
  mobile.submit('old-code')
  mobile.setHidden(true)
  expect(mobile.posts[0]!.request.signal?.aborted).toBe(true)
  mobile.setHidden(false)
  await vi.advanceTimersByTimeAsync(0)
  mobile.submit('current-code')
  mobile.enroll()
  mobile.posts[1]!.reply(200)
  await vi.advanceTimersByTimeAsync(0)
  mobile.posts[0]!.reply(401)
  await vi.advanceTimersByTimeAsync(0)
  expect(mobile.form.hidden).toBe(true)
  expect(mobile.task()).toBe('Enrolled task')
  expect(mobile.posts).toHaveLength(2)
})
