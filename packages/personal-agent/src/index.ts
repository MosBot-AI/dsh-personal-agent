import type { Context } from '@deepseek-ai/cordis'
import { activateLocalInbox, localInboxConfigSchema } from './inbox/host.js'
import { createHostAdapter, type HostAdapter } from './runtime/host-adapter.js'

export interface PersonalAgentService {
  readonly ready: true
  readonly host: HostAdapter
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshpa: PersonalAgentService
  }
}

export const name = 'dshpa'
export const inject = ['agents']

export function apply(ctx: Context, config?: { inbox?: unknown }): void {
  // Cordis owns the registration and removes it with the bundle fiber.
  const host = createHostAdapter(ctx)
  ctx.provide('dshpa', Object.freeze({ ready: true, host }))
  if (config?.inbox === undefined || config.inbox === false) return
  const inbox = localInboxConfigSchema.parse(config.inbox)
  ctx.inject(['connection', 'sessions', 'webServer'], web => {
    web.effect(() => {
      const runtime = activateLocalInbox(web, host, inbox)
      return () => runtime.dispose()
    }, 'dshpa: authenticated local inbox')
  })
}
