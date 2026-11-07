import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { contextCheckpointSchema } from '../../packages/personal-agent/src/context/checkpoint.js'
import {
  INBOX_RPC_ENDPOINT,
  type InboxPort,
  type InboxResponse,
  type InboxTask,
} from '../../packages/personal-agent/src/inbox/protocol.js'
import { DATABASE_FILENAME } from '../../packages/personal-agent/src/storage/database.js'
import { openWebHost, prepareWebHost } from './fixtures/web-host.js'

const probe = fileURLToPath(new URL('./fixtures/local-flow-probe.mjs', import.meta.url))
const contextProbe = fileURLToPath(new URL('./fixtures/context-flow-probe.mjs', import.meta.url))
const memoryProbe = fileURLToPath(new URL('./fixtures/memory-flow-probe.mjs', import.meta.url))
const projectProbe = fileURLToPath(new URL('./fixtures/project-flow-probe.mjs', import.meta.url))
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
  it('searches explicit local documents through the owner carrier and rejects stale source revisions', async () => {
    const host = await openWebHost(memoryProbe, { patch: [
      '- id: dshpa', '  config:', '    inbox:',
      "      storageDirectory: !!js dshHomePath('knowledge-inbox')", '      workRoot: !!js process.cwd()',
      '      knowledge:', '        roots:', '          - id: llmwiki',
      "            directory: !!js process.cwd() + '/missing-wiki'", '          - id: workbench',
      "            directory: !!js process.cwd() + '/configured-knowledge'", '            include: ["**/*.md"]',
    ] })
    const directory = join(host.root, 'configured-knowledge')
    mkdirSync(directory)
    const file = join(directory, '源资料.md')
    const original = '设计 Review 证据。<img src=x onerror=alert(1)>'
    writeFileSync(file, original)
    const query = { type: 'knowledge_search', query: '设计 review' } as const
    const cookie = await host.exchange()
    const inbox: InboxPort = async request => {
      const result = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, cookie)
      assert.ok(result.status === 200 && result.result?.ok, host.diagnostics())
      return result.result.value
    }
    expect(await host.rpc(INBOX_RPC_ENDPOINT, query)).toMatchObject({ status: 401 })
    expect(await host.rpc(INBOX_RPC_ENDPOINT, query, await host.exchange(true))).toMatchObject({ status: 403 })
    expect(await inbox({ type: 'snapshot' })).toMatchObject({ snapshot: { knowledgeConfigured: true } })
    const search = await inbox(query)
    assert.ok(search.ok && search.kind === 'knowledge_search' && search.hits.length === 1, JSON.stringify(search))
    expect(search.roots).toEqual([{ id: 'llmwiki', status: 'unavailable', files: 0 }, { id: 'workbench', status: 'available', files: 1 }])
    const source = search.hits[0]!
    expect(source.path).toBe('源资料.md')
    expect(JSON.stringify(search)).not.toContain(host.root)
    const read = { type: 'knowledge_read', ref: source.ref, revision: source.revision } as const
    expect(await inbox(read)).toMatchObject({ kind: 'knowledge_page', text: original })
    writeFileSync(file, '新版设计 Review')
    expect(await inbox(read)).toEqual({ ok: false, code: 'stale_source' })
    expect(await inbox(query)).toMatchObject({ hits: [{ ref: source.ref, snippet: '新版设计 Review' }] })
    rmSync(file)
    expect(await inbox(query)).toMatchObject({ hits: [] })
  }, 20_000)

  it('reviews and executes a goal plan with sourced Worker drafts and verified prerequisites', async () => {
    const host = await openWebHost(projectProbe, { patch: [
      '- id: dshpa', '  config:', '    inbox:',
      "      storageDirectory: !!js dshHomePath('project-inbox')",
      '      workRoot: !!js process.cwd()', '      worker:', '        provider: pa014-project-fixture',
      '        model: project-worker', '        concurrency: 1', '        unmetered: true',
    ] })
    const cookie = await host.exchange()
    const inbox: InboxPort = async request => {
      const response = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, cookie)
      assert.ok(response.status === 200 && response.result?.ok, host.diagnostics())
      return response.result.value
    }
    async function readTask(taskId: string) {
      const result = await inbox({ type: 'snapshot' })
      assert.ok(result.ok && result.kind === 'snapshot')
      const task = result.snapshot.tasks.find(candidate => candidate.id === taskId)
      assert.ok(task)
      return task
    }
    const draft = { title: 'Evidence goal', purpose: 'Finish the brief and a separate review.', successCriteria: ['Accept two sourced artifacts.'],
      priority: 'normal' as const, milestones: [{ title: 'Review published brief' }], reviewCadence: { intervalDays: 7, timeZone: 'UTC' } }
    const create = { type: 'save_plan', commandId: 'pa014-goal', draft, rationale: 'Track the outcomes in one goal.' } as const
    const projectId = updated(await inbox(create)).projectId
    const other = updated(await inbox({ type: 'create_project', commandId: 'pa014-other', title: 'Other project', purpose: 'Competing work.' })).projectId
    assert.ok(projectId && other)
    const parent = updated(await inbox({ type: 'create_task', projectId, commandId: 'pa014-parent-task',
      sessionId: 'pa014-primary', outcome: 'Draft a sourced brief.' })).taskId
    const otherTask = updated(await inbox({ type: 'create_task', projectId: other, commandId: 'pa014-other-task',
      sessionId: 'pa014-primary', outcome: 'Independent work.' })).taskId
    assert.ok(parent && otherTask)
    expect(await inbox({ type: 'project_review' })).toMatchObject({ kind: 'project_review', needsPriority: true })
    const edit = { ...create, projectId, expectedRevision: 1, commandId: 'pa014-priority',
      draft: { ...create.draft, priority: 'high' }, rationale: 'Finish this goal first.' } as const
    updated(await inbox(edit))
    expect(await inbox({ type: 'project_plan', projectId })).toMatchObject({ plan: { kind: 'goal', revision: 2,
      history: [{ revision: 2, rationale: edit.rationale }, { revision: 1, rationale: create.rationale }] } })
    expect(await inbox({ type: 'project_review' })).toMatchObject({ kind: 'project_review', needsPriority: false,
      projects: [{ projectId, priority: 'high', ready: [parent] }, { projectId: other, ready: [otherTask] }] })
    const start = await readTask(parent)
    updated(await inbox({ type: 'start', taskId: parent, expectedVersion: start.version, cursor: 'pa014-draft' }))
    const proposed = await waitForTask(() => readTask(parent), task => Boolean(task.proposal), 'Worker draft', host.diagnostics)
    expect(proposed.status).toBe('running')
    expect(proposed.artifacts).toEqual([])
    const accept = { type: 'accept_plan_step', taskId: parent, cursor: 'pa014-draft', index: 0 } as const
    const child = updated(await inbox(accept)).taskId
    assert.ok(child)
    expect(updated(await inbox(accept)).taskId).toBe(child)
    const queued = await readTask(child)
    const deps = { type: 'set_prerequisites', taskId: child, expectedVersion: queued.version } as const
    expect(await inbox({ ...deps, prerequisiteIds: [otherTask] })).toEqual({ ok: false, code: 'not_found' })
    updated(await inbox({ ...deps, prerequisiteIds: [parent] }))
    expect(await readTask(child)).toMatchObject({ status: 'blocked', wait: { referenceId: parent } })
    updated(await inbox({ type: 'redirect', taskId: parent, expectedVersion: proposed.version, cursor: 'pa014-parent', text: 'Prepare the brief.' }))
    const parentResult = await waitForTask(() => readTask(parent), task => task.status === 'verifying' && task.runtime === 'inactive',
      'parent verification', host.diagnostics)
    expect(await readTask(child)).toMatchObject({ status: 'blocked' })
    expect(await inbox(accept)).toEqual({ ok: false, code: 'not_found' })
    updated(await inbox({ type: 'accept_result', taskId: parent, expectedVersion: parentResult.version }))
    const ready = await readTask(child)
    expect(ready.status).toBe('queued')
    updated(await inbox({ type: 'start', taskId: child, expectedVersion: ready.version, cursor: 'pa014-child' }))
    const childResult = await waitForTask(() => readTask(child), task => task.status === 'verifying' && task.runtime === 'inactive',
      'child verification', host.diagnostics)
    expect(parentResult.artifacts[0]?.id).not.toBe(childResult.artifacts[0]?.id)
    updated(await inbox({ type: 'accept_result', taskId: child, expectedVersion: childResult.version }))
    expect(await inbox({ type: 'project_review' })).toMatchObject({ projects: [
      { projectId, accepted: expect.arrayContaining([parent, child]) }, { projectId: other, accepted: [] },
    ] })
    const db = new DatabaseSync(join(host.root, 'home', 'project-inbox', DATABASE_FILENAME), { readOnly: true })
    try { expect(db.prepare('SELECT count(*) AS total FROM routines').get()?.total).toBe(0) }
    finally { db.close() }
  }, 30_000)

  it('keeps owner corrections and forgetting across native restart and a stale memory provider', async () => {
    const bundle = fileURLToPath(new URL('../../packages/memory-sqlite/', import.meta.url))
    const prepared = prepareWebHost(memoryProbe, [
      '- id: dshpa',
      '  config:',
      '    inbox:',
      "      storageDirectory: !!js dshHomePath('memory-inbox')",
      '      workRoot: !!js process.cwd()',
      '      memory:',
      '        provider:',
      '          kind: memory',
      '          instanceId: local-memory',
      '          pluginId: "@mosbot-ai/dshpa-memory-sqlite"',
      '          pluginVersion: "0.0.0"',
      '          configRevision: 1',
    ], [bundle])
    const scope = { kind: 'profile' } as const
    const remember = { type: 'memory_remember', commandId: 'pa012-web-remember', scope, text: 'Fixture memory. 旧版蓝海偏好。' } as const
    const memoryFile = join(prepared.dshHome, 'dshpa-memory', 'memory.sqlite')
    const olderCopy = join(prepared.root, 'provider-before-correction.sqlite')
    let host: Awaited<ReturnType<typeof openWebHost>> | undefined
    const start = async () => {
      const live = await openWebHost(memoryProbe, { prepared })
      host = live
      const cookie = await live.exchange()
      const inbox: InboxPort = async request => {
        const response = await live.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, cookie)
        assert.ok(response.status === 200 && response.result?.ok, live.diagnostics())
        return response.result.value
      }
      return inbox
    }
    function completed(response: InboxResponse) {
      assert.ok(response.ok && response.kind === 'memory_change' && response.state === 'completed', JSON.stringify(response))
      return response
    }
    const empty = { ok: true, kind: 'memory_records', confirmed: [], inferred: [] }
    try {
      const first = await start()
      expect(await first({ type: 'snapshot' })).toMatchObject({ ok: true, snapshot: { memoryConfigured: true } })
      expect(await host!.rpc(INBOX_RPC_ENDPOINT, remember)).toMatchObject({ status: 401 })
      expect(await host!.rpc(INBOX_RPC_ENDPOINT, remember, await host!.exchange(true))).toMatchObject({ status: 403 })
      const original = completed(await first(remember))
      expect(completed(await first(remember))).toEqual(original)
      expect(await first({ ...remember, text: 'Changed replay' })).toMatchObject({ ok: false })
      expect(await first({ type: 'memory_search', scope, query: '蓝海偏好' })).toMatchObject({
        ok: true, kind: 'memory_records', confirmed: [{ id: original.recordId, origin: 'explicit', confidence: 1,
          sourceEventIds: [expect.any(String)], value: { text: remember.text } }], inferred: [],
      })
      const project = updated(await first({ type: 'create_project', commandId: 'pa012-isolation-project', title: 'Memory scope', purpose: 'Scope test' }))
      assert.ok(project.projectId)
      expect(await first({ type: 'memory_inspect', scope: { kind: 'project', projectId: project.projectId }, recordId: original.recordId }))
        .toEqual(empty)
      await host!.close()
      copyFileSync(memoryFile, olderCopy)

      const second = await start()
      const previous = { type: 'memory_inspect', scope, recordId: original.recordId } as const
      expect(await second(previous)).toMatchObject({ confirmed: [{ id: original.recordId }] })
      const corrected = completed(await second({ type: 'memory_correct', scope, commandId: 'pa012-web-correct',
        recordId: original.recordId, expectedRevision: original.revision, text: 'Fixture memory. 修订后的绿色偏好。' }))
      expect(corrected.recordId).not.toBe(original.recordId)
      expect(await second(previous)).toEqual(empty)
      expect(await second({ type: 'memory_search', scope, query: '绿色偏好' })).toMatchObject({ confirmed: [{ id: corrected.recordId }] })
      const forget = { type: 'memory_forget', scope, commandId: 'pa012-web-forget', recordId: corrected.recordId,
        expectedRevision: corrected.revision } as const
      const forgotten = completed(await second(forget))
      expect(completed(await second(forget))).toEqual(forgotten)
      expect(await second({ ...previous, recordId: corrected.recordId })).toEqual(empty)
      await host!.close()
      copyFileSync(olderCopy, memoryFile)

      const restarted = await start()
      completed(await restarted({ ...remember, commandId: 'pa012-web-new-after-rollback', text: 'Fresh evidence.' }))
      expect(await restarted(previous)).toEqual(empty)
      expect(await restarted({ ...previous, recordId: corrected.recordId })).toEqual(empty)
      expect(await restarted({ type: 'memory_search', scope, query: '蓝海偏好' })).toEqual(empty)
      expect(await restarted({ type: 'memory_search', scope, query: '绿色偏好' })).toEqual(empty)
    } finally {
      await host?.close()
      rmSync(prepared.root, { recursive: true, force: true })
    }
  }, 45_000)

  it('uses configured context recall, native compaction, Worker admission and exclusion through the Web owner carrier', async () => {
    const host = await openWebHost(contextProbe, { configOnly: true, patch: [
      '- id: compaction-basic',
      '  disabled: true',
      '- id: tool-result-pruner',
      '  disabled: true',
      '- insert:',
      '    - id: dshpa-checkpoint-compaction',
      '      name: "@mosbot-ai/dshpa/checkpoint-compaction"',
      '      config: { auto: false }',
      '    - id: dshpa-checkpoint-pruner',
      '      name: "@mosbot-ai/dshpa/checkpoint-pruner"',
      '    - id: preset-dshpa-context',
      '      name: "@deepseek-ai/dsh-agent-preset"',
      '      config:',
      '        id: dshpa-context',
      '        order: 90',
      '        plugins:',
      '          - id: compaction',
      '            name: cordis:group',
      '            group: true',
      '            isolate:',
      '              compaction: true',
      '              toolResultPruner: true',
      '              dshpaCheckpointCompactionReady: true',
      '              dshpaCheckpointPrunerReady: true',
      '            config:',
      '              - id: dshpa-checkpoint-compaction',
      '                name: "@mosbot-ai/dshpa/checkpoint-compaction"',
      '                config: { auto: false }',
      '              - id: command-compact',
      '                name: "@deepseek-ai/dsh-command-compact"',
      '              - id: dshpa-checkpoint-pruner',
      '                name: "@mosbot-ai/dshpa/checkpoint-pruner"',
      '- id: dshpa',
      '  config:',
      '    inbox:',
      "      storageDirectory: !!js dshHomePath('context-inbox')",
      '      workRoot: !!js process.cwd()',
      '      context: {}',
      '      worker:',
      '        provider: pa011-context-fixture',
      '        model: context-worker',
    ] })
    const cookie = await host.exchange()
    async function rpc<T>(method: string, payload: unknown): Promise<T> {
      const response = await host.rpc<T>(method, payload, cookie)
      assert.ok(response.status === 200 && response.result?.ok, `${method}: ${JSON.stringify(response)}\n${host.diagnostics()}`)
      return response.result.value
    }
    const inbox: InboxPort = request => rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request)
    function contextValue(response: InboxResponse) {
      assert.ok(response.ok && response.kind === 'context', JSON.stringify(response))
      return response.value
    }
    async function readTask(taskId: string) {
      const response = await inbox({ type: 'snapshot' })
      assert.ok(response.ok && response.kind === 'snapshot', JSON.stringify(response))
      const task = response.snapshot.tasks.find(item => item.id === taskId)
      assert.ok(task)
      return task
    }
    const project = updated(await inbox({ type: 'create_project', commandId: 'pa011-web-create-project',
      title: 'Web context fixture', purpose: 'Keep context inside the requested task.' }))
    assert.ok(project.projectId)
    const primary = 'pa011-web-context-primary'
    const foreign = 'pa011-web-context-foreign'
    const stock = 'pa011-web-context-stock'
    const listed = await inbox({ type: 'snapshot' })
    assert.ok(listed.ok && listed.kind === 'snapshot', JSON.stringify(listed))
    expect(listed.snapshot.sessions.map(session => session.id)).toEqual(expect.arrayContaining([primary, foreign]))
    expect(listed.snapshot.sessions.some(session => session.id === stock)).toBe(false)
    expect(await inbox({ type: 'create_task', commandId: 'pa011-web-create-stock', projectId: project.projectId,
      sessionId: stock, outcome: 'Reject the unguarded native preset.' })).toEqual({ ok: false, code: 'not_found' })
    const local = updated(await inbox({ type: 'create_task', commandId: 'pa011-web-create-primary',
      projectId: project.projectId, sessionId: primary, outcome: '整理蓝海目标。 Prepare the scoped context result.' }))
    const other = updated(await inbox({ type: 'create_task', commandId: 'pa011-web-create-other',
      projectId: project.projectId, sessionId: foreign, outcome: 'Foreign Indigo Canary' }))
    assert.ok(local.taskId && other.taskId)
    const taskId = local.taskId
    expect(await readTask(taskId)).toMatchObject({ sessionId: primary })
    const taskRef = { kind: 'task', taskId } as const
    const recallTask = { type: 'context_recall', taskId, ref: taskRef } as const
    expect(await host.rpc(INBOX_RPC_ENDPOINT, recallTask)).toMatchObject({ status: 401 })
    expect(await host.rpc(INBOX_RPC_ENDPOINT, recallTask, await host.exchange(true))).toMatchObject({ status: 403 })
    expect(contextValue(await inbox(recallTask))).toMatchObject({ ref: taskRef, text: expect.stringContaining('蓝海目标') })
    expect(await inbox({ ...recallTask, ref: { kind: 'task', taskId: other.taskId } }))
      .toEqual({ ok: false, code: 'permission_denied' })
    expect(contextValue(await inbox({ type: 'context_search', taskId, query: '蓝海目标' })))
      .toContainEqual(expect.objectContaining({ ref: taskRef, summary: expect.stringContaining('蓝海目标') }))
    expect(contextValue(await inbox({ type: 'context_search', taskId, query: 'Foreign Indigo Canary' }))).toEqual([])
    expect(contextValue(await inbox({ type: 'context_checkpoint', taskId }))).toBeNull()

    async function compactNative(label: string) {
      expect(await rpc('session/prompt', { args: { request: {
        requestId: `pa011-native-prompt-${label}`, sessionId: primary, mode: 'queue',
        content: [{ type: 'text', text: `${label} ${'Long context fixture text. '.repeat(140)}` }],
      } } })).toEqual({ accepted: true })
      expect(await rpc('session/wait', { args: { request: { sessionId: primary, timeoutMs: 4_000 } } }))
        .toMatchObject({ reason: 'idle' })
      const compacted = await rpc<{ result: { kind: string; sourceEventSeq?: number } }>('commands/execute', {
        args: { agentId: primary, line: '/compact', submittedAttachments: [] },
      })
      if (compacted.result.kind !== 'success') {
        const checkpoint = await inbox({ type: 'context_checkpoint', taskId })
        assert.fail(`${JSON.stringify(compacted)}\n${JSON.stringify(checkpoint)}\n${host.diagnostics()}`)
      }
      expect(compacted.result.sourceEventSeq).toEqual(expect.any(Number))
    }
    await compactNative('first')
    expect(contextValue(await inbox({ type: 'context_checkpoint', taskId })))
      .toMatchObject({ id: expect.any(String), revision: 1, current: true })
    const queued = await readTask(taskId)
    updated(await inbox({ type: 'start', taskId, expectedVersion: queued.version, cursor: 'pa011-web-worker-start' }))
    const waiting = await waitForTask(() => readTask(taskId),
      task => task.status === 'waiting_input' && task.runtime === 'inactive', 'scoped Worker question', host.diagnostics)
    expect(waiting.wait).toMatchObject({ reason: 'input', referenceId: 'pa011-web-question' })
    await compactNative('question')
    expect(contextValue(await inbox({ type: 'context_checkpoint', taskId })))
      .toMatchObject({ revision: 2, taskVersion: waiting.version, current: true })
    const answer = { type: 'answer', taskId, expectedVersion: waiting.version, referenceId: 'pa011-web-question',
      cursor: 'pa011-web-worker-answer', text: 'Owner confirmation. 周五复核。' } as const
    expect(await inbox({ ...answer, referenceId: 'wrong-question' })).toEqual({ ok: false, code: 'condition_unmet' })
    updated(await inbox(answer))
    const answerHits = contextValue(await inbox({ type: 'context_search', taskId, query: '周五复核' }))
    assert.ok(Array.isArray(answerHits))
    const ownerDecision = answerHits.find(hit => hit.ref.kind === 'event')
    expect(ownerDecision).toMatchObject({ ref: { kind: 'event', eventId: expect.any(String) }, summary: expect.stringContaining('周五复核') })
    const requeued = await readTask(taskId)
    updated(await inbox({ type: 'start', taskId, expectedVersion: requeued.version, cursor: answer.cursor }))
    const verifying = await waitForTask(() => readTask(taskId),
      task => task.status === 'verifying' && task.runtime === 'inactive' && task.artifacts.length === 1,
      'Worker result after scoped context handoff', host.diagnostics)
    const artifactId = verifying.artifacts[0]!.id
    const artifactRef = { kind: 'artifact', artifactId } as const
    const recallArtifact = { type: 'context_recall', taskId, ref: artifactRef } as const
    expect(contextValue(await inbox(recallArtifact))).toMatchObject({ ref: artifactRef, text: expect.stringContaining('独特结果标记') })
    expect(contextValue(await inbox({ type: 'context_search', taskId, query: '独特结果标记' })))
      .toContainEqual(expect.objectContaining({ ref: artifactRef }))
    await compactNative('result')
    expect(contextValue(await inbox({ type: 'context_checkpoint', taskId })))
      .toMatchObject({ revision: 3, taskVersion: verifying.version, current: true })
    const db = new DatabaseSync(join(host.root, 'home', 'context-inbox', DATABASE_FILENAME), { readOnly: true })
    try {
      const checkpoints = db.prepare('SELECT record FROM context_checkpoints WHERE task_id = ? ORDER BY revision').all(taskId)
        .map(row => contextCheckpointSchema.parse(JSON.parse(String(row.record))))
      expect(checkpoints[1]).toMatchObject({ wait: { reason: 'input', referenceId: answer.referenceId }, taskVersion: waiting.version })
      expect(checkpoints[2]).toMatchObject({ decisions: [{ text: answer.text, sources: [ownerDecision.ref] }], taskVersion: verifying.version })
    } finally {
      db.close()
    }
    const exclude = { type: 'context_exclude', taskId, ref: artifactRef, expectedVersion: verifying.version, reason: 'forgotten' } as const
    expect(await inbox({ ...exclude, expectedVersion: queued.version })).toEqual({ ok: false, code: 'version_conflict' })
    expect(await inbox(exclude)).toEqual({ ok: true, kind: 'updated', taskId })
    expect(await inbox(recallArtifact)).toEqual({ ok: false, code: 'source_unavailable' })
    expect(contextValue(await inbox({ type: 'context_search', taskId, query: '独特结果标记' }))).toEqual([])

    const otherId = other.taskId
    const originalOther = await readTask(otherId)
    updated(await inbox({ type: 'start', taskId: otherId, expectedVersion: originalOther.version, cursor: 'pa011-web-revocation-1' }))
    const firstOtherWait = await waitForTask(() => readTask(otherId),
      task => task.status === 'waiting_input' && task.runtime === 'inactive', 'first revocation fixture wait', host.diagnostics)
    updated(await inbox({ type: 'answer', taskId: otherId, expectedVersion: firstOtherWait.version,
      referenceId: 'pa011-web-revocation-1-question', cursor: 'pa011-web-revocation-2', text: '择期复核证据。' }))
    const firstOtherAnswer = await readTask(otherId)
    updated(await inbox({ type: 'start', taskId: otherId, expectedVersion: firstOtherAnswer.version, cursor: 'pa011-web-revocation-2' }))
    const secondOtherWait = await waitForTask(() => readTask(otherId),
      task => task.status === 'waiting_input' && task.runtime === 'inactive', 'second revocation fixture wait', host.diagnostics)
    const hits = contextValue(await inbox({ type: 'context_search', taskId: otherId, query: '择期复核证据' }))
    assert.ok(Array.isArray(hits))
    const used = hits.find(hit => hit.ref.kind === 'event')
    assert.ok(used)
    updated(await inbox({ type: 'context_exclude', taskId: otherId, ref: used.ref,
      expectedVersion: secondOtherWait.version, reason: 'superseded' }))
    const stillWaiting = await readTask(otherId)
    updated(await inbox({ type: 'answer', taskId: otherId, expectedVersion: stillWaiting.version,
      referenceId: 'pa011-web-revocation-2-question', cursor: 'pa011-web-revocation-3', text: 'Use current evidence only.' }))
    const retiredHistory = await readTask(otherId)
    expect(await inbox({ type: 'start', taskId: otherId, expectedVersion: retiredHistory.version, cursor: 'pa011-web-revocation-3' }))
      .toEqual({ ok: false, code: 'permission_denied' })
    expect(await readTask(otherId)).toMatchObject({ status: 'queued', version: retiredHistory.version })
  }, 45_000)

  it('records one native timed reminder and one independently keyed manual reminder without a model', async () => {
    const host = await openWebHost(probe, { configOnly: true, patch: [
      '- id: schedule',
      '  inject: [dshpaScheduleResolverReady]',
      '- id: dshpa',
      '  config:',
      '    inbox:',
      "      storageDirectory: !!js dshHomePath('routine-inbox')",
      "      workRoot: !!js dshHomePath('routine-work')",
      '      routines: true',
      '      sourceAccounts:',
      '        - sourceInstanceId: pa008-fixture-connector',
      '          accountId: pa008-fixture-account',
      '          verifiedAt: "2026-11-07T08:00:00.000Z"',
      '        - sourceInstanceId: dshpa-internal-routine',
      '          accountId: fixture-forged-routine',
      '          verifiedAt: "2026-11-07T08:00:00.000Z"',
    ] })
    const cookie = await host.exchange()
    const inbox: InboxPort = async request => {
      const response = await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, request, cookie)
      assert.ok(response.status === 200 && response.result?.ok, host.diagnostics())
      return response.result.value
    }
    async function snapshot() {
      const response = await inbox({ type: 'snapshot' })
      assert.ok(response.ok && response.kind === 'snapshot' && response.snapshot.schedules, JSON.stringify(response))
      return { schedules: response.snapshot.schedules, sessions: response.snapshot.sessions, usage: response.snapshot.usage }
    }
    const intendedAt = new Date(Date.now() + 3_500).toISOString()
    updated(await inbox({ type: 'save_routine', commandId: 'pa018-save-reminder', draft: {
      title: 'Review the native wake', timing: { kind: 'at', at: intendedAt }, misfire: 'skip',
      target: { kind: 'reminder', text: 'Read this in the local inbox.' },
    } }))
    const draft = (await snapshot()).schedules.routines[0]
    assert.ok(draft)
    expect(draft.state).toBe('draft')
    expect(draft.nextAt).toBeUndefined()
    expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'arm_routine', commandId: 'pa018-forged-arm', routineId: draft.id,
      expectedRevision: draft.revision })).toMatchObject({ status: 401 })
    updated(await inbox({ type: 'arm_routine', commandId: 'pa018-arm-reminder', routineId: draft.id, expectedRevision: draft.revision }))
    const armed = (await snapshot()).schedules.routines[0]
    assert.ok(armed && armed.state === 'armed')
    expect(armed.nextAt).toBe(intendedAt)
    const manual = { type: 'run_routine_now', commandId: 'pa018-run-manually', routineId: armed.id, expectedRevision: armed.revision } as const
    updated(await inbox(manual))
    updated(await inbox(manual))
    expect((await snapshot()).schedules.reminders).toHaveLength(1)

    let current = await snapshot()
    const deadline = performance.now() + 7_000
    while (current.schedules.reminders.length < 2 && performance.now() < deadline) {
      await delay(40)
      current = await snapshot()
    }
    expect(current.schedules.reminders, host.diagnostics()).toHaveLength(2)
    expect(new Set(current.schedules.reminders.map(item => item.id)).size).toBe(2)
    expect(current.schedules.reminders).toContainEqual(expect.objectContaining({ intendedAt, text: 'Read this in the local inbox.' }))
    expect(current.schedules.routines[0]).toMatchObject({ state: 'ended', last: { status: 'reminded' } })
    expect(current.sessions.some(session => session.id.startsWith('dshpa-routine-sink-'))).toBe(false)
    expect(current.usage).toMatchObject({ calls: 0, workerSlots: { active: 0 }, attention: { unsolicited: 0 } })
  }, 25_000)

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
    expect(initial.usage).toMatchObject({ unknownCalls: 0, gpu: { active: 0, queued: 0, limit: 1 },
      attention: { mode: 'off', version: 0, unsolicited: 0, limit: 3 } })
    const policy = { mode: 'observe', timeZone: 'Asia/Shanghai', quietHours: { start: '22:00', end: '08:00' }, urgentRules: [] }
    expect(await inbox({ type: 'set_attention_policy', expectedVersion: 0, policy }))
      .toEqual({ ok: true, kind: 'attention_policy', version: 1 })
    expect(await inbox({ type: 'set_attention_policy', expectedVersion: 0, policy }))
      .toEqual({ ok: false, code: 'version_conflict' })
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
    const subscription = {
      sourceInstanceId: 'pa008-fixture-connector', accountId: 'pa008-fixture-account', threadId: 'fixture-subscription',
      projectId: fixtureProjectId, taskId: heldId, mode: 'context', enabled: true,
    } as const
    expect(await inbox({ type: 'set_subscription', subscription })).toEqual({ ok: true, kind: 'subscription', version: 1 })
    expect(await inbox({ type: 'set_subscription', subscription })).toEqual({ ok: false, code: 'version_conflict' })
    expect(await inbox({ type: 'set_subscription', subscription: { ...subscription, enabled: false, expectedVersion: 1 } }))
      .toEqual({ ok: true, kind: 'subscription', version: 2 })
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
    const progressId = await createTask('progress', 'PA013_PROGRESS Record a workspace update.')
    const queuedProgress = await readTask(progressId)
    updated(await inbox({ type: 'start', taskId: progressId, expectedVersion: queuedProgress.version, cursor: 'pa013-progress' }))
    const progressed = await waitForTask(() => readTask(progressId), task => Boolean(task.progress), 'coalesced progress', host.diagnostics)
    expect(progressed.progress).toMatchObject({ summary: 'Recorded one scoped workspace update.' })
    const usage = (await snapshot()).usage
    expect(usage).toMatchObject({ currencies: [], attention: { mode: 'observe', version: 1, timeZone: 'Asia/Shanghai' } })
    expect(usage?.unknownCalls).toBeGreaterThan(0)
    updated(await inbox({ type: 'cancel', taskId: progressId, expectedVersion: progressed.version, commandId: 'pa013-cancel-progress' }))

    const limitedId = await createTask('limited', 'PA013_RATE_LIMIT Exercise provider cooldown.')
    const beforeLimit = await readTask(limitedId)
    updated(await inbox({ type: 'start', taskId: limitedId, expectedVersion: beforeLimit.version, cursor: 'pa013-rate-limit' }))
    const limited = await waitForTask(() => readTask(limitedId), task => task.status === 'waiting_resource' && task.canResumeCompute === true,
      'released provider cooldown', host.diagnostics)
    expect(limited.runtime).toBe('inactive')
    assert.ok(limited.wait?.notBefore)
    await delay(Math.max(0, Date.parse(limited.wait.notBefore) - Date.now() + 20))
    updated(await inbox({ type: 'resume', taskId: limitedId, expectedVersion: limited.version, commandId: 'pa013-resume-rate' }))
    const requeued = await readTask(limitedId)
    expect(requeued.status).toBe('queued')
    updated(await inbox({ type: 'start', taskId: limitedId, expectedVersion: requeued.version, cursor: 'pa013-retry-rate' }))
    const retried = await waitForTask(() => readTask(limitedId), task => Boolean(task.progress), 'owner retry after cooldown', host.diagnostics)
    expect(retried.progress?.summary).toBe('Owner retried after the cooldown.')
    updated(await inbox({ type: 'cancel', taskId: limitedId, expectedVersion: retried.version, commandId: 'pa013-cancel-rate' }))
  }, 45_000)

  it.each([
    { label: 'unmetered assessment and Worker', worker: true, routing: 'configured' },
    { label: 'unpriced optional assessment without a Worker', worker: false, routing: 'pricing_unavailable' },
  ])('activates the configured inbox with $label', async ({ worker, routing }) => {
    const host = await openWebHost(probe, {
      configOnly: true,
      patch: [
        '- id: dshpa',
        '  config:',
        '    inbox:',
        "      storageDirectory: !!js dshHomePath('configured-inbox')",
        '      workRoot: !!js process.cwd()',
        '      sourceAccounts:',
        '        - sourceInstanceId: pa008-fixture-connector',
        '          accountId: pa008-fixture-account',
        '          verifiedAt: "2026-11-07T08:00:00.000Z"',
        ...(worker ? ['      worker:', '        provider: dshpa-web-fixture', '        model: fixture-worker'] : []),
        '      routing:',
        '        provider: dshpa-web-fixture',
        '        model: fixture-routing',
        '        dataScope: [fixture-public]',
        ...(worker ? ['        unmetered: true'] : []),
      ],
    })
    const cookie = await host.exchange()
    expect(await host.rpc<InboxResponse>(INBOX_RPC_ENDPOINT, { type: 'snapshot' }, cookie), host.diagnostics()).toMatchObject({
      status: 200,
      result: { ok: true, value: { ok: true, kind: 'snapshot', snapshot: {
        workerConfigured: worker, projects: [], tasks: [], approvals: [], usage: { routing },
      } } },
    })
    const operator = await host.exchange(true)
    expect(await host.rpc(INBOX_RPC_ENDPOINT, { type: 'snapshot' }, operator)).toMatchObject({ status: 403 })
  }, 25_000)
})
