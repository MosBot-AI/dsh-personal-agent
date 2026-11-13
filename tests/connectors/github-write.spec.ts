import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { prepareIsolatedBranch } from '../../packages/personal-agent/src/connectors/github-branch.js'
import { contentDigest, DRAFT_ACTION, draftHead, draftMarker, draftPath, draftPayloadSchema, githubDraftConfigSchema,
  type DraftPayload } from '../../packages/personal-agent/src/connectors/github-draft-model.js'
import { createGitHubDraftProvider, type DraftProvider } from '../../packages/personal-agent/src/connectors/github-write.js'
import { operationIdSchema } from '../../packages/personal-agent/src/domain/model.js'
import { exactDraftReceipt } from '../../packages/personal-agent/src/policy/reconcile.js'
import { draftView, makeDraftHarness, type View } from './github-draft-harness.js'

const config = githubDraftConfigSchema.parse({ dedicatedTestRepository: true, projectId: 'draft-test-project', base: 'main',
  binding: { account: { id: 17, login: 'TestOwner' }, repository: { id: 42, owner: 'TestOrg', name: 'DedicatedTest' } } })
const baseSha = 'a'.repeat(40)
const headSha = 'b'.repeat(40)
const receipt = 'https://github.com/TestOrg/DedicatedTest/pull/3'
const input = { title: 'Test draft', body: 'Read back exact evidence.', content: '# Test draft\nScoped content.\n' }

function providerFixture() {
  const state = { push: 0, posts: 0, lookup: true, accepted: undefined as DraftPayload | undefined,
    pushWait: undefined as Promise<void> | undefined, postWait: undefined as Promise<void> | undefined, timeout: false }
  const provider: DraftProvider = {
    async open(_signal, current) {
      assert.ok(current())
      return {
        current,
        async baseHead() { return baseSha },
        async prepare() { return { sha: headSha, close() {}, async publish() { state.push++; await state.pushWait } } },
        async createPull(payload) {
          assert.ok(current())
          state.posts++
          state.accepted = payload
          await state.postWait
          if (state.timeout) throw new Error('Interrupted test connection')
        },
        async lookup(payload) { return state.lookup && state.accepted?.body === payload.body ? receipt : undefined },
      }
    },
  }
  return { provider, state }
}

async function setup() {
  const f = providerFixture()
  const h = await makeDraftHarness(config, f.provider)
  onTestFinished(() => h.close())
  const request = { type: 'github_draft_prepare', taskId: h.taskId, expectedVersion: h.version(), commandId: 'prepare-draft', draft: input }
  const view = draftView(await h.request(request))
  const operationId = operationIdSchema.parse(view.payload.operationId)
  const dispatch = () => h.request({ type: 'github_draft_dispatch', taskId: h.taskId, operationId, expectedVersion: h.version() })
  const lookup = () => h.request({ type: 'github_draft_reconcile', taskId: h.taskId, operationId })
  return { ...f, h, view, operationId, request, dispatch, lookup }
}

describe('reviewed GitHub draft action', () => {
  it('prepares exact content, consumes one grant, and stores verified readback and an artifact', async () => {
    const f = await setup()
    expect(f.view).toMatchObject({ approval: 'pending', effect: 'prepared', payload: { draft: true, title: input.title,
      repository: config.binding.repository, base: config.base, baseSha, headSha, content: input.content,
      contentDigest: contentDigest(input.content), body: expect.stringContaining(draftMarker(f.operationId, contentDigest(input.content))) } })
    expect(f.state.push).toBe(0)
    expect(f.state.posts).toBe(0)
    expect(await f.dispatch()).toEqual({ ok: false, code: 'permission_denied' })
    expect(draftView(await f.h.request(f.request))).toEqual(f.view)
    expect(await f.h.request({ ...f.request, draft: { ...input, content: 'Altered' } })).toEqual({ ok: false, code: 'action_changed' })
    expect(await f.h.approve(f.view)).toMatchObject({ ok: true })
    const saved = f.h.gate.inspect(f.h.token, f.h.taskId, DRAFT_ACTION)!
    expect(f.h.gate.dispatch({ ...saved.action, payload: { ...f.view.payload, title: 'Altered' } }, saved.grant!.id, f.h.version()))
      .toEqual({ ok: false, code: 'action_changed' })
    const [first, second] = await Promise.all([f.dispatch(), f.dispatch()])
    expect(first).toMatchObject({ ok: true, draft: { effect: 'dispatching' } })
    expect(second).toMatchObject({ ok: false })
    await vi.waitFor(() => expect(f.h.store.getEffect(f.h.ref, f.operationId)?.status).toBe('confirmed'))
    expect(f.state.push).toBe(1)
    expect(f.state.posts).toBe(1)
    expect(draftView(await f.lookup())).toMatchObject({ receipt, effect: 'confirmed' })
    expect(f.h.store.getWork(f.h.ref)?.task.status).toBe('verifying')
    const accepted = await f.h.request({ type: 'accept_result', taskId: f.h.taskId, expectedVersion: f.h.version() })
    expect(accepted).toMatchObject({ ok: true })
    expect(f.h.store.getVerification(f.h.ref, f.h.version())?.effectReceipt?.providerReceiptId).toBe(receipt)
  })

  it.each(['revocation', 'cancellation'] as const)('fences the PR call after %s during the branch handoff', async kind => {
    const f = await setup()
    const gate = Promise.withResolvers<void>()
    f.state.pushWait = gate.promise
    try {
      expect(await f.h.approve(f.view)).toMatchObject({ ok: true })
      expect(await f.dispatch()).toMatchObject({ ok: true })
      if (kind === 'revocation') expect(await f.h.request({
        type: 'github_draft_revoke', taskId: f.h.taskId, operationId: f.operationId,
      })).toMatchObject({ ok: true, draft: { revoked: true } })
      else expect(await f.h.request({ type: 'cancel', taskId: f.h.taskId, commandId: 'cancel-draft',
        expectedVersion: f.h.version() })).toMatchObject({ ok: true })
    } finally { gate.resolve() }
    await vi.waitFor(() => expect(f.h.store.getEffect(f.h.ref, f.operationId)?.status).toBe('uncertain'))
    expect(f.state.push).toBe(1)
    expect(f.state.posts).toBe(0)
    expect(await f.dispatch()).toMatchObject({ ok: false })
  })

  it.each([false, true])('rechecks the actual mobile approver during publish (revoke=%s)', async revoke => {
    const f = await setup()
    const reviewer = f.h.enrollReviewer()
    const pending = f.h.gate.inspect(f.h.token, f.h.taskId, DRAFT_ACTION)!
    expect(f.h.gate.assignMobileReview({ requestId: pending.approval.id, expectedVersion: pending.version,
      digest: pending.digest }, f.h.token, reviewer.token)).toEqual({ ok: true })
    const assigned = f.h.gate.inspect(f.h.token, f.h.taskId, DRAFT_ACTION)!
    expect(f.h.gate.respond({ requestId: assigned.approval.id, expectedVersion: assigned.version,
      digest: assigned.digest, decision: 'approve' }, reviewer.token)).toMatchObject({ ok: true })
    const release = Promise.withResolvers<void>()
    f.state.pushWait = release.promise
    try {
      expect(await f.dispatch()).toMatchObject({ ok: true })
      expect(f.state.push).toBe(1)
      if (revoke) reviewer.revoke()
    } finally { release.resolve() }
    await vi.waitFor(() => expect(f.h.store.getEffect(f.h.ref, f.operationId)?.status)
      .toBe(revoke ? 'uncertain' : 'confirmed'))
    expect(f.state.posts).toBe(revoke ? 0 : 1)
    expect(await f.dispatch()).toMatchObject({ ok: false })
  })

  it('classifies an interrupted dispatch on cold reopen and reconciles the exact remote receipt without replay', async () => {
    const f = await setup()
    const afterAcceptance = Promise.withResolvers<void>()
    f.state.postWait = afterAcceptance.promise
    f.state.timeout = true
    expect(await f.h.approve(f.view)).toMatchObject({ ok: true })
    expect(await f.dispatch()).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(f.state.posts).toBe(1))
    const cold = f.h.reopen()
    afterAcceptance.resolve()
    await cold
    expect(f.h.store.getEffect(f.h.ref, f.operationId)?.status).toBe('uncertain')
    expect(await f.dispatch()).toMatchObject({ ok: false })
    expect(draftView(await f.lookup())).toMatchObject({ effect: 'confirmed', receipt })
    expect(f.state.push).toBe(1)
    expect(f.state.posts).toBe(1)
  })
})

describe('isolated Git and exact provider readback', () => {
  function localOrigin() {
    const directory = mkdtempSync(join(tmpdir(), 'dshpa-draft-origin-'))
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim()
    git('init', '--initial-branch=main')
    writeFileSync(join(directory, 'README.md'), 'Base file\n')
    git('add', 'README.md')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Base')
    return { git, base: git('rev-parse', 'HEAD'), source: { kind: 'local' as const, directory, binding: config.binding } }
  }

  it('prepares a deterministic private branch and publishes only that new ref', async () => {
    const { git, base, source } = localOrigin()
    const operation = `github-draft-${'c'.repeat(64)}`
    const inputBranch = { base: 'main', baseSha: base, head: draftHead(operation), path: draftPath(operation),
      content: input.content, preparedAt: '2026-11-08T01:00:00.000Z' }
    const signal = AbortSignal.timeout(15_000)
    const one = await prepareIsolatedBranch(inputBranch, source, signal)
    try {
      expect(() => git('rev-parse', '--verify', `refs/heads/${inputBranch.head}`)).toThrow()
      const two = await prepareIsolatedBranch(inputBranch, source, signal)
      try {
        expect(two.sha).toBe(one.sha)
        await one.publish(signal)
        await expect(two.publish(signal)).rejects.toThrow('Isolated Git did not create the approved draft branch')
      } finally { two.close() }
      expect(git('rev-parse', `refs/heads/${inputBranch.head}`)).toBe(one.sha)
      expect(git('show', `${one.sha}:${inputBranch.path}`)).toBe(input.content.trim())
      expect(git('rev-parse', 'refs/heads/main')).toBe(base)
      git('update-ref', `refs/heads/${inputBranch.head}`, base)
      await expect(one.publish(signal)).rejects.toThrow('Isolated Git operation failed')
      expect(git('rev-parse', `refs/heads/${inputBranch.head}`)).toBe(base)
    } finally { one.close() }
  })

  it('does not create a draft when the exact approved head appears before handoff', async () => {
    const { git, base, source } = localOrigin()
    const createPull = vi.fn(async () => {})
    const lookup = vi.fn(async () => undefined)
    const h = await makeDraftHarness(config, {
      async open(_signal, current) {
        return { current, async baseHead() { return base },
          prepare: (input, signal) => prepareIsolatedBranch(input, source, signal), createPull, lookup }
      },
    })
    onTestFinished(() => h.close())
    const { payload, ...review } = draftView(await h.request({ type: 'github_draft_prepare', taskId: h.taskId,
      expectedVersion: h.version(), commandId: 'prepare-draft', draft: input }))
    const signal = AbortSignal.timeout(15_000)
    const existing = await prepareIsolatedBranch(payload, source, signal)
    try {
      expect(existing.sha).toBe(payload.headSha)
      await existing.publish(signal)
    } finally { existing.close() }

    expect(await h.approve({ payload, ...review })).toMatchObject({ ok: true })
    const dispatch = () => h.request({ type: 'github_draft_dispatch', taskId: h.taskId,
      operationId: payload.operationId, expectedVersion: h.version() })
    expect(await dispatch()).toMatchObject({ ok: true })
    const operationId = operationIdSchema.parse(payload.operationId)
    await vi.waitFor(() => expect(h.store.getEffect(h.ref, operationId)?.status).toBe('uncertain'))
    expect(createPull).not.toHaveBeenCalled()
    expect(lookup).toHaveBeenCalledWith(payload, expect.any(AbortSignal))
    expect(await dispatch()).toMatchObject({ ok: false })
    expect(git('rev-parse', `refs/heads/${payload.head}`)).toBe(payload.headSha)
    expect(git('rev-parse', 'refs/heads/main')).toBe(base)
  })

  it('calls only the fixed draft endpoint after head/base readback and rejects mismatched or ambiguous receipts', async () => {
    const operationId = `github-draft-${'c'.repeat(64)}`
    const digest = contentDigest(input.content)
    const payload = draftPayloadSchema.parse({ ...input, body: `${input.body}\n\n${draftMarker(operationId, digest)}`, operationId,
      repository: config.binding.repository, base: config.base, baseSha, head: draftHead(operationId), headSha,
      path: draftPath(operationId), contentDigest: digest, preparedAt: '2026-11-08T01:00:00.000Z', draft: true })
    const row = { number: 3, title: payload.title, body: payload.body, draft: true, user: config.binding.account,
      head: { ref: payload.head, sha: payload.headSha, repo: config.binding.repository },
      base: { ref: payload.base, sha: payload.baseSha, repo: config.binding.repository } }
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://api.github.com')
      expect(init?.redirect).toBe('error')
      if (url.pathname === '/user') return Response.json(config.binding.account)
      if (url.pathname === '/repos/TestOrg/DedicatedTest') return Response.json({ ...config.binding.repository, owner: { login: 'TestOrg' } })
      if (url.pathname.endsWith(`/git/ref/heads/${payload.head}`)) return Response.json({ object: { type: 'commit', sha: headSha } })
      if (url.pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { type: 'commit', sha: baseSha } })
      expect(url.pathname).toBe('/repos/TestOrg/DedicatedTest/pulls')
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ base: 'main', head: payload.head, title: payload.title,
          body: payload.body, draft: true, maintainer_can_modify: false })
        return Response.json(row, { status: 201 })
      }
      expect(url.searchParams.get('head')).toBe(`TestOrg:${payload.head}`)
      return Response.json([row])
    })
    const provider = createGitHubDraftProvider(config, { token: () => 'fixture-write-credential', fetch: send })
    const signal = AbortSignal.timeout(2000)
    const session = await provider.open(signal, () => true)
    await session.createPull(payload, signal)
    expect(await session.lookup(payload, signal)).toBe(receipt)
    expect(exactDraftReceipt([{ ...row, body: 'Different text' }], config.binding, payload)).toBeUndefined()
    expect(exactDraftReceipt([{ ...row, head: { ...row.head, repo: { id: 99 } } }], config.binding, payload)).toBeUndefined()
    expect(exactDraftReceipt([row, row], config.binding, payload)).toBeUndefined()
  })
})
