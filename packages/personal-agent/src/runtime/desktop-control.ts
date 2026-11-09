import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { desktopApplicationSchema, type DesktopActivity, type DesktopTarget } from '../domain/model.js'
import type { WorkState } from '../domain/transitions.js'
import type { IdentityBoundary, OwnerIdentity } from '../policy/identity.js'
import type { WorkRef, WorkStore } from '../storage/store.js'
import { bindBrowserWorkflow, browserApplication, browserProfileSchema, type BrowserProfile } from './browser.js'
import { bindDesktopWorkflow, createDesktopTool, type DesktopWait } from './desktop.js'
import { createResourceLeases, type ResourceLease, type ResourceLeases } from './resource-leases.js'

export const desktopConfigSchema = z.strictObject({
  applications: z.array(desktopApplicationSchema.refine(value => !value.startsWith('browser.'))).max(16).default([]),
  browserProfiles: z.array(browserProfileSchema).max(8).default([]),
  leaseMs: z.int().min(1_000).max(30 * 60_000).default(5 * 60_000),
}).refine(config => config.applications.length + config.browserProfiles.length > 0
  && new Set(config.applications).size === config.applications.length
  && new Set(config.browserProfiles.map(profile => profile.id)).size === config.browserProfiles.length)

export interface DesktopGrant {
  readonly application: string
  readonly signal: AbortSignal
  readonly bind?: (agent: Agent) => void
  readonly tool: ToolDefinition
  readonly probes: (resuming: boolean) => readonly object[]
  readonly waiting: () => DesktopWait | undefined
  readonly takenOver: () => boolean
  readonly finish: () => void
}

type Binding = {
  ref: WorkRef; attemptId: WorkState['attempt']['id']; target: DesktopTarget; lease: ResourceLease
}

const fail = (code: 'permission_denied' | 'resource_busy' | 'stale_lease') => ({ ok: false, code }) as const

/** Owner control of the local desktop. The lease object never crosses the inbox transport. */
export function createDesktopControl({ store, identity, config, native, nativeBrowser, bindBrowser, leases = createResourceLeases() }: {
  store: WorkStore
  identity: IdentityBoundary
  config: z.infer<typeof desktopConfigSchema>
  native: () => ToolDefinition | undefined
  bindBrowser?: (profile: BrowserProfile, agent: Agent, signal: AbortSignal) => boolean
  nativeBrowser: (profile: BrowserProfile, name: string, execution: ToolRunContext) => ToolDefinition | undefined
  leases?: ResourceLeases
}) {
  const bindings = new Map<string, Binding>()
  const approvedTools = new WeakSet<ToolDefinition>()
  const browsers = new Map(config.browserProfiles.map(profile => [browserApplication(profile), profile]))
  const targets: readonly DesktopTarget[] = Object.freeze([
    ...config.applications.map(application => ({ application })),
    ...[...browsers].map(([application, profile]) => ({ application, startUrl: profile.startUrl })),
  ])

  function active(key: string) {
    const current = bindings.get(key)
    if (!current) return undefined
    const status = leases.inspect(current.lease)
    if (!status) {
      if (bindings.get(key) === current) bindings.delete(key)
      return undefined
    }
    return { current, status }
  }

  function sameOwner(ref: WorkRef, owner: OwnerIdentity): boolean {
    return ref.ownerId === owner.ownerId && ref.profileId === owner.profileId
  }

  return Object.freeze({
    targets,
    allows: (definition: ToolDefinition | undefined) => definition !== undefined && approvedTools.has(definition),
    activity(owner: OwnerIdentity): DesktopActivity[] {
      return [...bindings.keys()].flatMap(key => {
        const live = active(key)
        if (!live || !sameOwner(live.current.ref, owner)) return []
        return [{ ...live.status, ...live.current.target, taskId: live.current.ref.taskId, leaseId: live.current.lease.id }]
      })
    },
    acquire(owner: OwnerIdentity, token: unknown, ref: WorkRef, state: WorkState, application: string):
    { ok: true; grant: DesktopGrant } | ReturnType<typeof fail> {
      const target = targets.find(item => item.application === application)
      if (!target || identity.resolveOwner(token) !== owner || !sameOwner(ref, owner)) {
        return fail('permission_denied')
      }
      const attemptId = state.attempt.id
      const generation = state.attempt.generation
      const options = {
        lifetimeMs: config.leaseMs,
        isCurrent() {
          if (!store.canDispatch() || identity.resolveOwner(token) !== owner) return false
          const current = store.getWork(ref)
          return current?.task.generation === generation && current.attempt.id === attemptId
            && current.attempt.mandate.policyVersion === owner.policyVersion
            && !['completed', 'failed', 'cancelled', 'cancelling', 'reconciliation_required'].includes(current.task.status)
        },
      }
      const browser = browsers.get(application)
      const key = browser ? application : 'desktop'
      const live = active(key)
      if (live && (live.status.phase !== 'human' || live.current.ref.taskId !== ref.taskId
        || !sameOwner(live.current.ref, owner) || live.current.attemptId !== attemptId || live.current.target.application !== application)) {
        return fail('resource_busy')
      }
      const result = live ? leases.resume(live.current.lease, options)
        : leases.acquire(browser ? { kind: 'browser', profileId: browser.id } : { kind: 'desktop' }, options)
      if (!result.ok) return fail(result.code === 'resource_busy' ? 'resource_busy' : 'stale_lease')
      const lease = result.value
      const captured: Binding = { ref: { ...ref }, attemptId, target, lease }
      bindings.set(key, captured)
      let tool: ToolDefinition
      let waiting: DesktopGrant['waiting']
      let probes: DesktopGrant['probes']
      let bind: DesktopGrant['bind']
      if (browser) {
        let bound = false
        bind = agent => { bound = bindBrowser?.(browser, agent, leases.signal(lease)) === true }
        const workflow = bindBrowserWorkflow(leases, lease, browser, (name, exec) => bound ? nativeBrowser(browser, name, exec) : undefined)
        tool = workflow.tool
        waiting = workflow.waiting
        probes = () => [{ method: 'open' }]
      } else {
        const workflow = bindDesktopWorkflow(leases, lease, application)
        const pinned = native()
        tool = createDesktopTool(workflow, () => pinned && native() === pinned ? pinned : undefined)
        waiting = () => workflow.status().wait
        probes = resuming => [
          { method: 'getCapabilities', params: {} },
          // Recheck current application consent before a resumed transcript can disclose prior AX results.
          ...(resuming ? [{ method: 'getApp', params: { selector: application } }] : []),
        ]
      }
      const takenOver = () => leases.inspect(lease)?.phase === 'human'
      const grant: DesktopGrant = Object.freeze({
        application, signal: leases.signal(lease), tool, waiting, probes, takenOver,
        ...(bind ? { bind } : {}),
        finish() {
          if (!takenOver()) leases.release(lease)
        },
      })
      approvedTools.add(grant.tool)
      return { ok: true, grant }
    },
    control(owner: OwnerIdentity, ref: WorkRef, leaseId: string, command: 'takeover' | 'release'): boolean {
      const key = [...bindings].find(([, binding]) => binding.lease.id === leaseId)?.[0]
      const live = key && active(key)
      if (!live || !sameOwner(live.current.ref, owner) || live.current.ref.taskId !== ref.taskId || live.current.lease.id !== leaseId) return false
      return command === 'takeover' ? leases.takeover(live.current.lease) : leases.release(live.current.lease)
    },
    close: leases.close,
  })
}

export type DesktopControl = ReturnType<typeof createDesktopControl>
