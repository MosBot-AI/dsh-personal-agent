import { createHash } from 'node:crypto'
import { z } from 'zod'
import { projectIdSchema, sha256DigestSchema, utcInstantSchema } from '../domain/model.js'
import { connectorBindingSchema } from './registry.js'

export const DRAFT_ACTION = 'github.draft_pull_request'
export const DRAFT_SOURCE = 'dshpa-github-draft'
export const DRAFT_EXECUTOR = 'owner-external-action'
export const DRAFT_TOKEN = 'DSHPA_GITHUB_WRITE_TOKEN'
export const gitSha = z.string().regex(/^[0-9a-f]{40}$/u)
const branch = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,100}$/u)
  .refine(value => !value.includes('//') && !value.endsWith('/'))
const operation = z.string().regex(/^github-draft-[a-f0-9]{64}$/u)
const body = z.string().min(1).max(4096).refine(value => value.trim().length > 0 && !value.includes('<!-- dshpa-draft:') && !/[\0\r]/u.test(value))
const content = z.string().min(1).max(8192).refine(value => value.trim().length > 0 && !/[\0\r]/u.test(value))
const title = z.string().min(1).max(200).refine(value => value.trim() === value && value.length > 0 && !/\p{Cc}/u.test(value))

export const githubDraftConfigSchema = z.strictObject({
  dedicatedTestRepository: z.literal(true),
  binding: connectorBindingSchema,
  projectId: projectIdSchema.max(256),
  base: branch,
})
export type GitHubDraftConfig = z.infer<typeof githubDraftConfigSchema>

export const draftInputSchema = z.strictObject({ title, body, content })
export type DraftInput = z.infer<typeof draftInputSchema>

export function contentDigest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function draftMarker(operationId: string, digest: string) {
  return `<!-- dshpa-draft:${operationId}:${digest} -->`
}

export function draftHead(operationId: string) { return `dshpa-draft/${operationId.slice(-64)}` }
export function draftPath(operationId: string) { return `dshpa-draft-${operationId.slice(-64)}.md` }

export const draftPayloadSchema = z.strictObject({
  operationId: operation,
  repository: connectorBindingSchema.shape.repository,
  base: branch,
  baseSha: gitSha,
  head: z.string(),
  headSha: gitSha,
  path: z.string(),
  title,
  body: z.string().min(1).max(4352),
  content,
  contentDigest: sha256DigestSchema,
  preparedAt: utcInstantSchema,
  draft: z.literal(true),
}).refine(payload => payload.head === draftHead(payload.operationId) && payload.path === draftPath(payload.operationId)
  && payload.contentDigest === contentDigest(payload.content)
  && payload.body.endsWith(`\n\n${draftMarker(payload.operationId, payload.contentDigest)}`))
export type DraftPayload = z.infer<typeof draftPayloadSchema>
