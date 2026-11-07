import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  INBOX_RPC_ENDPOINT,
  type InboxPort,
  type InboxResponse,
  type InboxTask,
} from '../../packages/personal-agent/src/inbox/protocol.js'
import { openWebHost } from './fixtures/web-host.js'

const probe = fileURLToPath(new URL('./fixtures/local-flow-probe.mjs', import.meta.url))
const nativeSessionId = 'pa008-native-chat'
const fixtureProjectId = 'pa008-fixture-project'
const questionReference = 'pa008-fixture-question'
const resultSummary = 'PA-008 verified fixture\n\nUnicode: 本地交付 ✓'
const require = createRequire(import.meta.url)

function updated(response: InboxResponse) {
  assert.ok(response.ok && response.kind === 'updated', JSON.stringify(response))
  return response
}

async function waitForTask(
  read: () => Promise<InboxTask>,
  matches: (task: InboxTask) => boolean,
  description: string,
  diagnostics: () => string = () => '',
) {
  const deadline = performance.now() + 5_000
  do {
    const task = await read()
    if (matches(task)) return task
    await delay(25)
  } while (performance.now() < deadline)
  assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(await read())}\n${diagnostics()}`)
}

describe('published DSH Web local inbox', () => {
  it('serves the browser factory and keeps authenticated chat, task controls, approval and artifact review connected', async () => {
    const host = await openWebHost(probe)
    const cookie = await host.exchange()
    expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'snapshot' })).toMatchObject({ status: 401 })
    expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'snapshot' }, cookie, 'https://untrusted.invalid'))
      .toMatchObject({ status: 403 })

    const page = await host.get('/', cookie)
    expect(page.status).toBe(200)
    const html = await page.text()
    const manifest = /<script>globalThis\["__DSH_BOOT__"\] = ([^<]+)<\/script>/u.exec(html)?.[1]
    assert.ok(manifest, 'The native Web frontend did not provide a browser boot manifest')
    const graph = JSON.parse(manifest) as { entries: { id: string; url: string; inject?: string[] }[] }
    const entry = graph.entries.find(item => item.id === '@mosbot-ai/dshpa')
    assert.ok(entry, 'The production bundle must be a browser module in the native graph')
    expect(entry.inject).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(graph.entries.some(item => item.id === '@deepseek-ai/dsh-client-connection')).toBe(true)
    const browserModule = await host.get(entry.url, cookie)
    expect(browserModule.status).toBe(200)
    expect(browserModule.headers.get('content-type')).toMatch(/javascript/)
    const registered: { id: string; factory(resolve: (specifier: string) => unknown): unknown }[] = []
    runInNewContext(await browserModule.text(), {
      window: { __ModuleLoader__: { load: (module: typeof registered[number]) => registered.push(module) } },
    }, { timeout: 1_000 })
    expect(registered).toEqual([{ id: '@mosbot-ai/dshpa', factory: expect.any(Function) }])
    const compiled = registered[0]?.factory(specifier => {
      assert.ok(['react', 'react/jsx-runtime'].includes(specifier), `Unexpected browser module dependency ${specifier}`)
      return require(specifier)
    }) as { createInboxPort(connection: { rpc: { call(channel: string, endpoint: string, input: unknown): Promise<unknown> } }): InboxPort }
    const inbox = compiled.createInboxPort({ rpc: { async call(channel, endpoint, input) {
      assert.equal(channel, '/api')
      assert.equal(endpoint, INBOX_RPC_ENDPOINT)
      const reply = await host.rpc<InboxResponse>(endpoint, input, cookie)
      assert.equal(reply.status, 200)
      return reply.result
    } } })

    async function rpc<T>(method: string, payload: unknown): Promise<T> {
      const reply = await host.rpc<T>(method, payload, cookie)
      assert.ok(reply.status === 200 && reply.result?.ok, `${method}: ${JSON.stringify(reply)}`)
      return reply.result.value
    }
    async function snapshot() {
      const response = await inbox({ type: 'snapshot' })
      assert.ok(response.ok && response.kind === 'snapshot', JSON.stringify(response))
      return response.snapshot
    }
    async function readTask(taskId: string) {
      const task = (await snapshot()).tasks.find(item => item.id === taskId)
      assert.ok(task, 'Expected the scoped inbox task')
      return task
    }
    async function createTask(label: string, outcome: string) {
      const request = {
        type: 'create_task', commandId: `pa008-create-${label}`,
        projectId: fixtureProjectId, sessionId: nativeSessionId, outcome,
      } as const
      const created = updated(await inbox(request))
      assert.ok(created.taskId)
      expect(await inbox(request)).toEqual(created)
      return created.taskId
    }

    const initial = await snapshot()
    expect(initial.workerConfigured).toBe(true)
    expect(initial.projects).toContainEqual(expect.objectContaining({ id: fixtureProjectId, title: 'PA-008 fixture project' }))
    expect(initial.sessions).toContainEqual(expect.objectContaining({ id: nativeSessionId }))
    const newProject = {
      type: 'create_project', commandId: 'pa008-project', title: 'Web-created project',
      purpose: 'Exercise authenticated project intake.',
    } as const
    const project = updated(await inbox(newProject))
    expect(await inbox(newProject)).toEqual(project)
    expect(await inbox({ ...newProject, title: 'Altered project request' })).toEqual({ ok: false, code: 'command_conflict' })

    const heldId = await createTask('held', 'PA008_HELD Keep running while the owner chats.')
    const resultId = await createTask('result', 'PA008_RESULT Draft an inspectable local result.')
    expect(heldId).not.toBe(resultId)
    const held = await readTask(heldId)
    const result = await readTask(resultId)
    for (const task of [held, result]) {
      expect(task).toMatchObject({ projectId: fixtureProjectId, sessionId: nativeSessionId, status: 'queued' })
    }
    expect(await inbox({
      type: 'start', taskId: 'foreign-task', expectedVersion: held.version, cursor: 'pa008-invalid',
    })).toEqual({ ok: false, code: 'not_found' })
    updated(await inbox({ type: 'start', taskId: heldId, expectedVersion: held.version, cursor: 'pa008-start' }))
    const active = await waitForTask(() => readTask(heldId), task => task.status === 'running' && task.runtime === 'active', 'active worker')

    // The existing native composer uses session/prompt, independent of inbox control.
    expect(await rpc('session/prompt', { args: { request: {
      requestId: 'pa008-native-prompt', sessionId: nativeSessionId, mode: 'queue',
      content: [{ type: 'text', text: 'Keep the native conversation responsive.' }],
    } } })).toEqual({ accepted: true })
    const chat = await rpc<{ reason: string; output: { records: unknown[] } }>('session/wait', { args: {
      request: { sessionId: nativeSessionId, timeoutMs: 4_000 },
    } })
    expect(chat.reason).toBe('idle')
    expect(JSON.stringify(chat.output.records)).toContain('The native conversation stayed usable during the task.')
    expect(await readTask(heldId)).toMatchObject({ status: 'running', runtime: 'active', version: active.version })

    updated(await inbox({ type: 'start', taskId: resultId, expectedVersion: result.version, cursor: 'pa008-result' }))
    const candidate = await waitForTask(() => readTask(resultId),
      task => task.status === 'verifying' && task.canAccept === true && task.artifacts.length === 1,
      'released result candidate', host.diagnostics)
    const artifact = candidate.artifacts[0]
    assert.ok(artifact)
    const preview = await inbox({ type: 'artifact', taskId: resultId, artifactId: artifact.id })
    assert.ok(preview.ok && preview.kind === 'artifact', JSON.stringify(preview))
    expect(preview.artifact).toMatchObject({ id: artifact.id, version: 1, mediaType: 'text/markdown' })
    expect(preview.artifact.text).toBe(resultSummary)
    expect(await inbox({ type: 'artifact', taskId: heldId, artifactId: artifact.id })).toEqual({ ok: false, code: 'not_found' })
    expect(await inbox({ type: 'accept_result', taskId: resultId, expectedVersion: result.version }))
      .toEqual({ ok: false, code: 'version_conflict' })
    updated(await inbox({ type: 'accept_result', taskId: resultId, expectedVersion: candidate.version }))
    expect(await readTask(resultId)).toMatchObject({ status: 'completed', verifiedAt: expect.any(String) })
    expect(await inbox({ type: 'artifact', taskId: resultId, artifactId: artifact.id })).toEqual(preview)

    const approval = (await snapshot()).approvals.find(card => card.id === 'pa008-fixture-approval')
    assert.ok(approval)
    expect(approval).toMatchObject({
      kind: 'publish-notice', accountId: 'pa008-fixture-account', resourceRef: 'pa008-fixture-notice',
      recipient: 'pa008-fixture-recipient', dataScope: ['fixture-public'],
    })
    expect(JSON.parse(approval.preview)).toEqual({ text: 'Approved fixture notice only.' })
    const respond = {
      type: 'approval', requestId: approval.id, expectedVersion: approval.version,
      digest: approval.digest, decision: 'approve',
    } as const
    expect(await inbox({ ...respond, digest: approval.digest.replace(/^./u, approval.digest[0] === '0' ? '1' : '0') }))
      .toEqual({ ok: false, code: 'action_changed' })
    updated(await inbox(respond))
    expect((await snapshot()).approvals).toEqual([])
    expect(await inbox(respond)).toEqual({ ok: false, code: 'already_decided' })

    updated(await inbox({
      type: 'pause', taskId: heldId, expectedVersion: active.version, commandId: 'pa008-pause',
    }))
    const paused = await waitForTask(() => readTask(heldId), task => task.status === 'paused' && task.runtime === 'inactive', 'paused worker release')
    updated(await inbox({
      type: 'resume', taskId: heldId, expectedVersion: paused.version, commandId: 'pa008-resume',
    }))
    const queued = await readTask(heldId)
    expect(queued.status).toBe('queued')
    updated(await inbox({ type: 'start', taskId: heldId, expectedVersion: queued.version, cursor: 'pa008-resumed' }))
    const resumed = await readTask(heldId)
    updated(await inbox({
      type: 'redirect', taskId: heldId, expectedVersion: resumed.version, cursor: 'pa008-redirect',
      text: 'PA008_REDIRECT Ask the owner for the exact missing input.',
    }))
    const waiting = await waitForTask(() => readTask(heldId),
      task => task.status === 'waiting_input' && task.runtime === 'inactive', 'durable worker question')
    expect(waiting.wait).toMatchObject({ reason: 'input', referenceId: questionReference })
    const answer = {
      type: 'answer', taskId: heldId, expectedVersion: waiting.version, cursor: 'pa008-answer',
      referenceId: questionReference, text: 'Use the owner-confirmed fixture input.',
    } as const
    expect(await inbox({ ...answer, referenceId: 'wrong-question' })).toEqual({ ok: false, code: 'condition_unmet' })
    updated(await inbox(answer))
    const answered = await readTask(heldId)
    expect(answered.status).toBe('queued')
    updated(await inbox({ type: 'start', taskId: heldId, expectedVersion: answered.version, cursor: answer.cursor }))
    const running = await readTask(heldId)
    updated(await inbox({
      type: 'cancel', taskId: heldId, expectedVersion: running.version, commandId: 'pa008-cancel',
    }))
    await waitForTask(() => readTask(heldId), task => task.status === 'cancelled' && task.runtime === 'inactive', 'cancelled worker release')
    expect(await readTask(resultId)).toMatchObject({ status: 'completed', artifacts: [artifact] })
  }, 45_000)

  it('activates the production inbox through named Web profile configuration', async () => {
    const host = await openWebHost(probe, {
      configOnly: true,
      patch: [
        '- id: dshpa',
        '  config:',
        '    inbox:',
        "      storageDirectory: !!js dshHomePath('configured-inbox')",
        '      workRoot: !!js process.cwd()',
        '      worker:',
        '        provider: dshpa-web-fixture',
        '        model: fixture-worker',
      ],
    })
    const cookie = await host.exchange()
    expect(await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, { type: 'snapshot' }, cookie), host.diagnostics()).toMatchObject({
      status: 200,
      result: { ok: true, value: { ok: true, kind: 'snapshot', snapshot: {
        workerConfigured: true, projects: [], tasks: [], approvals: [],
      } } },
    })
    const operator = await host.exchange(true)
    expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'snapshot' }, operator)).toMatchObject({ status: 403 })
  }, 25_000)
})
