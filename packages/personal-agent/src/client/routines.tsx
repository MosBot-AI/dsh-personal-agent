import { useState, type FormEvent } from 'react'
import type { InboxReminder, InboxRequest, InboxRoutine, InboxTask } from '../inbox/protocol.js'
import { formatTime, type Translate } from './copy.js'
import { requestId } from './task.js'

interface Draft {
  readonly routine?: InboxRoutine
  title: string
  timing: 'at' | 'cron'
  instant: string
  expression: string
  timeZone: string
  misfire: InboxRoutine['misfire']
  target: 'reminder' | 'goal'
  text: string
  taskId: string
}

function draftFor(routine?: InboxRoutine): Draft {
  const timing = routine?.timing
  const target = routine?.target
  return { routine, title: routine?.title ?? '', timing: timing?.kind ?? 'at',
    instant: timing?.kind === 'at' ? timing.at.slice(0, 19) : '',
    expression: timing?.kind === 'cron' ? timing.expression : '', timeZone: timing?.kind === 'cron' ? timing.timeZone : 'UTC',
    misfire: routine?.misfire ?? 'skip', target: target?.kind ?? 'reminder',
    text: target?.kind === 'reminder' ? target.text : '', taskId: target?.kind === 'goal' ? target.taskId : '' }
}

export function Reminders({ items, t }: { items: readonly InboxReminder[]; t: Translate }) {
  if (items.length === 0) return null
  return <section className="dshpa-section" aria-labelledby="dshpa-reminders">
    <h2 id="dshpa-reminders">{t('routine.reminders')}</h2>
    {items.map(item => <article className="dshpa-card" key={item.id}>
      <h3>{item.title}</h3><p>{item.text}</p>
      <p className="dshpa-muted">{t('routine.delivered')} <time dateTime={item.deliveredAt}>{formatTime(item.deliveredAt, t)}</time></p>
      {item.intendedAt !== item.deliveredAt && <p className="dshpa-muted">
        {t('routine.intended')} <time dateTime={item.intendedAt}>{formatTime(item.intendedAt, t)}</time>
      </p>}
    </article>)}
  </section>
}

interface RoutineProps {
  readonly routines: readonly InboxRoutine[]
  readonly tasks: readonly InboxTask[]
  readonly writable: boolean
  readonly busy: boolean
  readonly t: Translate
  readonly submit: (request: InboxRequest, acknowledged?: () => void) => void
}

export function Routines({ routines, tasks, writable, busy, t, submit }: RoutineProps) {
  const [draft, setDraft] = useState<Draft>()
  const disabled = !writable || busy
  const waiting = tasks.filter(task => task.status === 'waiting_event' && task.runtime === 'inactive')
  const selected = waiting.find(task => task.id === draft?.taskId)

  function change(fields: Partial<Draft>) {
    setDraft(current => current && { ...current, ...fields })
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft || disabled) return
    const at = draft.timing === 'at' ? new Date(`${draft.instant}Z`) : undefined
    if (at && Number.isNaN(at.getTime())) return
    const timing = at ? { kind: 'at', at: at.toISOString() } as const
      : { kind: 'cron', expression: draft.expression.trim(), timeZone: draft.timeZone.trim() } as const
    const target = draft.target === 'reminder' ? { kind: 'reminder', text: draft.text.trim() } as const
      : selected && { kind: 'goal', taskId: selected.id, expectedVersion: selected.version } as const
    if (!target || !draft.title.trim()) return
    submit({ type: 'save_routine', commandId: requestId(), routineId: draft.routine?.id, expectedRevision: draft.routine?.revision,
      draft: { title: draft.title.trim(), timing, target, misfire: draft.misfire } }, () => setDraft(undefined))
  }

  return <details className="dshpa-card dshpa-projects dshpa-routines">
    <summary>{t('routine.heading')}</summary>
    <div className="dshpa-actions"><button type="button" disabled={disabled} onClick={() => setDraft(draftFor())}>
      {t('routine.new')}
    </button></div>
    {draft && <form className="dshpa-form" onSubmit={save}>
      <label>{t('routine.title')}<input required maxLength={120} disabled={disabled} value={draft.title}
        onChange={event => change({ title: event.currentTarget.value })} /></label>
      <label>{t('routine.timing')}<select disabled={disabled} value={draft.timing}
        onChange={event => change({ timing: event.currentTarget.value === 'cron' ? 'cron' : 'at' })}>
        <option value="at">{t('routine.once')}</option><option value="cron">{t('routine.recurring')}</option>
      </select></label>
      {draft.timing === 'at' ? <label>{t('routine.utcTime')}<input type="datetime-local" step={1} required disabled={disabled}
        value={draft.instant} onChange={event => change({ instant: event.currentTarget.value })} /></label> : <>
        <label>{t('routine.cron')}<input required maxLength={256} disabled={disabled} value={draft.expression}
          placeholder="0 9 * * 1-5" onChange={event => change({ expression: event.currentTarget.value })} /></label>
        <label>{t('routine.zone')}<input required maxLength={80} disabled={disabled} value={draft.timeZone}
          onChange={event => change({ timeZone: event.currentTarget.value })} /></label>
      </>}
      <label>{t('routine.misfire')}<select disabled={disabled} value={draft.misfire}
        onChange={event => change({ misfire: event.currentTarget.value === 'latest' ? 'latest' : 'skip' })}>
        <option value="skip">{t('routine.skip')}</option><option value="latest">{t('routine.latest')}</option>
      </select></label>
      <label>{t('routine.target')}<select disabled={disabled} value={draft.target}
        onChange={event => change({ target: event.currentTarget.value === 'goal' ? 'goal' : 'reminder' })}>
        <option value="reminder">{t('routine.reminder')}</option><option value="goal">{t('routine.goal')}</option>
      </select></label>
      {draft.target === 'reminder' ? <label>{t('routine.message')}
        <textarea required maxLength={4096} rows={2} disabled={disabled} value={draft.text}
          onChange={event => change({ text: event.currentTarget.value })} />
      </label> : <label>{t('routine.waitingTask')}<select required disabled={disabled} value={selected?.id ?? ''}
        onChange={event => change({ taskId: event.currentTarget.value })}>
        <option value="">{t('routine.chooseTask')}</option>{waiting.map(task => <option key={task.id} value={task.id}>{task.outcome}</option>)}
      </select></label>}
      <div className="dshpa-actions">
        <button className="dshpa-primary" disabled={disabled}>{t('routine.saveDraft')}</button>
        <button type="button" disabled={busy} onClick={() => setDraft(undefined)}>{t('routine.closeDraft')}</button>
      </div>
    </form>}
    <ul>{routines.map(routine => {
      const control = { routineId: routine.id, expectedRevision: routine.revision }
      return <li key={routine.id}>
        <div><strong>{routine.title}</strong> · {t(`routine.state.${routine.state}`)}</div>
        <p className="dshpa-muted">{routine.timing.kind === 'at' ? formatTime(routine.timing.at, t)
          : `${routine.timing.expression} · ${routine.timing.timeZone}`}</p>
        {routine.nextAt && <p className="dshpa-muted">{t('routine.next')} {formatTime(routine.nextAt, t)}</p>}
        {routine.issue && <p className="dshpa-muted">{t('routine.reconcile')}</p>}
        {routine.last && <p className="dshpa-muted">{t(`routine.outcome.${routine.last.status}`)} · {formatTime(routine.last.at, t)}
          {routine.last.reason && <> · <code>{routine.last.reason}</code></>}
        </p>}
        <div className="dshpa-actions">
          <button type="button" disabled={disabled} onClick={() => setDraft(draftFor(routine))}>{t('routine.edit')}</button>
          {routine.state === 'armed' || routine.state === 'ended' ? <>
            <button type="button" disabled={disabled} onClick={() => submit({ type: 'pause_routine', commandId: requestId(), ...control })}>{t('routine.pause')}</button>
            <button type="button" disabled={disabled} onClick={() => submit({ type: 'run_routine_now', commandId: requestId(), ...control })}>{t('routine.runNow')}</button>
          </> : <button type="button" disabled={disabled}
            onClick={() => submit({ type: 'arm_routine', commandId: requestId(), ...control })}>{t('routine.arm')}</button>}
        </div>
      </li>
    })}</ul>
  </details>
}
