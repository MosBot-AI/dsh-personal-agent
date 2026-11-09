import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const app = dirname(require.resolve('@mosbot-ai/dshpa'))
const { activateLocalInbox } = await import(pathToFileURL(join(app, 'inbox', 'host.js')).href)

export const inject = ['dshpa', 'appReady', 'appExit', 'sessionController', 'webServer', 'connection', 'sessions']

async function initialize(ctx) {
  let accepted
  let pushed = false
  const provider = {
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
  const local = activateLocalInbox(ctx, ctx.dshpa.host, {
    storageDirectory: join(process.env.DSH_HOME, 'github-draft-inbox'), workRoot: process.cwd(),
    githubDraft: { dedicatedTestRepository: true, base: 'main', projectId: 'draft-fixture-project',
      binding: { account: { id: 17, login: 'TestOwner' }, repository: { id: 42, owner: 'TestOrg', name: 'DedicatedTest' } } },
  }, { githubDraftProvider: provider })
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
