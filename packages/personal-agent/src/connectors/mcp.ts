import { z } from 'zod'
import { boundedConnectorJson, MAX_RESPONSE_BYTES } from './connector-http.js'
import {
  ConnectorError, connectorDigest, PAGE_SIZE, type ConnectorBinding, type ConnectorPageRequest, type ReadConnectorTransport,
} from './registry.js'

const protocol = '2025-06-18'
const capabilities = ['issues', 'comments']
const tools = { inspect: 'dshpa_github_inspect', issues: 'dshpa_github_issues', comments: 'dshpa_github_comments' } as const
const serverSchema = z.object({
  protocolVersion: z.literal(protocol),
  serverInfo: z.object({ name: z.string().min(1).max(128), version: z.string().min(1).max(128) }),
  capabilities: z.object({ tools: z.record(z.string(), z.unknown()) }),
})
type Server = z.infer<typeof serverSchema>
const descriptor = z.looseObject({ name: z.string().min(1).max(128), inputSchema: z.record(z.string(), z.unknown()) })
const toolList = z.object({ tools: z.array(descriptor).max(32), nextCursor: z.string().optional() })
const toolResult = z.object({ structuredContent: z.record(z.string(), z.unknown()), isError: z.boolean().optional() })
const rpcObject = z.object({ jsonrpc: z.literal('2.0'), id: z.int().optional(), method: z.string().optional(),
  result: z.unknown().optional(), error: z.unknown().optional() })

export const mcpLoopbackUrlSchema = z.string().max(512).refine(value => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && !url.username
      && !url.password && !url.search && !url.hash
  } catch { return false }
})

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new ConnectorError('invalid_result')
  if (Array.isArray(value)) return value.map(child => canonical(child, depth + 1))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map(key =>
      [key, canonical((value as Record<string, unknown>)[key], depth + 1)]))
  }
  return value
}

function fingerprint(server: Server, descriptors: z.infer<typeof descriptor>[]): string {
  return connectorDigest(canonical([server, [...descriptors].sort((a, b) => a.name.localeCompare(b.name)), tools]))
}

async function rpcResponse(response: Response, id: number): Promise<unknown> {
  const parse = (raw: unknown) => {
    const envelope = rpcObject.safeParse(raw)
    if (!envelope.success) throw new ConnectorError('invalid_result')
    const message = envelope.data
    if (message.id === undefined && message.method !== undefined) {
      if (message.method === 'notifications/tools/list_changed') throw new ConnectorError('capability_changed')
      return undefined
    }
    if (message.id !== id || message.method !== undefined || message.error !== undefined || message.result === undefined) {
      throw new ConnectorError('invalid_result')
    }
    return { value: message.result }
  }
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
  if (type !== 'text/event-stream') {
    const result = parse(await boundedConnectorJson(response))
    if (!result) throw new ConnectorError('invalid_result')
    return result.value
  }
  const reader = response.body?.getReader()
  if (!reader) throw new ConnectorError('invalid_result')
  let bytes = 0
  let buffer = ''
  let data: string[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) throw new ConnectorError('invalid_result')
      bytes += result.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new ConnectorError('invalid_result')
      buffer += decoder.decode(result.value, { stream: true })
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).replace(/\r$/u, '')
        buffer = buffer.slice(end + 1)
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
        if (line === '' && data.length > 0) {
          const parsed = parse(JSON.parse(data.join('\n')) as unknown)
          if (parsed) return parsed.value
          data = []
        }
      }
    }
  } catch (error) {
    if (error instanceof ConnectorError) throw error
    throw new ConnectorError('invalid_result')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function connect(rawUrl: string, send: typeof fetch, signal: AbortSignal, authorize = () => true) {
  const url = new URL(mcpLoopbackUrlSchema.parse(rawUrl))
  let nextId = 1

  async function post(message: object) {
    if (signal.aborted || !authorize()) throw new ConnectorError('permission_denied')
    const response = await send(url, { method: 'POST', redirect: 'error', signal, headers: {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': protocol,
    }, body: JSON.stringify({ jsonrpc: '2.0', ...message }) })
    if (!response.ok || response.headers.has('mcp-session-id')) {
      await response.body?.cancel()
      throw new ConnectorError('provider_unavailable')
    }
    return response
  }

  async function request(method: 'initialize' | 'tools/list' | 'tools/call', params?: object) {
    const id = nextId++
    return rpcResponse(await post({ id, method, ...(params ? { params } : {}) }), id)
  }

  const server = serverSchema.safeParse(await request('initialize', {
    protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'dshpa-read-connector', version: '1.0.0' },
  }))
  if (!server.success) throw new ConnectorError('capability_changed')
  const serverIdentity = server.data
  const accepted = await post({ method: 'notifications/initialized' })
  await accepted.body?.cancel()
  if (accepted.status !== 202) throw new ConnectorError('invalid_result')

  async function describe() {
    const list = toolList.safeParse(await request('tools/list'))
    if (!list.success || list.data.nextCursor !== undefined) throw new ConnectorError('capability_changed')
    const names = new Set(list.data.tools.map(tool => tool.name))
    if (names.size !== list.data.tools.length || Object.values(tools).some(name => !names.has(name))) {
      throw new ConnectorError('capability_changed')
    }
    return fingerprint(serverIdentity, list.data.tools)
  }

  async function call(operation: keyof typeof tools, args: object) {
    const result = toolResult.safeParse(await request('tools/call', { name: tools[operation], arguments: args }))
    if (!result.success || result.data.isError) throw new ConnectorError('invalid_result')
    return result.data.structuredContent
  }

  return { describe, call }
}

/** Local operator enrollment uses discovery only. It cannot invoke a tool. */
export async function inspectMcpReadFingerprint(url: string, signal = AbortSignal.timeout(5000), send = fetch): Promise<string> {
  return (await connect(url, send, signal)).describe()
}

/** The selected MCP facade is a transport for the same strict connector DTOs. */
export function createMcpReadTransport(options: {
  url: string; expectedFingerprint: string; binding: ConnectorBinding; fetch?: typeof fetch
}): ReadConnectorTransport {
  const { url, expectedFingerprint } = options
  const binding = structuredClone(options.binding)
  const send = options.fetch ?? fetch
  return {
    expectedFingerprint,
    async open(signal, authorize) {
      const connection = await connect(url, send, signal, authorize)
      async function revalidate() {
        if (signal.aborted) throw new ConnectorError('provider_unavailable')
        if (await connection.describe() !== expectedFingerprint) throw new ConnectorError('capability_changed')
      }
      return {
        current: () => !signal.aborted,
        async inspect() {
          await revalidate()
          const result = await connection.call('inspect', {})
          await revalidate()
          return { binding: result.binding, fingerprint: expectedFingerprint, capabilities }
        },
        async read(request: ConnectorPageRequest) {
          await revalidate()
          const result = await connection.call(request.operation, { binding, ...request, limit: PAGE_SIZE })
          await revalidate()
          return { ...result, fingerprint: expectedFingerprint }
        },
      }
    },
  }
}
