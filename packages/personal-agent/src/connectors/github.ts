import { z } from 'zod'
import { boundedConnectorJson } from './connector-http.js'
import {
  ConnectorError, connectorDigest, PAGE_SIZE, type ConnectorBinding, type ConnectorPageRequest, type ReadConnectorTransport,
} from './registry.js'

const origin = 'https://api.github.com'
const version = '2022-11-28'
const capabilities = ['issues', 'comments']
const fingerprint = connectorDigest(['github-rest', version, capabilities, 1])
export const GITHUB_READ_TOKEN = 'DSHPA_GITHUB_READ_TOKEN'

const id = z.int().positive()
const actorSchema = z.object({ id, login: z.string().max(48) })
const repoSchema = z.object({ id, name: z.string().max(100), owner: z.object({ login: z.string().max(39) }) })
const baseRow = {
  id, user: actorSchema.nullable(), body: z.string().nullable(),
  created_at: z.iso.datetime(), updated_at: z.iso.datetime(),
}
const issues = z.array(z.object({
  ...baseRow, number: id, title: z.string().max(512), repository_url: z.string().max(512), pull_request: z.object({}).optional(),
})).max(PAGE_SIZE)
const comments = z.array(z.object({ ...baseRow, issue_url: z.string().max(512) })).max(PAGE_SIZE)

function itemFields(row: { id: number; user: z.infer<typeof actorSchema> | null; body: string | null;
  created_at: string; updated_at: string }) {
  return {
    id: row.id, author: row.user?.login ?? 'deleted-account',
    ...(row.user ? { authorId: row.user.id } : {}),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    text: (row.body ?? '').slice(0, 4096).replace(/[\ud800-\udbff]$/u, ''),
  }
}

function hasNext(headers: Headers, allowedPaths: string[], page: number): boolean {
  const link = headers.get('link')
  const match = link?.match(/<([^<>]+)>\s*;\s*rel="next"/u)
  if (!match) return false
  try {
    const url = new URL(match[1]!)
    return url.origin === origin && !url.username && !url.password && !url.hash
      && allowedPaths.some(path => path.toLowerCase() === url.pathname.toLowerCase())
      && url.searchParams.getAll('page').length === 1 && url.searchParams.get('page') === String(page + 1)
  } catch { return false }
}

function retryDeadline(headers: Headers, time: number): number | undefined {
  const retry = headers.get('retry-after')
  const reset = headers.get('x-ratelimit-remaining') === '0' ? headers.get('x-ratelimit-reset') : null
  const deadlines = [
    retry === null ? 0 : /^\d+$/u.test(retry) ? time + Number(retry) * 1000 : Date.parse(retry),
    reset && /^\d+$/u.test(reset) ? Number(reset) * 1000 : 0,
  ].filter(value => Number.isFinite(value) && value > time)
  return deadlines.length ? Math.min(Math.max(...deadlines), time + 7 * 86_400_000) : undefined
}

/** A trusted REST transport with no caller-controlled URLs, credentials or HTTP methods. */
export function createGitHubReadTransport(options: {
  binding: ConnectorBinding
  token?: () => string | undefined
  fetch?: typeof fetch
  now?: () => number
}): ReadConnectorTransport {
  const binding = structuredClone(options.binding)
  const tokenSource = options.token ?? (() => process.env[GITHUB_READ_TOKEN])
  const send = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const repoPath = `/repos/${binding.repository.owner}/${binding.repository.name}`
  const numericPath = `/repositories/${binding.repository.id}`
  let cooldown = 0

  return {
    expectedFingerprint: fingerprint,
    async open(_signal, authorize) {
      if (!authorize()) throw new ConnectorError('permission_denied')
      const token = tokenSource()
      if (!token || !/^[a-zA-Z0-9_.-]{12,4096}$/u.test(token)) throw new ConnectorError('credential_unavailable')
      let verified: ConnectorBinding | undefined

      async function get(path: string, signal: AbortSignal) {
        if (signal.aborted || !authorize() || tokenSource() !== token) throw new ConnectorError('permission_denied')
        const time = now()
        if (cooldown > time) throw new ConnectorError('rate_limited', new Date(cooldown).toISOString())
        const response = await send(origin + path, {
          method: 'GET', redirect: 'error', signal, headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': version,
            'user-agent': 'dshpa-read-connector',
          },
        })
        const until = retryDeadline(response.headers, now())
        if (until !== undefined) cooldown = until
        if (!response.ok) {
          await response.body?.cancel()
          if (response.status === 429 || (response.status === 403 && (until !== undefined
            || response.headers.get('x-ratelimit-remaining') === '0'))) {
            cooldown = until ?? now() + 60_000
            throw new ConnectorError('rate_limited', new Date(cooldown).toISOString())
          }
          if (response.status === 403) cooldown = now() + 60_000
          if ([401, 403, 404].includes(response.status)) throw new ConnectorError('permission_denied')
          throw new ConnectorError('provider_unavailable')
        }
        if (response.headers.get('x-ratelimit-remaining') === '0' && until === undefined) cooldown = now() + 60_000
        return { body: await boundedConnectorJson(response), headers: response.headers }
      }

      return {
        current: () => tokenSource() === token,
        async inspect(signal) {
          const account = actorSchema.safeParse((await get('/user', signal)).body)
          if (!account.success) throw new ConnectorError('invalid_result')
          if (account.data.id !== binding.account.id || account.data.login.toLowerCase() !== binding.account.login.toLowerCase()) {
            throw new ConnectorError('permission_denied')
          }
          const repository = repoSchema.safeParse((await get(repoPath, signal)).body)
          if (!repository.success) throw new ConnectorError('invalid_result')
          verified = { account: account.data, repository: {
            id: repository.data.id, owner: repository.data.owner.login, name: repository.data.name,
          } }
          return { binding: verified, capabilities, fingerprint }
        },
        async read(request: ConnectorPageRequest, signal) {
          if (!verified) throw new ConnectorError('permission_denied')
          const issue = request.operation === 'comments' ? request.issue : undefined
          const suffix = issue === undefined ? '/issues' : `/issues/${issue}/comments`
          const query = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(request.page) })
          if (issue === undefined) {
            query.set('state', 'all')
            query.set('sort', 'created')
            query.set('direction', 'desc')
          }
          const path = numericPath + suffix
          const { body, headers } = await get(`${path}?${query}`, signal)
          const allowedRepoUrls = [origin + repoPath, origin + numericPath].map(value => value.toLowerCase())
          const result = { binding: verified, fingerprint, operation: request.operation, page: request.page,
            hasNext: hasNext(headers, [path, repoPath + suffix], request.page) }
          if (issue === undefined) {
            const parsed = issues.safeParse(body)
            if (!parsed.success || parsed.data.some(row => !allowedRepoUrls.includes(row.repository_url.toLowerCase()))) {
              throw new ConnectorError('invalid_result')
            }
            return { ...result, items: parsed.data.map(row => ({ ...itemFields(row), title: row.title, number: row.number,
              kind: row.pull_request ? 'pull' : 'issue' })) }
          }
          const parsed = comments.safeParse(body)
          if (!parsed.success || parsed.data.some(row => !allowedRepoUrls.some(url => row.issue_url.toLowerCase() === `${url}/issues/${issue}`))) {
            throw new ConnectorError('invalid_result')
          }
          return { ...result, issue, items: parsed.data.map(row => ({ ...itemFields(row), number: issue, kind: 'comment' })) }
        },
      }
    },
  }
}
