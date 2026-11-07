export const inject = ['appReady', 'dshpaRouting', 'dshpaPlugins']

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => console.log('DSHPA_WEB_FLOW_READY')))
}
