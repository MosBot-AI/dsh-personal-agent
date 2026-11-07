// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { MemoryActiveRecord, MemoryScope } from '@mosbot-ai/dshpa-plugin-api'
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

function memoryRecord(scope: MemoryScope, id: string, text: string, overrides: Partial<MemoryActiveRecord> = {}): MemoryActiveRecord {
  return { id, ownerId: 'owner', profileId: 'profile', scope, value: { kind: 'fact', text }, state: 'active',
    revision: 1, validFrom: verifiedAt, sourceEventIds: [`source-${id}`], origin: 'explicit', confidence: 1, ...overrides }
}

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
  it('reuses a previous plan as a draft and opens weekly review through the read-only request', async () => {
    const saved = { title: 'Current goal', purpose: 'Current outcome.', successCriteria: ['Check the latest result.'],
      priority: 'normal' as const, milestones: [] }
    const previous = { ...saved, title: 'Earlier goal' }
    const requests: InboxRequest[] = []
    const { node } = await mount(async request => {
      if (request.type === 'snapshot') return { ok: true, kind: 'snapshot', snapshot: snapshot() }
      requests.push(request)
      if (request.type === 'project_plan') return { ok: true, kind: 'project_plan', plan: { projectId: project.id,
        kind: 'goal', revision: 2, draft: saved, history: [
          { revision: 2, draft: saved, rationale: 'Prioritize the exact outcome.' }, { revision: 1, draft: previous },
        ] } }
      if (request.type === 'save_plan') return { ok: true, kind: 'updated', projectId: project.id }
      if (request.type === 'project_review') return { ok: true, kind: 'project_review', at: verifiedAt, needsPriority: false, projects: [] }
      throw new Error(`Unexpected ${request.type}`)
    })
    await click(button(node, project.title))
    expect(field(node, 'Plan title').value).toBe(saved.title)
    expect(node.textContent).toContain('Prioritize the exact outcome.')
    await click(button(node, 'Use as a new draft'))
    expect(field(node, 'Plan title').value).toBe(previous.title)
    await fill(field(node, 'Reason for this plan revision'), 'Reuse after checking the new scope.')
    await click(button(node, 'Save plan'))
    expect(requests).toContainEqual(expect.objectContaining({ type: 'save_plan', projectId: project.id,
      expectedRevision: 2, draft: previous, rationale: 'Reuse after checking the new scope.' }))
    await click(button(node, 'Weekly review'))
    expect(requests.at(-1)).toEqual({ type: 'project_review' })
  })

  it('reviews scoped memory and retries a pending forget with its exact command', async () => {
    const scope = { kind: 'project', projectId: project.id } as const
    const confirmed = memoryRecord(scope, 'memory-one', '<img src=x onerror=alert(1)>', { revision: 2 })
    const inferred = memoryRecord(scope, 'memory-two', 'Unconfirmed suggestion', { origin: 'inferred', confidence: 0.4 })
    const replacement = memoryRecord(scope, 'memory-new', 'Owner-corrected preference')
    let records = [confirmed]
    let pendingForget: Extract<InboxRequest, { type: 'memory_forget' }> | undefined
    const requests: InboxRequest[] = []
    const { node } = await mount(async request => {
      if (request.type === 'snapshot') return { ok: true, kind: 'snapshot', snapshot: snapshot({ memoryConfigured: true }) }
      requests.push(request)
      if (request.type === 'memory_search') return { ok: true, kind: 'memory_records', confirmed: records, inferred: [inferred] }
      if (request.type === 'memory_inspect') return { ok: true, kind: 'memory_records', confirmed: [confirmed], inferred: [] }
      if (request.type === 'memory_remember') return { ok: true, kind: 'memory_change', state: 'completed', recordId: 'created', revision: 1 }
      if (request.type === 'memory_correct') {
        records = [replacement]
        return { ok: true, kind: 'memory_change', state: 'completed', recordId: replacement.id, revision: 1 }
      }
      if (request.type === 'memory_forget') {
        if (pendingForget) {
          expect(request).toEqual(pendingForget)
          return { ok: true, kind: 'memory_change', state: 'completed', recordId: replacement.id, revision: 2 }
        }
        pendingForget = request
        records = []
        return { ok: true, kind: 'memory_change', state: 'pending', recordId: replacement.id, revision: 2 }
      }
      throw new Error(`Unexpected memory operation ${request.type}`)
    })
    const panel = node.querySelector<HTMLDetailsElement>('.dshpa-memory')!
    panel.open = true
    await fill(field(panel, 'Memory scope'), 'project')
    await fill(field(panel, 'Project'), project.id)
    await click(button(panel, 'List recent memories'))
    expect(requests[0]).toEqual({ type: 'memory_search', scope, query: '' })
    expect(panel.textContent).toContain('Confirmed memories')
    expect(panel.textContent).toContain('Inferred candidates')
    expect(panel.textContent).toContain('40%')
    expect(panel.textContent).toContain('source-memory-one')
    expect(panel.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(panel.querySelector('img')).toBeNull()
    expect(panel.textContent).toContain('Older backups can retain it')
    await fill(field(panel, 'Search text'), 'scope keyword')
    await click(button(panel, 'Search memory'))
    expect(requests.at(-1)).toEqual({ type: 'memory_search', scope, query: 'scope keyword' })
    await fill(field(panel, 'Search text'), '')

    await click(button(panel, 'Remember a fact'))
    await fill(field(panel, 'Memory text'), 'Keep a user-entered fact')
    await fill(field(panel, 'Expires at (UTC, optional)'), '2031-01-02T13:05')
    await click(button(panel, 'Save memory'))
    expect(requests.at(-1)).toEqual({ type: 'memory_remember', scope, commandId: expect.any(String),
      text: 'Keep a user-entered fact', validUntil: '2031-01-02T13:05:00.000Z' })
    expect(panel.textContent).toContain('Memory change saved.')
    expect(panel.textContent).not.toContain('source-memory-one')

    await click(button(panel, 'List recent memories'))
    await click(button(panel, 'Inspect memory'))
    expect(requests.at(-1)).toEqual({ type: 'memory_inspect', scope, recordId: confirmed.id })
    expect(panel.textContent).not.toContain('Unconfirmed suggestion')
    await click(button(panel, 'Correct memory'))
    await fill(field(panel, 'Memory text'), 'Owner-corrected preference')
    await click(button(panel, 'Save memory'))
    expect(requests.at(-1)).toEqual({ type: 'memory_correct', scope, commandId: expect.any(String),
      text: 'Owner-corrected preference', recordId: confirmed.id, expectedRevision: 2 })

    await click(button(panel, 'List recent memories'))
    await click(button(panel, 'Forget memory'))
    expect(requests.at(-1)?.type).toBe('memory_search')
    await click(button(panel, 'Confirm forget'))
    expect(pendingForget).toEqual({ type: 'memory_forget', scope, commandId: expect.any(String),
      recordId: replacement.id, expectedRevision: replacement.revision })
    expect(panel.textContent).toContain('Provider sync is pending.')
    expect(panel.textContent).not.toContain(replacement.value.kind === 'fact' ? replacement.value.text : '')
    await fill(field(panel, 'Memory scope'), 'profile')
    expect(panel.textContent).not.toContain('Provider sync is pending.')
    await fill(field(panel, 'Memory scope'), 'project')
    await fill(field(panel, 'Project'), project.id)
    expect(panel.textContent).toContain('Provider sync is pending.')
    await click(button(panel, 'Retry provider sync'))
    expect(panel.textContent).toContain('Memory change saved.')
    expect(panel.textContent).not.toContain('Provider sync is pending.')
  })

  it('discards delayed memory replies on scope changes and disconnect', async () => {
    const work = task('memory-task')
    const held = Promise.withResolvers<InboxResponse>()
    let heldSignal: AbortSignal | undefined
    let forged = true
    const old = memoryRecord({ kind: 'profile' }, 'stale-profile-memory', 'Profile memory from an earlier request')
    const current = memoryRecord({ kind: 'task', taskId: work.id }, 'current-task-memory', 'Task-scoped fact')
    const { node, carrier } = await mount(async (request, signal) => {
      if (request.type === 'snapshot') return { ok: true, kind: 'snapshot', snapshot: snapshot({ memoryConfigured: true, tasks: [work] }) }
      if (request.type !== 'memory_search') throw new Error('Unexpected memory operation')
      if (request.scope.kind === 'profile') {
        heldSignal = signal
        return held.promise
      }
      return { ok: true, kind: 'memory_records', confirmed: [forged ? old : current], inferred: [] }
    })
    const panel = node.querySelector<HTMLDetailsElement>('.dshpa-memory')!
    panel.open = true
    await click(button(panel, 'List recent memories'))
    expect(heldSignal?.aborted).toBe(false)
    await fill(field(panel, 'Memory scope'), 'task')
    await fill(field(panel, 'Task'), work.id)
    expect(heldSignal?.aborted).toBe(true)
    await act(async () => held.resolve({ ok: true, kind: 'memory_records', confirmed: [old], inferred: [] }))
    expect(panel.textContent).not.toContain('Profile memory from an earlier request')
    await click(button(panel, 'List recent memories'))
    expect(panel.textContent).not.toContain('Profile memory from an earlier request')
    forged = false
    await click(button(panel, 'List recent memories'))
    expect(panel.textContent).toContain('Task-scoped fact')
    await act(async () => carrier.change('disconnected:1'))
    expect(panel.textContent).not.toContain('Task-scoped fact')
    await act(async () => carrier.change('connected:2'))
    expect(panel.textContent).not.toContain('Task-scoped fact')
  })

  it('saves a routine draft separately from arming and displays a committed reminder', async () => {
    const requests: InboxRequest[] = []
    let routines: NonNullable<InboxSnapshot['schedules']>['routines'] = []
    const { node } = await mount(async request => {
      if (request.type === 'snapshot') return { ok: true, kind: 'snapshot', snapshot: snapshot({
        schedules: { routines, reminders: [{ id: 'reminder', title: 'Check the build', text: 'Read the results.',
          intendedAt: verifiedAt, deliveredAt: verifiedAt }] },
      }) }
      requests.push(request)
      if (request.type === 'save_routine' && request.draft.target.kind === 'reminder') {
        const { title, target, timing, misfire } = request.draft
        routines = [{ id: 'routine-id', revision: 1, state: 'draft', title, target, timing, misfire }]
      }
      return { ok: true, kind: 'updated' }
    })
    expect(node.querySelector('#dshpa-reminders')?.textContent).toBe('Reminders')
    expect(node.textContent).toContain('Read the results.')
    await click(button(node, 'New routine'))
    await fill(field(node, 'Routine title'), 'Review after lunch')
    await fill(field(node, 'Scheduled time (UTC)'), '2026-11-07T13:00')
    await fill(field(node, 'Reminder message'), 'Inspect the exact build.')
    await click(button(node, 'Save draft'))
    expect(requests).toEqual([expect.objectContaining({ type: 'save_routine', draft: {
      title: 'Review after lunch', timing: { kind: 'at', at: '2026-11-07T13:00:00.000Z' },
      misfire: 'skip', target: { kind: 'reminder', text: 'Inspect the exact build.' },
    } })])
    await click(button(node, 'Arm schedule'))
    expect(requests.at(-1)).toMatchObject({ type: 'arm_routine', routineId: 'routine-id', expectedRevision: 1 })
  })

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
    expect([...node.querySelectorAll('.dshpa-today .dshpa-section h2')].map(heading => heading.firstChild?.textContent))
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

  it('rejects malformed active memory records at the native transport boundary', async () => {
    const scope = { kind: 'profile' } as const
    const record = memoryRecord(scope, 'transport-memory', 'Scoped preference')
    const reply = { ok: true, kind: 'memory_records', confirmed: [record], inferred: [] } as const
    const call = vi.fn(async () => ({ ok: true as const, value: reply }))
    call.mockResolvedValueOnce({ ok: true, value: { ...reply, confirmed: [{ ...record, origin: 'inferred' }] } })
    call.mockResolvedValueOnce({ ok: true, value: { ...reply, confirmed: [{ ...record, validUntil: 'invalid-time' }] } })
    const port = createInboxPort({ rpc: { call } })
    const request = { type: 'memory_search', scope, query: '' } as const
    await expect(port(request)).rejects.toThrow('Inbox transport unavailable')
    await expect(port(request)).rejects.toThrow('Inbox transport unavailable')
    await expect(port(request)).resolves.toEqual(reply)
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
