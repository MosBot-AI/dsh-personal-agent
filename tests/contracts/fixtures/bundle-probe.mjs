export const inject = ['appReady', 'appExit', 'loader']

async function inspectBundle(ctx) {
  const service = ctx.get('dshpa')
  if (service === undefined) {
    process.stdout.write('DSHPA_ABSENT\n')
    return
  }

  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'dshpa')
  if (service.ready !== true || !entry?.fiber) {
    throw new Error('The dshpa service must belong to the mounted bundle entry')
  }
  process.stdout.write('DSHPA_LOADED\n')
  await entry.fiber.dispose()
  if (ctx.get('dshpa') !== undefined) {
    throw new Error('The dshpa service remained available after disposal')
  }
  process.stdout.write('DSHPA_DISPOSED\n')
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void inspectBundle(ctx).then(() => ctx.appExit(0), error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
