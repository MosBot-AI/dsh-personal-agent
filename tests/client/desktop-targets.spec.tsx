// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { DesktopLaunch } from '../../packages/personal-agent/src/client/desktop.js'
import { dictionaries } from '../../packages/personal-agent/src/client/copy.js'
import type { InboxTask } from '../../packages/personal-agent/src/inbox/protocol.js'

beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }))
const task = { id: 'task', projectId: 'project', sessionId: 'session', outcome: 'Edit document', status: 'queued',
  runtime: 'inactive', version: 1, artifacts: [], deliveries: [], canStartDesktop: true } satisfies InboxTask

describe('explicit Linux desktop target disclosure', () => {
  it.each(['en', 'zh'] as const)('keeps Linux unavailable and legacy macOS selectable in %s', async language => {
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    const submit = vi.fn()
    onTestFinished(async () => { await act(async () => root.unmount()); node.remove() })
    await act(async () => root.render(<DesktopLaunch task={task} targets={[
      { application: 'linux:chromium', unavailableReason: 'linux_binding_unavailable' },
      { application: 'com.apple.TextEdit' },
    ]} activities={[]} disabled={false} submit={submit} t={key => dictionaries[language][key]} />))
    const select = node.querySelector('select')!
    await act(async () => { select.value = 'linux:chromium'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(node.querySelector('[role="status"]')?.textContent).toBe(dictionaries[language]['desktop.linux.unavailable'])
    const start = node.querySelector('button')!
    expect(start.disabled).toBe(true)
    expect(start.textContent).toBe(dictionaries[language]['desktop.linux.unavailableAction'])
    await act(async () => start.click())
    expect(submit).not.toHaveBeenCalled()
    expect(node.textContent).not.toContain(dictionaries[language]['desktop.disclosure'])
    await act(async () => { select.value = 'com.apple.TextEdit'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(start.disabled).toBe(false)
    await act(async () => start.click())
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ type: 'desktop_start', application: 'com.apple.TextEdit' }))
  })
})
