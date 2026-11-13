// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mobilePage, mobileScript } from '../../packages/personal-agent/src/client/mobile-page.js'

interface Discovery {
  schema_version: string
  data: {
    contract_version: string
    backend: { id: string }
    capabilities: {
      id: string
      supported: boolean
      enabled: boolean
      available: boolean
      reason: string | null
      remediation: { kind: string; message: string } | null
    }[]
  }
}

interface TasksPage {
  schema_version: string
  data: {
    items: { id: string; title: string; revision: string; state: string; wait_reason: string | null }[]
    next_cursor: string | null
    consistency: string
  }
}

const fixtures = JSON.parse(readFileSync(resolve('contracts/personal-api/fixtures.json'), 'utf8')) as {
  valid: ({ schema: 'Capabilities'; value: Discovery } | { schema: 'TasksPage'; value: TasksPage }
    | { schema: 'Error'; value: object })[]
}

const dshDiscovery = fixtures.valid.find(fixture =>
  fixture.schema === 'Capabilities' && fixture.value.data.backend.id === 'dsh')
const taskPage = fixtures.valid.find(fixture => fixture.schema === 'TasksPage')
if (dshDiscovery?.schema !== 'Capabilities' || taskPage === undefined) throw new Error('Missing shared client fixtures')
const unavailableDiscovery = dshDiscovery.value
const sharedPage = taskPage.value

function availableDiscovery() {
  const discovery = structuredClone(unavailableDiscovery)
  discovery.data.backend.id = 'hermes'
  const tasks = discovery.data.capabilities.find(capability => capability.id === 'tasks.list')!
  Object.assign(tasks, { supported: true, enabled: true, available: true, reason: null })
  return discovery
}

function task(id: string, title: string) {
  return { ...sharedPage.data.items[0]!, id, title }
}

function tasksPage(items: TasksPage['data']['items'], next_cursor: string | null) {
  return { ...sharedPage, data: { ...sharedPage.data, items, next_cursor } }
}

function response(status: number, body: object = {}) {
  return { status, ok: status === 200, json: async () => body }
}

function failure(status: number, code: string) {
  return response(status, {
    schema_version: sharedPage.schema_version,
    error: { code, message: 'Server fixture message', retryable: status === 503 },
  })
}

type Reply = ReturnType<typeof response>
type FetchPage = (cursor: string | null) => Reply | Promise<Reply>

class TestEventSource extends EventTarget {
  closed = false

  close() { this.closed = true }
  emit(name: string) { this.dispatchEvent(new Event(name)) }
}

async function mountMobile(chinese = false) {
  vi.useFakeTimers()
  const page = new DOMParser().parseFromString(mobilePage(chinese), 'text/html')
  const pageEvents = new EventTarget()
  const streams: TestEventSource[] = []
  class FixtureEventSource extends TestEventSource {
    constructor() {
      super()
      streams.push(this)
    }
  }

  let hidden = false
  let outcome = 'Recent task'
  let preview = 'Original private review'
  let discover = (): Reply | Promise<Reply> => response(200, availableDiscovery())
  let list: FetchPage = () => response(200, sharedPage)
  Object.defineProperty(page, 'hidden', { get: () => hidden })
  const fetch = vi.fn(async (path: string, request: RequestInit = {}) => {
    const url = new URL(path, 'https://mobile.test')
    const method = request.method ?? 'GET'
    if (url.pathname === '/v1/snapshot' && method === 'GET') {
      return response(200, { cursor: 'sse-cursor', tasks: [{ outcome, status: 'running' }] })
    }
    if (url.pathname === '/v1/approvals' && method === 'GET') {
      return response(200, { approvals: [{
        id: 'review', kind: 'Fixture review', dataScope: [], preview, expiresAt: '2099-01-01T00:00:00Z',
      }] })
    }
    if (url.pathname === '/v1/pair' && method === 'POST') return response(200)
    if (url.pathname === '/v1/capabilities' && method === 'GET') return discover()
    if (url.pathname === '/v1/tasks' && method === 'GET') return list(url.searchParams.get('cursor'))
    throw new Error('Unexpected request: ' + method + ' ' + path)
  })

  onTestFinished(() => {
    pageEvents.dispatchEvent(new Event('pagehide'))
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  new Function('document', 'window', 'fetch', 'EventSource', mobileScript)(page, pageEvents, fetch, FixtureEventSource)
  await vi.advanceTimersByTimeAsync(0)

  function button(id: string) {
    return page.querySelector<HTMLButtonElement>('#' + id)!
  }

  return {
    page, streams,
    button,
    requests: () => fetch.mock.calls.map(([path]) => new URL(path, 'https://mobile.test')),
    listRequest: () => fetch.mock.calls.findLast(([path]) => new URL(path, 'https://mobile.test').pathname === '/v1/tasks')?.[1],
    rows: () => Array.from(page.querySelectorAll('#tasks li')),
    tasks: () => page.querySelector('#tasks')!.textContent,
    review: () => page.querySelector('#review-items pre')?.textContent,
    browseStatus: () => page.querySelector('#task-browse-status')!.textContent,
    showingPairing: () => !page.querySelector<HTMLFormElement>('#pair')!.hidden,
    actionAvailable(id: string) {
      const action = button(id)
      return !action.disabled && action.closest('[hidden]') === null
    },
    updateLegacy(taskTitle: string, reviewPreview: string) { outcome = taskTitle; preview = reviewPreview },
    respondToDiscovery(handler: typeof discover) { discover = handler },
    respondToList(handler: FetchPage) { list = handler },
    async click(id: string) {
      button(id).click()
      await vi.advanceTimersByTimeAsync(0)
    },
    async setHidden(value: boolean) {
      hidden = value
      page.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    },
    async pairAgain() {
      page.querySelector<HTMLInputElement>('#code')!.value = 'fixture-pairing'
      page.querySelector('#pair')!.dispatchEvent(new Event('submit', { cancelable: true }))
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

it('opens an available shared task list on demand and replaces its current page while approvals stay live', async () => {
  const mobile = await mountMobile()
  const cursor = 'opaque /+=?& cursor'
  const first = Array.from({ length: 32 }, (_, index) => task('task-' + index, 'Shared task ' + index))
  mobile.respondToList(token => response(200, token === null
    ? tasksPage(first, cursor)
    : tasksPage([task('older-task', 'Older task outside recent work')], null)))

  expect(mobile.tasks()).toContain('Recent task')
  expect(mobile.requests().map(url => url.pathname)).toEqual(['/v1/snapshot', '/v1/approvals'])
  await mobile.click('browse-tasks')
  expect(mobile.requests().slice(2).map(url => url.pathname)).toEqual(['/v1/capabilities', '/v1/tasks'])
  expect(mobile.requests().at(-1)?.searchParams.get('limit')).toBe('32')
  expect(mobile.requests().at(-1)?.searchParams.has('cursor')).toBe(false)
  expect(mobile.rows()).toHaveLength(32)
  expect(mobile.rows()[0]?.textContent).toContain('Shared task 0')
  expect(mobile.rows().at(-1)?.textContent).toContain('Shared task 31')

  mobile.updateLegacy('New recent task', 'Updated private review')
  mobile.streams[0]!.emit('approvals')
  await vi.advanceTimersByTimeAsync(75)
  expect(mobile.review()).toBe('Updated private review')
  expect(mobile.rows()).toHaveLength(32)
  expect(mobile.tasks()).not.toContain('New recent task')
  expect(mobile.requests().filter(url => url.pathname === '/v1/tasks')).toHaveLength(1)

  await mobile.click('task-next')
  const shared = mobile.requests().filter(url => url.pathname === '/v1/tasks')
  expect(shared).toHaveLength(2)
  expect(shared[1]!.searchParams.get('limit')).toBe('32')
  expect(shared[1]!.searchParams.get('cursor')).toBe(cursor)
  expect(mobile.rows()).toHaveLength(1)
  expect(mobile.tasks()).toContain('Older task outside recent work')
  expect(mobile.actionAvailable('task-next')).toBe(false)

  await mobile.click('recent-tasks')
  expect(mobile.tasks()).toContain('New recent task')
  expect(mobile.tasks()).not.toContain('Older task outside recent work')
  expect(mobile.requests().filter(url => url.pathname === '/v1/capabilities')).toHaveLength(1)
})

it('clears an expired page and restarts discovery and pagination without reusing its cursor', async () => {
  const mobile = await mountMobile()
  let title = 'First shared page'
  mobile.respondToList(cursor => cursor === null
    ? response(200, tasksPage([task('first', title)], 'expired-fixture-cursor'))
    : failure(400, 'cursor_invalid'))

  await mobile.click('browse-tasks')
  expect(mobile.tasks()).toContain('First shared page')
  await mobile.click('task-next')
  expect(mobile.browseStatus()).toBe('This task page expired. Restart from the first page.')
  expect(mobile.tasks()).not.toContain('First shared page')
  expect(mobile.actionAvailable('task-next')).toBe(false)
  expect(mobile.actionAvailable('task-restart')).toBe(true)
  expect(mobile.requests().filter(url => url.pathname === '/v1/tasks')).toHaveLength(2)

  title = 'Fresh first shared page'
  await mobile.click('task-restart')
  expect(mobile.requests().slice(-2).map(url => url.pathname)).toEqual(['/v1/capabilities', '/v1/tasks'])
  expect(mobile.requests().at(-1)?.searchParams.has('cursor')).toBe(false)
  expect(mobile.tasks()).toContain('Fresh first shared page')
})

it('reports unavailable task listing locally and can discover an enabled capability on restart', async () => {
  const mobile = await mountMobile(true)
  const disabled = structuredClone(unavailableDiscovery)
  const tasks = disabled.data.capabilities.find(capability => capability.id === 'tasks.list')!
  Object.assign(tasks, { supported: true, enabled: false, available: false, reason: 'disabled' })
  mobile.respondToDiscovery(() => response(200, disabled))

  await mobile.click('browse-tasks')
  expect(mobile.browseStatus()).toMatch(/停用|禁用|未启用|关闭/u)
  expect(mobile.requests().filter(url => url.pathname === '/v1/tasks')).toHaveLength(0)
  expect(mobile.actionAvailable('task-next')).toBe(false)
  expect(mobile.actionAvailable('task-restart')).toBe(true)
  expect(mobile.showingPairing()).toBe(false)

  mobile.respondToDiscovery(() => response(200, availableDiscovery()))
  await mobile.click('task-restart')
  expect(mobile.tasks()).toContain('Synthetic task')
})

it('clears shared tasks and approvals and returns to pairing when a shared page request is unauthorized', async () => {
  const mobile = await mountMobile()
  mobile.respondToList(cursor => cursor === null
    ? response(200, tasksPage([task('first', 'Private shared task')], 'cursor-before-revoke'))
    : failure(401, 'auth_required'))

  await mobile.click('browse-tasks')
  expect(mobile.tasks()).toContain('Private shared task')
  expect(mobile.review()).toBe('Original private review')
  await mobile.click('task-next')
  expect(mobile.showingPairing()).toBe(true)
  expect(mobile.rows()).toHaveLength(0)
  expect(mobile.review()).toBeUndefined()
  expect(mobile.streams[0]!.closed).toBe(true)
})

it('aborts a browse on hide and ignores its delayed unauthorized response after replacement pairing', async () => {
  const mobile = await mountMobile()
  let resolvePage: (reply: Reply) => void = () => { throw new Error('No pending page request') }
  mobile.respondToList(() => new Promise(resolve => { resolvePage = resolve }))

  await mobile.click('browse-tasks')
  const signal = mobile.listRequest()?.signal
  expect(signal?.aborted).toBe(false)
  await mobile.setHidden(true)
  expect(signal?.aborted).toBe(true)
  expect(mobile.rows()).toHaveLength(0)
  expect(mobile.review()).toBeUndefined()

  mobile.updateLegacy('Recovered recent task', 'Recovered review')
  await mobile.setHidden(false)
  expect(mobile.tasks()).toContain('Recovered recent task')
  mobile.streams.at(-1)!.emit('session-ended')
  expect(mobile.showingPairing()).toBe(true)
  await mobile.pairAgain()
  expect(mobile.showingPairing()).toBe(false)
  const currentStream = mobile.streams.at(-1)!

  resolvePage(failure(401, 'auth_required'))
  await vi.advanceTimersByTimeAsync(0)
  expect(mobile.showingPairing()).toBe(false)
  expect(mobile.tasks()).toContain('Recovered recent task')
  expect(mobile.review()).toBe('Recovered review')
  expect(currentStream.closed).toBe(false)
})
