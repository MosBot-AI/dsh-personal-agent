import { mkdirSync, realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import {
  activateLocalInbox, localInboxConfigSchema, type LocalAttentionService, type LocalComputeService, type LocalRoutingService,
} from './inbox/host.js'
import { createHostAdapter, type HostAdapter } from './runtime/host-adapter.js'
import { installNativeScheduleSink } from './runtime/native-schedule.js'
import { openWorkStore, type WorkStore } from './storage/store.js'

export interface PersonalAgentService {
  readonly ready: true
  readonly host: HostAdapter
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshpa: PersonalAgentService
    dshpaRouting: LocalRoutingService
    dshpaAttention: LocalAttentionService
    dshpaCompute: LocalComputeService
  }
}

export const name = 'dshpa'
export const inject = ['agents']

export function apply(ctx: Context, config?: { inbox?: unknown }): void {
  // Cordis owns the registration and removes it with the bundle fiber.
  const host = createHostAdapter(ctx)
  ctx.provide('dshpa', Object.freeze({ ready: true, host }))
  const launchedResident = process.env.DSHPA_RESIDENT === '1'
  const exitResident = () => {
    const exit = ctx.get('appExit')
    if (typeof exit === 'function') exit(1)
  }
  let inbox: ReturnType<typeof localInboxConfigSchema.parse> | undefined
  let reservedStore: WorkStore | undefined
  try {
    inbox = config?.inbox === undefined || config.inbox === false ? undefined : localInboxConfigSchema.parse(config.inbox)
    if (launchedResident && !inbox?.resident) throw new Error('The resident launcher requires inbox.resident configuration')
    if (inbox?.resident) reservedStore = openWorkStore(inbox.storageDirectory)
  } catch (error) {
    if (launchedResident || inbox?.resident) exitResident()
    throw error
  }
  // The resident writer lease precedes the native schedule resolver readiness.
  // Once the inbox validates its carrier, the inbox owns this store's teardown.
  if (reservedStore) ctx.effect(() => () => reservedStore?.close(), 'dshpa: resident startup writer')
  const takeResidentStore = () => {
    const store = reservedStore
    reservedStore = undefined
    return store
  }
  let sink: ReturnType<typeof installNativeScheduleSink>
  try {
    sink = installNativeScheduleSink(ctx)
    const scheduleSink = sink
    ctx.effect(() => () => scheduleSink.dispose(), 'dshpa: private schedule mailbox')
    if (inbox?.routines) {
      mkdirSync(inbox.workRoot, { recursive: true, mode: 0o700 })
      sink.configure({ storageDirectory: inbox.storageDirectory, cwd: realpathSync(inbox.workRoot) })
    }
    ctx.provide('dshpaScheduleSink', sink)
    ctx.provide('dshpaScheduleResolverReady', true)
  } catch (error) {
    if (inbox?.resident) exitResident()
    throw error
  }
  if (!inbox) return
  const dependencies = ['connection', 'sessions', 'webServer', ...(inbox.routines ? ['schedule'] : []),
    ...(inbox.resident ? ['appReady'] : [])]
  ctx.inject(dependencies, web => {
    web.effect(() => {
      try {
        const runtime = activateLocalInbox(web, host, inbox, {
          schedule: inbox.routines ? sink.connect(web) : undefined, takeResidentStore,
        })
        web.provide('dshpaRouting', runtime.routing)
        web.provide('dshpaAttention', runtime.attention)
        web.provide('dshpaCompute', runtime.compute)
        return () => runtime.dispose()
      } catch (error) {
        if (inbox.resident) exitResident()
        throw error
      }
    }, 'dshpa: authenticated local inbox')
  })
}
