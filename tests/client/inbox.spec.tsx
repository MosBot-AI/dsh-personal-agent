// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { dictionaries, type Translate } from '../../packages/personal-agent/src/client/copy.js'
import { Inbox, type ConnectionSnapshot, type InboxConnection } from '../../packages/personal-agent/src/client/inbox.js'
import { apply, createInboxPort } from '../../packages/personal-agent/src/client/index.js'
import type { InboxPort, InboxRequest, InboxResponse, InboxSnapshot, InboxTask } from '../../packages/personal-agent/src/inbox/protocol.js'

beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }))

const t: Translate = key => dictionaries.en[key]
const project = { id: 'project', title: 'Workbench', purpose: 'Inspect requested outcomes.' }
const session = { id: 'primary-session', label: 'Primary conversation' }
const verifiedAt = '2026-11-07T08:00:00.000Z'

function task(id: string, overrides: Partial<InboxTask> = {}): InboxTask {
  return {
    id,
    projectId: project.id,
    sessionId: session.id,
    outcome: `Task ${id}`,
    status: 'queued',
    runtime: 'inactive',
    version: 1,
    artifacts: [],
    deliveries: [],
    ...overrides,
  }
}

function snapshot(overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return { workerConfigured: true, sessions: [session], projects: [project], tasks: [], approvals: [], ...overrides }
}

function connection() {
  let current: ConnectionSnapshot = 'connected:1'
  const listeners = new Set<() => void>()
  const source: InboxConnection = {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    source,
    change(next: ConnectionSnapshot) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

async function mount(port: InboxPort, language: Translate = t) {
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const carrier = connection()
  const open = vi.fn(async () => true)
  const save = vi.fn()
  onTestFinished(async () => {
    await act(async () => root.unmount())
    node.remove()
  })
  await act(async () => root.render(<Inbox t={language} port={port} connection={carrier.source} openSession={open} saveArtifact={save} />))
  return { node, carrier, open, save }
}

function button(node: ParentNode, name: string): HTMLButtonElement {
  const result = [...node.querySelectorAll('button')].find(button =>
    button.getAttribute('aria-label') === name || button.textContent?.trim() === name)
  if (!result) throw new Error(`Missing button ${name}`)
  return result
}

function taskButton(node: ParentNode, outcome: string): HTMLButtonElement {
  const result = [...node.querySelectorAll<HTMLButtonElement>('.dshpa-task-row')].find(button =>
    button.firstElementChild?.textContent === outcome)
  if (!result) throw new Error(`Missing task ${outcome}`)
  return result
}

function field(node: ParentNode, name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const label = [...node.querySelectorAll('label')].find(label => label.firstChild?.textContent === name)
  const result = label?.querySelector('input,textarea,select')
  if (!result) throw new Error(`Missing field ${name}`)
  return result as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
}

async function click(element: HTMLButtonElement) {
  await act(async () => { element.click() })
}

async function fill(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = Object.getPrototypeOf(element)
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}

describe('native Inbox client', () => {
  it('shows metered, uncertain, and unpriced usage separately alongside routine progress', async () => {
    const work = task('progress', { progress: { summary: 'Latest scoped update.', at: verifiedAt } })
    const { node } = await mount(async () => ({ ok: true, kind: 'snapshot', snapshot: snapshot({
      tasks: [work], usage: {
        day: '2026-11-07', currencies: [{ currency: 'USD', spentMicros: 50_000, reservedMicros: 100_000,
          uncertainMicros: 200_000, olderHeldMicros: 25_000, dailyLimitMicros: 1_000_000, overflow: false }],
        calls: 7, unknownCalls: 2, uncertainCalls: 1, routing: 'pricing_unavailable',
        tokens: { input: 70, output: 20, cacheRead: 40, cacheWrite: 6 },
        workerSlots: { active: 4, limit: 4 }, gpu: { active: 1, queued: 2, limit: 1 },
        attention: { mode: 'observe', version: 1, day: '2026-11-07', timeZone: 'Asia/Shanghai', unsolicited: 0, limit: 3,
          suppressed: 8, recent: [{ id: 'one', reason: 'quiet_hours', at: verifiedAt }] },
      },
    }) }))
    const usage = node.querySelector('.dshpa-usage')
    expect(usage?.querySelector('summary')?.textContent).toBe('Compute and attention usage')
    const fields = Object.fromEntries([...usage!.querySelectorAll('dt')].map(label =>
      [label.textContent, label.nextElementSibling?.textContent]))
    expect(fields).toMatchObject({ 'Calls with unknown price': '2', 'Calls awaiting reconciliation': '1',
      'Worker slots': '4 / 4', 'Heavy GPU jobs queued': '2', 'Cache read tokens': '40', 'Proactive mode': 'Observe',
      'Background assessment': 'Pricing required' })
    expect(fields['Uncertain ceiling']).toMatch(/USD\s+0\.20/u)
    expect(usage?.textContent).toContain('quiet_hours')
    await click(taskButton(node, work.outcome))
    expect(node.querySelector('[aria-label="Latest progress"]')?.textContent).toContain('Latest scoped update.')
  })

  it('presents exact approvals and blocking questions before results and other work', async () => {
    const waiting = task('question', {
      status: 'waiting_input',
      wait: { reason: 'input', referenceId: 'question-ref', prompt: 'Which source should be used?' },
    })
    const result = task('result', { status: 'completed', verifiedAt })
    const routine = task('routine')
    const approval = {
      id: 'approval-1', taskId: waiting.id, version: 4, digest: 'f'.repeat(64), expiresAt: '2099-11-07T08:00:00.000Z',
      kind: 'publish', accountId: 'scoped-account', resourceRef: 'resource-1', recipient: 'exact-recipient',
      dataScope: ['approved-summary'], preview: 'Publish the verified summary.',
    }
    let current = snapshot({ tasks: [routine, result, waiting], approvals: [approval] })
    const port = vi.fn<InboxPort>(async request => {
      switch (request.type) {
        case 'snapshot': return { ok: true, kind: 'snapshot', snapshot: current }
        case 'approval':
          current = { ...current, approvals: [] }
          return { ok: true, kind: 'updated', taskId: waiting.id }
        case 'answer':
          current = { ...current, tasks: [routine, result, task(waiting.id, { version: 2 })] }
          return { ok: true, kind: 'updated', taskId: waiting.id }
        default: throw new Error(`Unexpected ${request.type}`)
      }
    })
    const { node } = await mount(port)
    expect([...node.querySelectorAll('.dshpa-section h2')].map(heading => heading.firstChild?.textContent))
      .toEqual(['Needs your attention', 'Results', 'Other work'])
    expect(node.textContent).toContain(approval.recipient)
    expect(node.textContent).toContain(approval.preview)
    expect(node.textContent).toContain(approval.digest)
    await click(button(node, 'Approve exact action'))
    expect(port.mock.calls.map(([request]) => request)).toContainEqual({
      type: 'approval', requestId: approval.id, expectedVersion: approval.version, digest: approval.digest, decision: 'approve',
    })
    await click(button(node, 'View task'))
    expect(document.activeElement?.textContent).toBe(waiting.outcome)
    await fill(field(node, 'Your answer'), 'Use the approved source.')
    await click(button(node, 'Send answer'))
    expect(port.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
      type: 'answer', taskId: waiting.id, expectedVersion: 1, referenceId: 'question-ref', text: 'Use the approved source.',
    }))
  })

  it('creates a project and a task bound to a native conversation and uses scoped controls', async () => {
    const newProject = { id: 'new-project', title: 'Research', purpose: 'Track the requested work.' }
    const created = task('new-task', { projectId: newProject.id, outcome: 'Inspect the source.' })
    let current = snapshot({ projects: [] })
    const port = vi.fn<InboxPort>(async request => {
      if (request.type === 'snapshot') return { ok: true, kind: 'snapshot', snapshot: current }
      if (request.type === 'create_project') {
        current = { ...current, projects: [newProject] }
        return { ok: true, kind: 'updated', projectId: newProject.id }
      }
      if (request.type === 'create_task') current = { ...current, tasks: [created] }
      if (request.type === 'start') current = { ...current, tasks: [{ ...created, status: 'running', runtime: 'active', version: 2 }] }
      if (request.type === 'pause') current = { ...current, tasks: [{ ...created, status: 'paused', runtime: 'inactive', version: 3 }] }
      if (request.type === 'resume') current = { ...current, tasks: [{ ...created, status: 'queued', version: 4 }] }
      if (request.type === 'cancel') current = { ...current, tasks: [{ ...created, status: 'cancelled', version: 5 }] }
      return { ok: true, kind: 'updated', taskId: created.id }
    })
    const { node, open } = await mount(port)
    await click(button(node, 'New project'))
    await fill(field(node, 'Project name'), newProject.title)
    await fill(field(node, 'Purpose'), newProject.purpose)
    await click(button(node, 'Create project'))
    await click(button(node, 'New task'))
    await fill(field(node, 'Conversation'), session.id)
    await fill(field(node, 'Requested outcome'), created.outcome)
    await click(button(node, 'Create task'))
    await click(button(node, 'Open conversation'))
    expect(open).toHaveBeenCalledWith(session.id, expect.any(AbortSignal))
    await click(button(node, 'Start'))
    expect(node.textContent).toContain('Your chat remains available while work runs.')
    await click(button(node, 'Pause'))
    await click(button(node, 'Resume'))
    await click(button(node, 'Cancel work'))
    const requests = port.mock.calls.map(([request]) => request)
    expect(requests).toContainEqual(expect.objectContaining({
      type: 'create_task', projectId: newProject.id, sessionId: session.id, outcome: created.outcome,
    }))
    expect(requests).toContainEqual(expect.objectContaining({ type: 'pause', taskId: created.id, expectedVersion: 2 }))
    expect(requests).toContainEqual(expect.objectContaining({ type: 'resume', taskId: created.id, expectedVersion: 3 }))
    expect(requests).toContainEqual(expect.objectContaining({ type: 'cancel', taskId: created.id, expectedVersion: 4 }))
    expect(node.textContent).toContain('Cancelled')
  })

  it('retains an in-flight draft across disconnect and rechecks without silently resending', async () => {
    const active = task('active', { status: 'running', runtime: 'active' })
    const redirectRequests: Extract<InboxRequest, { type: 'redirect' }>[] = []
    const signals: AbortSignal[] = []
    const first = Promise.withResolvers<InboxResponse>()
    const second = Promise.withResolvers<InboxResponse>()
    const port = vi.fn<InboxPort>(async (request, signal) => {
      if (request.type === 'snapshot') return { ok: true, kind: 'snapshot', snapshot: snapshot({ tasks: [active] }) }
      if (request.type !== 'redirect' || !signal) throw new Error('Unexpected request')
      redirectRequests.push(request)
      signals.push(signal)
      return redirectRequests.length === 1 ? first.promise : second.promise
    })
    const { node, carrier } = await mount(port)
    await click(taskButton(node, active.outcome))
    await fill(field(node, 'New direction'), 'Narrow to the scoped input.')
    await click(button(node, 'Redirect'))
    expect(redirectRequests).toHaveLength(1)
    await act(async () => carrier.change('disconnected:0'))
    expect(signals[0]?.aborted).toBe(true)
    expect(node.textContent).toContain('The request outcome is unknown.')
    expect(field(node, 'New direction').value).toBe('Narrow to the scoped input.')
    expect(button(node, 'Redirect').disabled).toBe(true)
    await act(async () => carrier.change('connected:2'))
    expect(redirectRequests).toHaveLength(1)
    expect(button(node, 'Redirect').disabled).toBe(false)
    await click(button(node, 'Redirect'))
    expect(redirectRequests[1]?.cursor).toBe(redirectRequests[0]?.cursor)
    await fill(field(node, 'New direction'), 'Keep this newer draft.')
    await act(async () => second.resolve({ ok: true, kind: 'updated', taskId: active.id }))
    await act(async () => first.resolve({ ok: true, kind: 'updated', taskId: active.id }))
    expect(field(node, 'New direction').value).toBe('Keep this newer draft.')
  })

  it('downloads exact scoped candidate bytes and waits for explicit acceptance', async () => {
    const artifact = { id: 'result-text', mediaType: 'text/plain', version: 1 }
    const candidate = task('candidate', { status: 'verifying', artifacts: [artifact], canAccept: true })
    let current = snapshot({ tasks: [candidate] })
    let wrongVersion = true
    const port = vi.fn<InboxPort>(async request => {
      if (request.type === 'snapshot') return { ok: true, kind: 'snapshot', snapshot: current }
      if (request.type === 'artifact') return {
        ok: true, kind: 'artifact', artifact: { ...artifact, version: wrongVersion ? 2 : 1, text: 'Exact result.' },
      }
      if (request.type === 'accept_result') {
        current = { ...current, tasks: [{ ...candidate, status: 'completed', verifiedAt, canAccept: false, version: 2 }] }
        return { ok: true, kind: 'updated', taskId: candidate.id }
      }
      throw new Error('Unexpected request')
    })
    const { node, save } = await mount(port)
    await click(taskButton(node, candidate.outcome))
    expect(node.textContent).toContain('Candidate result')
    expect(node.textContent).not.toContain('Verified result')
    await click(button(node, 'Download result-text'))
    expect(save).not.toHaveBeenCalled()
    expect(node.textContent).toContain('The artifact could not be downloaded.')
    wrongVersion = false
    await click(button(node, 'Download result-text'))
    expect(port.mock.calls.map(([request]) => request)).toContainEqual({
      type: 'artifact', taskId: candidate.id, artifactId: artifact.id,
    })
    expect(save).toHaveBeenCalledWith({ ...artifact, text: 'Exact result.' })
    await click(button(node, 'Accept result'))
    expect(port.mock.calls.map(([request]) => request)).toContainEqual({
      type: 'accept_result', taskId: candidate.id, expectedVersion: 1,
    })
    expect(node.textContent).toContain('Verified result')
  })

  it('uses the native Connection endpoint and keeps English and Chinese dictionary keys paired', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { ok: true, kind: 'snapshot', snapshot: snapshot() } }))
    const port = createInboxPort({ rpc: { call } })
    const signal = new AbortController().signal
    expect(await port({ type: 'snapshot' }, signal)).toMatchObject({ ok: true, kind: 'snapshot' })
    expect(call).toHaveBeenCalledWith('/api', 'dshpa/inbox', { type: 'snapshot' }, signal)
    expect(Object.keys(dictionaries.zh).sort()).toEqual(Object.keys(dictionaries.en).sort())
    const { node } = await mount(port, key => dictionaries.zh[key])
    expect(node.querySelector('h1')?.textContent).toBe('待办')
  })

  it('contributes the native main and sidebar entries without installing a chat replacement', () => {
    const register = vi.fn(() => () => {})
    const localeRegister = vi.fn(() => () => {})
    const ctx = {
      effect(install: () => Iterable<() => void>) { for (const _ of install()) { /* Install test dictionaries. */ } },
      locale: { register: localeRegister, bind: () => t },
      connection: {},
      slots: { inject: (_slot: string, install: () => void) => install(), register },
    } as unknown as Parameters<typeof apply>[0]
    apply(ctx)
    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: 'main', key: 'dshpa-today' }), expect.any(Function))
    expect(register).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'sidebar.panellist', id: 'dshpa-today' }), expect.any(Function))
    expect(localeRegister).toHaveBeenCalledWith('dshpa.inbox', 'en', dictionaries.en)
    expect(localeRegister).toHaveBeenCalledWith('dshpa.inbox', 'zh', dictionaries.zh)
  })
})
