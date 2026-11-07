import type { Context } from '@deepseek-ai/cordis'
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

export function apply(ctx: Context): void {
  // Cordis owns the registration and removes it with the bundle fiber.
  ctx.provide('dshpa', Object.freeze({ ready: true, host: createHostAdapter(ctx) }))
}
