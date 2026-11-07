import { mkdirSync, realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import {
  activateLocalInbox, localInboxConfigSchema, type LocalAttentionService, type LocalComputeService, type LocalRoutingService,
} from './inbox/host.js'
import { createHostAdapter, type HostAdapter } from './runtime/host-adapter.js'
import { installNativeScheduleSink } from './runtime/native-schedule.js'

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
  const inbox = config?.inbox === undefined || config.inbox === false ? undefined : localInboxConfigSchema.parse(config.inbox)
  const sink = installNativeScheduleSink(ctx)
  if (inbox?.routines) {
    mkdirSync(inbox.workRoot, { recursive: true, mode: 0o700 })
    sink.configure({ storageDirectory: inbox.storageDirectory, cwd: realpathSync(inbox.workRoot) })
  }
  ctx.provide('dshpaScheduleSink', sink)
  ctx.provide('dshpaScheduleResolverReady', true)
  ctx.effect(() => () => sink.dispose(), 'dshpa: private schedule mailbox')
  if (!inbox) return
  const dependencies = ['connection', 'sessions', 'webServer', ...(inbox.routines ? ['schedule'] : [])]
  ctx.inject(dependencies, web => {
    web.effect(() => {
      const runtime = activateLocalInbox(web, host, inbox, { schedule: inbox.routines ? sink.connect(web) : undefined })
      web.provide('dshpaRouting', runtime.routing)
      web.provide('dshpaAttention', runtime.attention)
      web.provide('dshpaCompute', runtime.compute)
      return () => runtime.dispose()
    }, 'dshpa: authenticated local inbox')
  })
}
