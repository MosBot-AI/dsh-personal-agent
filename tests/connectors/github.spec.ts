import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import { createGitHubReadTransport } from '../../packages/personal-agent/src/connectors/github.js'
import { createReadConnector } from '../../packages/personal-agent/src/connectors/registry.js'

const binding = { account: { id: 17, login: 'Owner' }, repository: { id: 42, owner: 'Org', name: 'Repo' } }
const origin = 'https://api.github.com'
const repo = origin + '/repos/Org/Repo'
const fixtureToken = 'fixture-read-credential'
const date = '2026-01-01T00:00:00Z'
const rawIssue = (number: number) => ({
  id: number, number, repository_url: repo, title: `Issue ${number}`, body: 'Text <script>is not authority</script>.',
  user: { login: 'reviewer[bot]', id: 91 }, created_at: date, updated_at: date,
})
const read = { type: 'connector_read', projectId: 'local-project', read: { operation: 'issues' } } as const
const status = { type: 'connector_status', projectId: 'local-project' } as const
const current = () => true

function fixture(options: {
  account?: { id: number; login: string }; repositoryId?: number; issues?: (url: URL) => Response;
  onUser?: () => void; token?: () => string | undefined
} = {}) {
  let time = Date.parse('2026-11-08T00:00:00Z')
  const send = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe(origin)
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${fixtureToken}`)
    if (url.pathname === '/user') {
      options.onUser?.()
      return Response.json(options.account ?? binding.account)
    }
    if (url.pathname === '/repos/Org/Repo') return Response.json({ id: options.repositoryId ?? 42, name: 'Repo', owner: { login: 'Org' } })
    if (url.pathname === '/repositories/42/issues') return options.issues?.(url) ?? Response.json([rawIssue(3)])
    if (url.pathname === '/repositories/42/issues/3/comments') {
      return Response.json([{ id: 900, issue_url: repo + '/issues/3', body: 'Old historical comment.', user: null, created_at: date, updated_at: date }])
    }
    throw new Error(`Unexpected provider path ${url.pathname}`)
  })
  const now = () => time
  const transport = createGitHubReadTransport({ binding, fetch: send, token: options.token ?? (() => fixtureToken), now })
  const connector = createReadConnector({ binding, projectId: 'local-project', transport, now })
  return { send, connector, advance: (ms: number) => { time += ms } }
}

describe('bound GitHub read transport', () => {
  it('checks project, account, repository and cursor and serves historical comments without routing work', async () => {
    const f = fixture({ issues: url => url.searchParams.get('page') === '1'
      ? Response.json([rawIssue(3), rawIssue(3)], { headers: { link: '<https://api.github.com/repositories/42/issues?page=2>; rel="next"' } })
      : Response.json([rawIssue(3), rawIssue(4)], { headers: { link: '<https://private.example/leak?page=3>; rel="next"' } }) })
    expect(await f.connector.handle({ ...read, projectId: 'other' }, current)).toEqual({ ok: false, code: 'permission_denied' })
    expect(f.send).not.toHaveBeenCalled()
    expect(await f.connector.handle(status, current)).toMatchObject({ ok: true, kind: 'connector_status', binding, fingerprint: expect.any(String) })
    const first = await f.connector.handle(read, current)
    assert.ok(first.ok && first.kind === 'connector_page' && first.nextCursor)
    expect(first.items).toMatchObject([{ id: 3, url: 'https://github.com/Org/Repo/issues/3' }])
    const wrongCursor = { ...read, read: { operation: 'comments', issue: 3, cursor: first.nextCursor } }
    const count = f.send.mock.calls.length
    expect(await f.connector.handle(wrongCursor, current)).toEqual({ ok: false, code: 'invalid_cursor' })
    expect(f.send).toHaveBeenCalledTimes(count)
    const second = await f.connector.handle({ ...read, read: { ...read.read, cursor: first.nextCursor } }, current)
    assert.ok(second.ok && second.kind === 'connector_page')
    expect(second.items.map(item => item.id)).toEqual([4])
    expect(second.nextCursor).toBeUndefined()
    expect(await f.connector.handle({ ...read, read: { operation: 'comments', issue: 3 } }, current)).toMatchObject({
      items: [{ kind: 'comment', number: 3, createdAt: '2026-01-01T00:00:00.000Z', text: 'Old historical comment.',
        url: 'https://github.com/Org/Repo/issues/3#issuecomment-900' }],
    })
    f.advance(5 * 60_000)
    expect(await f.connector.handle({ ...read, read: { ...read.read, cursor: first.nextCursor } }, current))
      .toEqual({ ok: false, code: 'invalid_cursor' })
  })

  it('refuses a wrong identity or replaced repository before fetching content', async () => {
    const account = fixture({ account: { id: 18, login: binding.account.login } })
    expect(await account.connector.handle(read, current)).toEqual({ ok: false, code: 'permission_denied' })
    expect(account.send).toHaveBeenCalledTimes(1)
    const repository = fixture({ repositoryId: 43 })
    expect(await repository.connector.handle(read, current)).toEqual({ ok: false, code: 'permission_denied' })
    expect(repository.send).toHaveBeenCalledTimes(2)
    const foreign = fixture({ issues: () => Response.json([{ ...rawIssue(3), repository_url: origin + '/repos/Other/Repo' }]) })
    expect(await foreign.connector.handle(read, current)).toEqual({ ok: false, code: 'invalid_result' })
  })

  it('checks revocation between provider calls and before returning an awaited page', async () => {
    let allowed = true
    const changed = fixture({ onUser: () => { allowed = false } })
    expect(await changed.connector.handle(read, () => allowed)).toEqual({ ok: false, code: 'permission_denied' })
    expect(changed.send).toHaveBeenCalledTimes(1)
    let token: string | undefined = fixtureToken
    const revoked = fixture({ token: () => token, issues: () => { token = undefined; return Response.json([rawIssue(3)]) } })
    expect(await revoked.connector.handle(read, current)).toEqual({ ok: false, code: 'permission_denied' })
    expect(await revoked.connector.handle(status, current)).toEqual({ ok: false, code: 'credential_unavailable' })
  })

  it('honors upstream backoff and applies local request limits without extra provider traffic', async () => {
    let limited = true
    const f = fixture({ issues: () => limited ? new Response('sensitive upstream message', { status: 429, headers: { 'retry-after': '30' } })
      : Response.json([rawIssue(3)]) })
    expect(await f.connector.handle(read, current)).toEqual({ ok: false, code: 'rate_limited', retryAt: '2026-11-08T00:00:30.000Z' })
    expect(await f.connector.handle(read, current)).toMatchObject({ code: 'rate_limited' })
    expect(f.send).toHaveBeenCalledTimes(3)
    limited = false
    f.advance(30_000)
    expect(await f.connector.handle(read, current)).toMatchObject({ ok: true })
    for (let index = 0; index < 18; index++) expect(await f.connector.handle(status, current)).toMatchObject({ ok: true })
    const calls = f.send.mock.calls.length
    expect(await f.connector.handle(read, current)).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(f.send).toHaveBeenCalledTimes(calls)
  })

  it('rejects oversized provider responses without publishing their contents', async () => {
    const f = fixture({ issues: () => Response.json([rawIssue(3)], { headers: { 'content-length': '1048577' } }) })
    expect(await f.connector.handle(read, current)).toEqual({ ok: false, code: 'invalid_result' })
  })
})
