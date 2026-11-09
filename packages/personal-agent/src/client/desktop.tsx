import { useState } from 'react'
import type { InboxRequest, InboxSnapshot, InboxTask } from '../inbox/protocol.js'
import type { Translate } from './copy.js'
import { requestId } from './task.js'

type Activity = NonNullable<InboxSnapshot['desktopActivities']>[number]
type Target = NonNullable<InboxSnapshot['desktopTargets']>[number]

export function DesktopActivityCard({ activity, disabled, t, submit, viewTask }: {
  activity: Activity; disabled: boolean; t: Translate
  submit: (request: InboxRequest) => void; viewTask: (id: string) => void
}) {
  const { phase, application, inFlight, taskId, leaseId, startUrl } = activity
  return <section className="dshpa-card dshpa-attention" aria-label={t('desktop.title')}>
    <p role="status">{t(startUrl ? `desktop.browser.${phase}` : `desktop.${phase}`)} · {startUrl ?? application}</p>
    {inFlight && <p className="dshpa-muted">{t('desktop.inFlight')}</p>}
    <div className="dshpa-actions">
      <button type="button" onClick={() => viewTask(taskId)}>{t('today.showTask')}</button>
      {phase === 'automation' && <button type="button" disabled={disabled} onClick={() =>
        submit({ type: 'desktop_takeover', taskId, leaseId })}>{t(startUrl ? 'desktop.browser.pause' : 'desktop.takeover')}</button>}
      {phase === 'human' && <button type="button" disabled={disabled} onClick={() =>
        submit({ type: 'desktop_release', taskId, leaseId })}>{t(startUrl ? 'desktop.browser.release' : 'desktop.release')}</button>}
    </div>
  </section>
}

export function DesktopLaunch({ task, targets, activities, disabled, t, submit }: {
  task: InboxTask; targets: readonly Target[]; activities: readonly Activity[]; disabled: boolean
  t: Translate; submit: (request: InboxRequest) => void
}) {
  const [selected, setSelected] = useState('')
  if (!task.canStartDesktop) return null
  const application = task.desktopApplication ?? selected
  const target = targets.find(row => row.application === application)
  const occupied = activities.some(activity => (target?.startUrl ? activity.application === application : !activity.startUrl)
    && (activity.taskId !== task.id || activity.phase !== 'human' || activity.inFlight))
  return <section className="dshpa-card dshpa-form" aria-label={t('desktop.title')}>
    <p className="dshpa-muted">{t(target?.startUrl ? 'desktop.browser.disclosure' : 'desktop.disclosure')}</p>
    {task.desktopApplication ? <p>{target?.startUrl ?? task.desktopApplication}</p>
      : <label>{t('desktop.application')}
        <select value={selected} disabled={disabled} onChange={event => setSelected(event.currentTarget.value)}>
          <option value="">{t('desktop.select')}</option>
          {targets.map(row => <option key={row.application} value={row.application}>{row.startUrl ?? row.application}</option>)}
        </select>
      </label>}
    <button type="button" disabled={disabled || occupied || task.runtime !== 'inactive' || !target}
      onClick={() => submit({ type: 'desktop_start', taskId: task.id, expectedVersion: task.version, cursor: requestId(), application })}>
      {t(target?.startUrl ? (task.desktopApplication ? 'desktop.browser.continue' : 'desktop.browser.start')
        : (task.desktopApplication ? 'desktop.continue' : 'desktop.start'))}
    </button>
  </section>
}
