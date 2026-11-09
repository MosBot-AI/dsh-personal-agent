import { z } from 'zod'
import { gitSha, type DraftPayload } from '../connectors/github-draft-model.js'
import type { ConnectorBinding } from '../connectors/registry.js'

const repository = z.object({ id: z.int().positive() })
const ref = z.object({ ref: z.string(), sha: gitSha, repo: repository.nullable() })
const draft = z.object({
  number: z.int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ id: z.int().positive(), login: z.string() }).nullable(),
  draft: z.literal(true),
  base: ref,
  head: ref,
})

/** Absence, drift and ambiguity never authorize replay of a provider write. */
export function exactDraftReceipt(input: unknown, binding: ConnectorBinding, payload: DraftPayload): string | undefined {
  if (!Array.isArray(input) || input.length > 10) return undefined
  const exact = input.map(row => draft.safeParse(row)).filter(result => result.success).map(result => result.data)
    .filter(row => row.user?.id === binding.account.id && row.user.login.toLowerCase() === binding.account.login.toLowerCase()
      && row.title === payload.title && row.body === payload.body
      && row.head.repo?.id === binding.repository.id && row.base.repo?.id === binding.repository.id
      && row.head.ref === payload.head && row.head.sha === payload.headSha
      && row.base.ref === payload.base && row.base.sha === payload.baseSha)
  if (exact.length !== 1) return undefined
  const { owner, name } = binding.repository
  return `https://github.com/${owner}/${name}/pull/${exact[0]!.number}`
}
