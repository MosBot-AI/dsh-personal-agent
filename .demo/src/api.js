import { z } from 'zod'
import contract from '../../contracts/personal-api/schema.json'
import manifest from '../../contracts/personal-api/manifest.json'

const wireVersion = contract.$defs.Capabilities.properties.schema_version.const
const capabilityIds = contract.$defs.Capability.properties.id.enum
const errorCodes = contract.$defs.Error.properties.error.properties.code.enum
const cursor = z.string().min(1).nullable()
const ok = z.object({ ok: z.literal(true) })
const revision = z.int().positive()
const capability = z.object({
  id: z.enum(capabilityIds),
  supported: z.boolean(),
  enabled: z.boolean(),
  available: z.boolean(),
  reason: z.enum(contract.$defs.Capability.properties.reason.enum.filter(Boolean)).nullable(),
  remediation: z.object({
    kind: z.enum(['operator_action', 'reauthenticate']), message: z.string(),
  }).nullable(),
}).refine(entry =>
  (!entry.enabled || entry.supported) &&
  (entry.available ? entry.enabled && entry.reason === null && entry.remediation === null : entry.reason !== null)
)
const discovery = z.object({
  schema_version: z.literal(wireVersion),
  data: z.object({
    contract_version: z.literal(manifest.contract_version),
    backend: z.object({ id: z.enum(['dsh', 'hermes']) }),
    capabilities: z.array(capability).length(capabilityIds.length)
      .refine(entries => new Set(entries.map(entry => entry.id)).size === capabilityIds.length),
    transport: z.object({ polling: z.boolean(), sse: z.boolean() }),
    limits: z.object({ max_page_size: z.literal(64) }),
  }),
})
const taskPage = z.object({
  schema_version: z.literal(wireVersion),
  data: z.object({
    items: z.array(z.object({
      id: z.string().min(1), title: z.string(),
      revision: z.string().regex(/^[1-9][0-9]{0,19}$/),
      state: z.enum(contract.$defs.Task.properties.state.enum),
      wait_reason: z.string().nullable(),
    })).max(64),
    next_cursor: cursor,
    consistency: z.literal('live'),
  }),
})
const sharedError = z.object({
  schema_version: z.literal(wireVersion),
  error: z.object({ code: z.enum(errorCodes), message: z.string(), retryable: z.boolean() }),
})
const snapshot = ok.extend({
  cursor,
  tasks: z.array(z.object({
    id: z.string(), projectId: z.string(), outcome: z.string(), status: z.string(), version: revision,
  })).max(64),
})
const approvals = ok.extend({
  approvals: z.array(z.object({
    id: z.string().min(1), taskId: z.string(), version: revision,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime(), kind: z.string(), accountId: z.string(),
    resourceRef: z.string(), recipient: z.string().optional(), dataScope: z.array(z.string()), preview: z.string(),
  })),
})

export class ApiError extends Error {
  constructor(code, message, status, retryable = false) {
    super(message)
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

async function request(path, schema, session, body) {
  const options = {
    signal: AbortSignal.any([session, AbortSignal.timeout(10_000)]),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { Accept: 'application/json' },
  }
  if (body !== undefined) {
    options.method = 'POST'
    options.headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(path, options)
  const json = response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : undefined
  if (!response.ok) {
    const failure = sharedError.safeParse(json)
    if (failure.success) {
      const { code, message, retryable } = failure.data.error
      throw new ApiError(code, message, response.status, retryable)
    }
    const code = typeof json?.code === 'string' ? json.code : 'http_error'
    throw new ApiError(code, '请求失败', response.status)
  }
  const result = schema.safeParse(json)
  if (!result.success) throw new ApiError('invalid_response', '响应与客户端使用的 API 契约不符。', response.status)
  return result.data
}

export const sharedApi = {
  async discover(signal) {
    return (await request('/v1/capabilities', discovery, signal)).data
  },
  async tasks(limit, next, signal) {
    const params = new URLSearchParams({ limit: String(limit) })
    if (next !== null) params.set('cursor', next)
    return (await request('/v1/tasks?' + params, taskPage, signal)).data
  },
}

export const mobileApi = {
  pair: (code, signal) => request('/v1/pair', ok, signal, { code }),
  snapshot: signal => request('/v1/snapshot', snapshot, signal),
  approvals: signal => request('/v1/approvals', approvals, signal),
  respond(approval, decision, signal) {
    return request('/v1/approvals/' + encodeURIComponent(approval.id) + '/responses',
      ok.extend({ status: z.enum(['approved', 'denied']) }), signal,
      { expectedVersion: approval.version, digest: approval.digest, decision })
  },
  follow(next) {
    return new EventSource(next === null ? '/v1/events' : '/v1/events?cursor=' + encodeURIComponent(next))
  },
}
