import { z } from 'zod'
import { boundedConnectorJson } from './connector-http.js'
import { prepareIsolatedBranch, type DraftBranchInput, type PreparedBranch } from './github-branch.js'
import { DRAFT_TOKEN, draftPayloadSchema, gitSha, type DraftPayload, type GitHubDraftConfig } from './github-draft-model.js'
import { ConnectorError, sameConnectorBinding, type ConnectorBinding } from './registry.js'
import { exactDraftReceipt } from '../policy/reconcile.js'

const origin = 'https://api.github.com'
const version = '2022-11-28'
const user = z.object({ id: z.int().positive(), login: z.string() })
const repo = z.object({ id: z.int().positive(), owner: z.object({ login: z.string() }), name: z.string() })
const base = z.object({ object: z.object({ type: z.literal('commit'), sha: gitSha }) })

export interface DraftProviderSession {
  baseHead(signal: AbortSignal): Promise<string>
  prepare(input: DraftBranchInput, signal: AbortSignal): Promise<PreparedBranch>
  createPull(payload: DraftPayload, signal: AbortSignal): Promise<void>
  lookup(payload: DraftPayload, signal: AbortSignal): Promise<string | undefined>
  current(): boolean
}
export interface DraftProvider {
  open(signal: AbortSignal, current: () => boolean): Promise<DraftProviderSession>
}

export function createGitHubDraftProvider(config: GitHubDraftConfig, options: {
  token?: () => string | undefined; fetch?: typeof fetch
} = {}): DraftProvider {
  const binding: ConnectorBinding = structuredClone(config.binding)
  const tokenSource = options.token ?? (() => process.env[DRAFT_TOKEN])
  const send = options.fetch ?? fetch
  const repoPath = `/repos/${binding.repository.owner}/${binding.repository.name}`
  const basePath = config.base.split('/').map(encodeURIComponent).join('/')

  function exactPayload(input: DraftPayload): DraftPayload {
    const decoded = draftPayloadSchema.safeParse(input)
    if (!decoded.success || decoded.data.base !== config.base || decoded.data.repository.id !== binding.repository.id
      || decoded.data.repository.owner !== binding.repository.owner || decoded.data.repository.name !== binding.repository.name) {
      throw new ConnectorError('permission_denied')
    }
    return decoded.data
  }

  return {
    async open(signal, permitted) {
      const token = tokenSource()
      if (!token || !/^[a-zA-Z0-9_.-]{12,4096}$/u.test(token)) throw new ConnectorError('credential_unavailable')
      const current = () => permitted() && tokenSource() === token

      async function request(method: 'GET' | 'POST', path: string, requestSignal: AbortSignal, body?: object) {
        if (!current() || requestSignal.aborted) throw new ConnectorError('permission_denied')
        const response = await send(origin + path, {
          method, redirect: 'error', signal: requestSignal, headers: {
            accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
            'x-github-api-version': version, 'user-agent': 'dshpa-test-draft',
            ...(body ? { 'content-type': 'application/json' } : {}),
          }, ...(body ? { body: JSON.stringify(body) } : {}),
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw new ConnectorError('provider_unavailable')
        }
        return { body: await boundedConnectorJson(response), headers: response.headers }
      }

      const account = user.safeParse((await request('GET', '/user', signal)).body)
      if (!account.success || account.data.id !== binding.account.id
        || account.data.login.toLowerCase() !== binding.account.login.toLowerCase()) throw new ConnectorError('permission_denied')
      const repository = repo.safeParse((await request('GET', repoPath, signal)).body)
      if (!repository.success || !sameConnectorBinding(binding, { account: account.data,
        repository: { id: repository.data.id, owner: repository.data.owner.login, name: repository.data.name } })) {
        throw new ConnectorError('permission_denied')
      }

      return {
        current,
        async baseHead(readSignal) {
          const result = base.safeParse((await request('GET', `${repoPath}/git/ref/heads/${basePath}`, readSignal)).body)
          if (!result.success) throw new ConnectorError('invalid_result')
          return result.data.object.sha
        },
        async prepare(input, prepareSignal) {
          const suffix = /^dshpa-draft\/([a-f0-9]{64})$/u.exec(input.head)?.[1]
          if (!current() || input.base !== config.base || !gitSha.safeParse(input.baseSha).success
            || !suffix || input.path !== `dshpa-draft-${suffix}.md`) throw new ConnectorError('permission_denied')
          return prepareIsolatedBranch(input, { kind: 'github', binding, token }, prepareSignal)
        },
        async createPull(input, writeSignal) {
          const payload = exactPayload(input)
          const head = payload.head.split('/').map(encodeURIComponent).join('/')
          const actualHead = base.safeParse((await request('GET', `${repoPath}/git/ref/heads/${head}`, writeSignal)).body)
          const actualBase = base.safeParse((await request('GET', `${repoPath}/git/ref/heads/${basePath}`, writeSignal)).body)
          if (!actualHead.success || !actualBase.success || actualHead.data.object.sha !== payload.headSha
            || actualBase.data.object.sha !== payload.baseSha) throw new ConnectorError('permission_denied')
          await request('POST', `${repoPath}/pulls`, writeSignal, {
            base: payload.base, head: payload.head, title: payload.title, body: payload.body, draft: true, maintainer_can_modify: false,
          })
        },
        async lookup(input, lookupSignal) {
          const payload = exactPayload(input)
          const query = new URLSearchParams({ state: 'all', head: `${binding.repository.owner}:${payload.head}`, base: payload.base, per_page: '10' })
          const result = await request('GET', `${repoPath}/pulls?${query}`, lookupSignal)
          if (!current() || result.headers.get('link')?.includes('rel="next"')) return undefined
          return exactDraftReceipt(result.body, binding, payload)
        },
      }
    },
  }
}
