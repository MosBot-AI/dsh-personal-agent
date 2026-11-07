import type { Context } from '@deepseek-ai/cordis'

export interface PersonalAgentService {
  readonly ready: true
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
  ctx.provide('dshpa', Object.freeze({ ready: true }))
}
