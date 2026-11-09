import { describe, expect, it, vi } from 'vitest'
import { bindBrowserWorkflow, browserApplication } from '../../packages/personal-agent/src/runtime/browser.js'
import { createResourceLeases } from '../../packages/personal-agent/src/runtime/resource-leases.js'

type ToolDefinition = ReturnType<typeof bindBrowserWorkflow>['tool']
type ToolRunContext = Parameters<ToolDefinition['execute']>[1]

const profile = { id: 'docs', startUrl: 'https://docs.example.test/start' }
const blank = { id: 2, url: 'https://unrelated.example.test/private', selected: false }
const providerPrefix = 'mcp__chrome-devtools-mcp__'

function fixture() {
  const leases = createResourceLeases()
  const acquired = leases.acquire({ kind: 'browser', profileId: profile.id }, { lifetimeMs: 30_000, isCurrent: () => true })
  if (!acquired.ok) throw new Error(acquired.code)
  const lease = acquired.value
  let url = profile.startUrl
  const selected = true
  let isolation: string | undefined
  let id = 4
  const wrapped = (value: object) => ({ structuredContent: value, content: [{ type: 'text', text: 'Untrusted provider text' }] })
  const pages = () => ({ pages: [blank, { id, url, selected, isolatedContext: isolation }] })
  const calls = {
    new_page: vi.fn(async (args: { url: string; isolatedContext: string; background: boolean }) => {
      isolation = args.isolatedContext
      url = args.url
      return wrapped(pages())
    }),
    list_pages: vi.fn(async () => wrapped(pages())),
    take_snapshot: vi.fn(async () => wrapped({ snapshot: { id: '1_1', role: 'RootWebArea', name: 'Docs',
      children: [{ id: '1_2', role: 'button', name: 'Save' },
        { id: '1_3', role: 'Iframe', name: 'Frame', children: [{ id: '1_4', role: 'button', name: 'Private frame' }] }],
    } })),
    navigate_page: vi.fn(async (args: { url: string }) => { url = args.url; return wrapped({}) }),
    click: vi.fn(async () => wrapped({})),
    fill: vi.fn(async () => wrapped({})),
  }
  const definitions = new Map(Object.entries(calls).map(([method, execute]) => {
    const name = providerPrefix + method
    return [name, { name, description: 'Native fixture', parameters: { type: 'object' },
      output: { schema: {}, render: () => [] }, execute } as ToolDefinition]
  }))
  const { tool, waiting } = bindBrowserWorkflow(leases, lease, profile, name => definitions.get(name))
  return { leases, lease, waiting, calls,
    switchTab: () => { id++ }, setUrl: (next: string) => { url = next },
    call: (request: object) => tool.execute(request, { signal: new AbortController().signal } as ToolRunContext),
  }
}

describe('scoped DSH browser tools', () => {
  it('creates an isolated tab and fences actions to the latest top-level observation', async () => {
    const f = fixture()
    try {
      expect(await f.call({ method: 'open' })).toEqual({ ok: true })
      expect(f.calls.new_page).toHaveBeenCalledWith({ url: profile.startUrl, isolatedContext: expect.stringMatching(/^dshpa-/u),
        background: true, timeout: 8000 }, expect.any(Object))
      const observed = await f.call({ method: 'observe' }) as { snapshot: string; elements: { uid: string }[] }
      expect(f.calls.take_snapshot).toHaveBeenCalledWith({ pageId: 4 }, expect.any(Object))
      expect(observed.elements.map(row => row.uid)).toEqual(['1_1', '1_2'])
      expect(JSON.stringify(observed)).not.toContain('Private frame')
      const click = { method: 'click', snapshot: observed.snapshot, uid: '1_2' }
      expect(await f.call({ ...click, uid: '1_4' })).toEqual({ ok: false, code: 'observation_required' })
      expect(await f.call(click)).toEqual({ ok: true })
      expect(f.calls.click).toHaveBeenCalledWith({ pageId: 4, uid: '1_2' }, expect.any(Object))
      expect(await f.call(click)).toEqual({ ok: false, code: 'observation_required' })
      expect(await f.call({ method: 'observe', filePath: '/etc/passwd' })).toEqual({ ok: false, code: 'permission_denied' })
      expect(await f.call({ method: 'navigate', url: 'https://elsewhere.example.test/' })).toEqual({ ok: false, code: 'permission_denied' })
      expect(await f.call({ method: 'navigate', url: 'https://docs.example.test/next' })).toEqual({ ok: true })
      expect(f.calls.navigate_page).toHaveBeenCalledTimes(1)
    } finally { await f.leases.close() }
  })

  it('rejects tab substitution, navigation races, and use after takeover', async () => {
    const f = fixture()
    try {
      expect(await f.call({ method: 'open' })).toEqual({ ok: true })
      const observed = await f.call({ method: 'observe' }) as { snapshot: string }
      const click = { method: 'click', snapshot: observed.snapshot, uid: '1_2' }
      f.setUrl('https://docs.example.test/other')
      expect(await f.call(click)).toEqual({ ok: false, code: 'observation_required' })
      f.switchTab()
      expect(await f.call({ method: 'observe' })).toEqual({ ok: false, code: 'target_unavailable' })
      expect(f.waiting()).toBe('target_unavailable')
      expect(f.calls.click).not.toHaveBeenCalled()
      expect(f.leases.takeover(f.lease)).toBe(true)
      expect(await f.call({ method: 'open' })).toEqual({ ok: false, code: 'stale_lease' })
      expect(browserApplication(profile)).not.toBe(browserApplication({ ...profile, startUrl: 'https://new.example.test/' }))
    } finally { await f.leases.close() }
  })
})
