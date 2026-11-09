import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-browser-use'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import { SessionResources } from '@deepseek-ai/dsh-experimental-browser-use-runtime'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import { z } from 'zod'

const origin = z.url().max(2048).refine(raw => {
  if (!URL.canParse(raw)) return false
  const url = new URL(raw)
  return raw === url.origin && (url.protocol === 'https:'
    || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
}, 'Use an HTTPS or loopback HTTP origin without a path')
const configSchema = z.strictObject({
  executablePath: z.string().max(4096).refine(path => isAbsolute(path) && !path.includes('\0')),
  allowedOrigins: z.array(origin).min(1).max(16).refine(values => new Set(values).size === values.length),
})
const name = 'chrome-devtools-mcp'
const prefix = `mcp__${name}__`
type Binding = { origin: string; signal: AbortSignal }

export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** Reuse DSH's Session ownership and MCP client with immutable task-specific launch authority. */
export function apply(ctx: Context, input: unknown): void {
  const config = configSchema.parse(input)
  const tools = ctx.get('tools')
  const workingDirectory = ctx.get('workingDirectory') as {
    ensure(agent: Agent, signal: AbortSignal): Promise<string>
  } | undefined
  if (!tools || !workingDirectory) throw new Error('Chrome browser provider requires native tools and working directories')
  const bindings = new WeakMap<Agent, Binding>()
  const cli = fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'))
  const resources = new SessionResources(ctx, {
    label: name, exclusive: false,
    async open(agent, signal) {
      const binding = bindings.get(agent)
      if (!binding || binding.signal.aborted) throw new Error('Browser Session has no current task authority')
      const scope = createScope(ctx, agent)
      let closing: Promise<void> | undefined
      const close = () => closing ??= scope.dispose()
      const stop = () => { void close().catch(() => { ctx.logger.warn('Task browser cleanup requires reconciliation') }) }
      const lifetime = AbortSignal.any([signal, binding.signal])
      lifetime.addEventListener('abort', stop, { once: true })
      try {
        lifetime.throwIfAborted()
        await scope.ctx.plugin(McpClient, McpClient.Config({
          transport: 'stdio', serverName: name, command: process.execPath,
          args: [cli, '--isolated', '--headless=true', '--page-id-routing', '--experimental-structured-content',
            '--no-usage-statistics', '--no-performance-crux', '--executable-path', config.executablePath,
            '--allowed-url-pattern', `${binding.origin}/*`],
          cwd: await workingDirectory.ensure(agent, lifetime), toolCallTimeoutMs: 12_000,
          failOnStartupError: true, reconnect: { enabled: false },
        }))
        lifetime.throwIfAborted()
        return { value: scope, async close() {
          lifetime.removeEventListener('abort', stop)
          await close()
        } }
      } catch (error) {
        lifetime.removeEventListener('abort', stop)
        await close()
        throw error
      }
    },
  })
  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName(name))
    yield () => resources.dispose()
  })
  tools.guard(call => call.name.startsWith(prefix) && call.name !== prefix + 'dshpa_browser'
    ? 'Chrome actions require the dshpa browser lease.' : undefined)
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (bindings.has(agent)) await resources.get(agent, signal)
  }, { prepend: true })
  ctx.on('tools/execute', async (call, next) => {
    if (!call.name.startsWith(prefix)) return next()
    const agent = call.agent
    const binding = agent && bindings.get(agent)
    if (!agent || !binding || binding.signal.aborted) throw new Error('Browser call has no current task authority')
    return resources.run(agent, AbortSignal.any([call.signal, binding.signal]), async (_scope, signal) => {
      const original = call.signal
      call.signal = signal
      try { return await next() } finally { call.signal = original }
    })
  })
  ctx.provide('dshpaBrowserChrome', Object.freeze({
    origins: Object.freeze([...config.allowedOrigins]),
    bind(agent: Agent, selectedOrigin: string, signal: AbortSignal): boolean {
      if (signal.aborted || !config.allowedOrigins.includes(selectedOrigin) || bindings.has(agent)) return false
      bindings.set(agent, Object.freeze({ origin: selectedOrigin, signal }))
      return true
    },
  }))
}
