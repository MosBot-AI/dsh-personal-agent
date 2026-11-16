export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.restrict({ allow: [] })
  ctx.tools.guard(() => 'The paired text-only evaluation admits no model tools')
}
