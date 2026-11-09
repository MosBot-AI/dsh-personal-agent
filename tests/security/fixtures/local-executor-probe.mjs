import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const bundle = dirname(require.resolve('@mosbot-ai/dshpa/package.json'))
const load = file => import(pathToFileURL(join(bundle, 'lib', file)).href)
const { installLocalExecutor } = await load('policy/local-executor.js')
const { bindDesktopWorkflow, createDesktopTool } = await load('runtime/desktop.js')
const { createResourceLeases } = await load('runtime/resource-leases.js')

export const inject = ['appReady', 'appExit', 'tools', 'agents']

const app = 'com.apple.TextEdit'
const capabilityRequest = { method: 'getCapabilities', params: {} }
const capabilities = { platform: 'macos', sessionLocked: false, permissions: { accessibility: true, screenRecording: false },
  methods: ['getApp', 'getState', 'click', 'setValue'] }

function tool(name, execute) {
  return { name, description: 'Local executor boundary fixture', parameters: { type: 'object', additionalProperties: true },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute }
}

async function exercise(ctx) {
  const leases = createResourceLeases()
  const granted = leases.acquire({ kind: 'desktop' }, { lifetimeMs: 30_000, isCurrent: () => true })
  assert.ok(granted.ok)
  const workflow = bindDesktopWorkflow(leases, granted.value, app)
  let capabilityCalls = 0
  let shellCalls = 0
  const exposed = tool('cua', async (args, execution) => {
    assert.equal(execution.name, 'cua')
    assert.deepEqual(args, capabilityRequest)
    assert.equal(execution.agent?.id, 'pa031-controlled')
    assert.equal(execution.signal.aborted, false)
    capabilityCalls++
    return capabilities
  })
  ctx.tools.register(exposed)
  ctx.tools.register(tool('bash', async () => { shellCalls++; return 'unrestricted local code' }))

  const handle = await ctx.agents.create({ sessionId: 'pa031-controlled', setup(agentCtx, agent) {
    installLocalExecutor(agentCtx, agent, [createDesktopTool(workflow, () => ctx.tools.get('cua') === exposed ? exposed : undefined)])
  } })
  try {
    handle.agent.ctx.tools.register(tool('late_scoped_mcp', async () => { shellCalls++; return 'unrestricted local code' }))
    let id = 0
    async function call(name, args) {
      const batch = await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: `pa031-${++id}`, name, arguments: JSON.stringify(args) }],
        signal: new AbortController().signal, agent: handle.agent,
      })
      return batch.results[0].result
    }
    for (const name of ['bash', 'run_code', 'cua', 'late_scoped_mcp']) {
      const blocked = await call(name, capabilityRequest)
      assert.equal(blocked.isError, true, JSON.stringify(blocked))
    }
    const allowed = await call('dshpa_desktop', capabilityRequest)
    assert.equal(allowed.isError, false, JSON.stringify(allowed))
    assert.deepEqual(allowed.value, { ok: true, value: capabilities })
    assert.equal(shellCalls, 0)
    assert.equal(capabilityCalls, 1)
    assert.ok(leases.takeover(granted.value))
    const blocked = await call('dshpa_desktop', capabilityRequest)
    assert.equal(blocked.isError, false)
    assert.deepEqual(blocked.value, { ok: false, code: 'stale_lease' })
    assert.equal(capabilityCalls, 1)
  } finally {
    await leases.close()
    await handle.dispose()
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void exercise(ctx).then(() => {
      console.log('PA031_LOCAL_EXECUTOR exact')
      ctx.appExit(0)
    }, error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
