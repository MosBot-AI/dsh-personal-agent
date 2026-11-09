import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const app = dirname(require.resolve('@mosbot-ai/dshpa'))
const { activateLocalInbox } = await import(pathToFileURL(join(app, 'inbox', 'host.js')).href)

const cli = createRequire(process.argv[1])
const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
const { LlmAdapter } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)
const provider = 'pa031-browser-fixture'
const model = 'browser-worker'
const name = 'mcp__chrome-devtools-mcp__dshpa_browser'
const text = 'PA031 verified browser value'

export const inject = ['dshpaBrowserChrome', 'llm', 'tools', 'agents', 'dshpa', 'appReady', 'appExit', 'sessionController', 'webServer', 'connection', 'sessions']

async function initialize(ctx) {
  const steps = new Map()
  class FixtureModel extends LlmAdapter {
    async listModels() { return [{ provider, id: model, name: model }] }
    async resolveModel() { return { provider, id: model, name: model, context: { contextWindow: 65_536 } } }

    async *stream(options) {
      const input = options.messages.findLast(message => message.source?.kind === 'dshpa-work-input')
      assert.ok(input)
      const cursor = input.source.cursor
      assert.ok(['pa031-browser-live', 'pa031-browser-other', 'pa031-browser-hold', 'pa031-browser-redirect'].includes(cursor))
      assert.deepEqual(options.tools?.map(tool => tool.name), [name])
      const current = steps.get(cursor) ?? 0
      steps.set(cursor, current + 1)
      let request
      if (cursor === 'pa031-browser-hold' || cursor === 'pa031-browser-redirect') {
        const text = input.content.find(block => block.type === 'text')?.text ?? ''
        const url = /http:\/\/127\.0\.0\.1:\d+\/(?:hold|redirect)/u.exec(text)?.[0]
        assert.ok(url)
        request = { method: 'navigate', url }
      } else if ([0, 2, 4].includes(current)) request = { method: 'observe' }
      else {
        const observed = options.messages.findLast(message => message.role === 'tool')
        const result = JSON.parse(observed.content.find(block => block.type === 'text').text)
        assert.equal(result.ok, true)
        if (current === 1 || current === 3) {
          const element = result.elements.find(row => row.name === (current === 1 ? 'Message' : 'Save message'))
          assert.ok(element, JSON.stringify(result.elements))
          request = current === 1 ? { method: 'fill', uid: element.uid, snapshot: result.snapshot, value: text }
            : { method: 'click', uid: element.uid, snapshot: result.snapshot }
        } else {
          assert.ok(result.elements.some(row => row.name === 'Saved'), JSON.stringify(result.elements))
        }
      }
      if (request) {
        const block = { type: 'tool-call', id: `browser-${current}`, name, arguments: JSON.stringify(request) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 0, block }
      } else {
        const report = JSON.stringify({ kind: 'ready', cursor: input.source.cursor,
          summary: 'Verified the saved browser message.', artifactIds: [] })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: report }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: report } }
      }
      yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 5, totalTokens: 21 } }
      yield { type: 'finish', reason: { kind: request ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter([provider], new FixtureModel())

  let accepted
  let pushed = false
  const draftProvider = {
    async open(_signal, current) {
      assert.ok(current())
      return {
        current,
        async baseHead() { return 'a'.repeat(40) },
        async prepare() { return { sha: 'b'.repeat(40), close() {}, async publish() { assert.ok(current()); pushed = true } } },
        async createPull(payload) {
          assert.ok(current() && pushed)
          accepted = payload
        },
        async lookup(payload) {
          return payload.body === accepted?.body ? 'https://github.com/TestOrg/DedicatedTest/pull/9' : undefined
        },
      }
    },
  }
  const origin = ctx.get('dshpaBrowserChrome')?.origins?.[0]
  assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/u)
  const local = activateLocalInbox(ctx, ctx.dshpa.host, {
    storageDirectory: join(process.env.DSH_HOME, 'github-draft-inbox'), workRoot: process.cwd(),
    worker: { provider, model, concurrency: 2, unmetered: true },
    desktop: { browserProfiles: [{ id: 'cross', startUrl: origin + '/' }] },
    githubDraft: { dedicatedTestRepository: true, base: 'main', projectId: 'draft-fixture-project',
      binding: { account: { id: 17, login: 'TestOwner' }, repository: { id: 42, owner: 'TestOrg', name: 'DedicatedTest' } } },
  }, { githubDraftProvider: draftProvider })
  ctx.effect(() => () => local.dispose())
  const session = await ctx.sessionController.create({ sessionId: 'draft-fixture-session', cwd: process.cwd(), agentPreset: 'minimal' })
  assert.equal(session.sessionId, 'draft-fixture-session')
  const { ownerId, profileId } = local.owner
  local.store.insertProject({ id: 'draft-fixture-project', ownerId, profileId, kind: 'project', title: 'Draft acceptance',
    purpose: 'Verify exact test draft.', status: 'active', planRevision: 1, successCriteria: ['Read the exact receipt.'],
    milestones: [], resourceRefs: [] })
  console.log('DSHPA_WEB_FLOW_READY')
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void initialize(ctx).catch(error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
