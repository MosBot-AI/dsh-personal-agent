import type { InboxUsage } from '../inbox/protocol.js'
import { formatTime, type Translate } from './copy.js'

const modeLabels = {
  off: 'usage.mode.off', observe: 'usage.mode.observe', prepare: 'usage.mode.prepare', act: 'usage.mode.act',
} as const

function money(micros: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: 6,
  }).format(micros / 1_000_000)
}

export function Usage({ usage, t }: { usage: InboxUsage; t: Translate }) {
  const locale = t('locale')
  const number = new Intl.NumberFormat(locale)
  const count = (value: number) => number.format(value)
  const capacity = (active: number, limit: number) => `${count(active)} / ${count(limit)}`
  return <details className="dshpa-card dshpa-usage">
    <summary>{t('usage.heading')}</summary>
    <p className="dshpa-muted">{t('usage.utcDay')} <time dateTime={usage.day}>{usage.day}</time></p>
    {usage.currencies.map(row => <dl className="dshpa-fields" key={row.currency}>
      <dt>{t('usage.spent')}</dt><dd>{money(row.spentMicros, row.currency, locale)}</dd>
      <dt>{t('usage.reserved')}</dt><dd>{money(row.reservedMicros, row.currency, locale)}</dd>
      <dt>{t('usage.uncertain')}</dt><dd>{money(row.uncertainMicros, row.currency, locale)}</dd>
      {row.olderHeldMicros > 0 && <>
        <dt>{t('usage.olderHeld')}</dt><dd>{money(row.olderHeldMicros, row.currency, locale)}</dd>
      </>}
      {row.dailyLimitMicros !== undefined && <>
        <dt>{t('usage.limit')}</dt><dd>{money(row.dailyLimitMicros, row.currency, locale)}</dd>
      </>}
      {row.overflow && <><dt>{row.currency}</dt><dd>{t('usage.overflow')}</dd></>}
    </dl>)}
    <dl className="dshpa-fields">
      <dt>{t('usage.routing')}</dt><dd>{t(`usage.routing.${usage.routing}`)}</dd>
      <dt>{t('usage.calls')}</dt><dd>{count(usage.calls)}</dd>
      <dt>{t('usage.unknownCalls')}</dt><dd>{count(usage.unknownCalls)}</dd>
      <dt>{t('usage.uncertainCalls')}</dt><dd>{count(usage.uncertainCalls)}</dd>
      <dt>{t('usage.inputTokens')}</dt><dd>{count(usage.tokens.input)}</dd>
      <dt>{t('usage.outputTokens')}</dt><dd>{count(usage.tokens.output)}</dd>
      <dt>{t('usage.cacheRead')}</dt><dd>{count(usage.tokens.cacheRead)}</dd>
      <dt>{t('usage.cacheWrite')}</dt><dd>{count(usage.tokens.cacheWrite)}</dd>
      <dt>{t('usage.workers')}</dt><dd>{capacity(usage.workerSlots.active, usage.workerSlots.limit)}</dd>
      <dt>{t('usage.gpu')}</dt><dd>{capacity(usage.gpu.active, usage.gpu.limit)}</dd>
      <dt>{t('usage.gpuQueued')}</dt><dd>{count(usage.gpu.queued)}</dd>
    </dl>
    {usage.attention && <>
      <h3>{t('usage.attention')}</h3>
      <p className="dshpa-muted"><time dateTime={usage.attention.day}>{usage.attention.day}</time> · {usage.attention.timeZone}</p>
      <dl className="dshpa-fields">
        <dt>{t('usage.mode')}</dt><dd>{t(modeLabels[usage.attention.mode])}</dd>
        <dt>{t('usage.unsolicited')}</dt><dd>{capacity(usage.attention.unsolicited, usage.attention.limit)}</dd>
        <dt>{t('usage.suppressed')}</dt><dd>{count(usage.attention.suppressed)}</dd>
      </dl>
      {usage.attention.recent.length > 0 && <div>
        <h4>{t('usage.reasons')}</h4>
        <ul>{usage.attention.recent.map(decision => <li key={decision.id}>
          <code>{decision.reason}</code> · <time dateTime={decision.at}>{formatTime(decision.at, t)}</time>
        </li>)}</ul>
      </div>}
    </>}
  </details>
}
