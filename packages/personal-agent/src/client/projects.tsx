import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { ProjectPlanInput } from '../domain/projects.js'
import type { InboxPlan, InboxPort, InboxProject, InboxRequest, InboxResponse, InboxTask } from '../inbox/protocol.js'
import { formatTime, type Translate } from './copy.js'
import { requestId } from './task.js'

type Mutate = (key: string, request: InboxRequest, acknowledge?: () => void) => void
type Review = Extract<InboxResponse, { kind: 'project_review' }>
const emptyDraft: ProjectPlanInput = { title: '', purpose: '', successCriteria: [], milestones: [], priority: 'normal' }

function PlanEditor({ draft, setDraft, rationale, setRationale, disabled, t, submit }: {
  draft: ProjectPlanInput; setDraft: (draft: ProjectPlanInput) => void; rationale: string; setRationale: (value: string) => void
  disabled: boolean; t: Translate; submit: (event: FormEvent<HTMLFormElement>) => void
}) {
  function editMilestone(index: number, update: Partial<ProjectPlanInput['milestones'][number]>) {
    setDraft({ ...draft, milestones: draft.milestones.map((milestone, at) => at === index ? { ...milestone, ...update } : milestone) })
  }
  const criteria = draft.successCriteria.join('\n')
  return <form className="dshpa-form" onSubmit={submit}>
    <fieldset disabled={disabled} className="dshpa-form">
      <label>{t('plan.title')}<input required maxLength={256} value={draft.title}
        onChange={event => setDraft({ ...draft, title: event.currentTarget.value })} /></label>
      <label>{t('plan.purpose')}<textarea required maxLength={4096} value={draft.purpose}
        onChange={event => setDraft({ ...draft, purpose: event.currentTarget.value })} /></label>
      <label>{t('plan.criteria')}<textarea required rows={3} maxLength={16_399} value={criteria}
        onChange={event => setDraft({ ...draft, successCriteria: event.currentTarget.value.split('\n') })} /></label>
      <label>{t('plan.priority')}<select value={draft.priority}
        onChange={event => setDraft({ ...draft, priority: event.currentTarget.value as ProjectPlanInput['priority'] })}>
        {(['high', 'normal', 'low'] as const).map(value => <option key={value} value={value}>{t(`plan.priority.${value}`)}</option>)}
      </select></label>
      <label><span><input type="checkbox" checked={draft.reviewCadence !== undefined}
        onChange={event => setDraft({ ...draft, reviewCadence: event.currentTarget.checked ? { intervalDays: 7, timeZone: 'UTC' } : undefined })} />
        {' '}{t('plan.cadence')}</span></label>
      {draft.reviewCadence && <div className="dshpa-form">
        <label>{t('plan.days')}<input type="number" min={1} max={365} required value={draft.reviewCadence.intervalDays || ''}
          onChange={event => setDraft({ ...draft, reviewCadence: {
            intervalDays: Number(event.currentTarget.value), timeZone: draft.reviewCadence!.timeZone,
          } })} /></label>
        <label>{t('plan.timeZone')}<input required value={draft.reviewCadence.timeZone}
          onChange={event => setDraft({ ...draft, reviewCadence: {
            intervalDays: draft.reviewCadence!.intervalDays, timeZone: event.currentTarget.value,
          } })} /></label>
      </div>}
      <strong>{t('plan.milestones')}</strong>
      {draft.milestones.map((milestone, index) => <div className="dshpa-form" key={index}>
        <label>{t('plan.milestone')}<input required maxLength={256} value={milestone.title}
          onChange={event => editMilestone(index, { title: event.currentTarget.value })} /></label>
        <label>{t('plan.deadline')}<input type="datetime-local" value={milestone.deadline?.at.slice(0, 16) ?? ''}
          onChange={event => editMilestone(index, { deadline: event.currentTarget.value
            ? { at: `${event.currentTarget.value}:00.000Z`, timeZone: 'UTC' } : undefined })} /></label>
        <button type="button" onClick={() => setDraft({ ...draft, milestones: draft.milestones.filter((_, at) => at !== index) })}>
          {t('plan.removeMilestone')}</button>
      </div>)}
      <button type="button" disabled={draft.milestones.length >= 16}
        onClick={() => setDraft({ ...draft, milestones: [...draft.milestones, { title: '' }] })}>{t('plan.addMilestone')}</button>
      <label>{t('plan.rationale')}<textarea required maxLength={4096} value={rationale}
        onChange={event => setRationale(event.currentTarget.value)} /></label>
      <button type="submit" className="dshpa-primary">{t('plan.save')}</button>
    </fieldset>
  </form>
}

export function Projects({ projects, tasks, port, mutate, chooseTask, current, writable, busy, t }: {
  projects: readonly InboxProject[]; tasks: readonly InboxTask[]; port: InboxPort; mutate: Mutate
  chooseTask: (id: string) => void; current: () => boolean; writable: boolean; busy: boolean; t: Translate
}) {
  const id = useId()
  const [selection, select] = useState<string>()
  const [plan, setPlan] = useState<InboxPlan>()
  const [draft, setDraft] = useState<ProjectPlanInput>()
  const [rationale, setRationale] = useState('')
  const [review, setReview] = useState<Review>()
  const [error, setError] = useState(false)
  const reading = useRef<AbortController>()
  useEffect(() => () => reading.current?.abort(), [])

  async function read(request: Extract<InboxRequest, { type: 'project_plan' | 'project_review' }>) {
    if (!current()) return
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    setError(false)
    if (request.type === 'project_plan') {
      select(request.projectId)
      setPlan(undefined)
      setDraft(undefined)
      setRationale('')
    }
    try {
      const result = await port(request, controller.signal)
      if (controller.signal.aborted || !current()) return
      if (request.type === 'project_plan' && result.ok && result.kind === 'project_plan' && result.plan.projectId === request.projectId) {
        setPlan(result.plan)
        setDraft(result.plan.draft)
      } else if (request.type === 'project_review' && result.ok && result.kind === 'project_review') setReview(result)
      else setError(true)
    } catch {
      if (!controller.signal.aborted && current()) setError(true)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft || !writable || busy) return
    const successCriteria = draft.successCriteria.map(value => value.trim()).filter(Boolean)
    const request: InboxRequest = { type: 'save_plan', commandId: requestId(), draft: { ...draft, successCriteria }, rationale,
      ...(plan ? { projectId: plan.projectId, expectedRevision: plan.revision } : {}) }
    mutate('goal-plan', request, () => {
      setReview(undefined)
      if (selection) void read({ type: 'project_plan', projectId: selection })
      else setDraft(undefined)
    })
  }

  function startDraft() {
    reading.current?.abort()
    select(undefined)
    setPlan(undefined)
    setDraft(emptyDraft)
    setRationale('')
    setError(false)
  }

  return <section className="dshpa-card dshpa-section" aria-labelledby={id}>
    <h2 id={id}>{t('plan.heading')}</h2>
    <div className="dshpa-actions">
      <button type="button" disabled={!writable || busy} onClick={startDraft}>{t('plan.newGoal')}</button>
      <button type="button" disabled={busy} onClick={() => { void read({ type: 'project_review' }) }}>{t('plan.weekly')}</button>
    </div>
    {projects.length > 0 && <ul>{projects.map(project => <li key={project.id}>
      <button type="button" disabled={busy} onClick={() => { void read({ type: 'project_plan', projectId: project.id }) }}>
        {project.title}</button>
      <p className="dshpa-muted">{project.purpose}</p>
    </li>)}</ul>}
    {error && <p role="status">{t('notice.failed')}</p>}
    {draft && <PlanEditor draft={draft} setDraft={setDraft} rationale={rationale} setRationale={setRationale}
      disabled={!writable || busy} t={t} submit={submit} />}
    {plan && <details>
      <summary>{t('plan.history')} · {plan.revision}</summary>
      <ol>{plan.history.map(item => <li key={item.revision}>
        <strong>{item.revision} · {item.draft.title}</strong>
        {item.recordedAt && <time dateTime={item.recordedAt}> · {formatTime(item.recordedAt, t)}</time>}
        {item.rationale && <p>{item.rationale}</p>}
        {item.revision !== plan.revision && <button type="button" disabled={!writable || busy} onClick={() => {
          setDraft(item.draft)
          setRationale('')
        }}>
          {t('plan.reuse')}</button>}
      </li>)}</ol>
    </details>}
    {review && <section>
      <h3>{t('plan.weekly')}</h3>
      <time dateTime={review.at}>{formatTime(review.at, t)}</time>
      {review.needsPriority && <p role="status">{t('plan.tradeoff')}</p>}
      <ol>{review.projects.map(item => <li key={item.projectId}>
        <strong>{item.title}</strong> · {t(`plan.priority.${item.priority}`)}
        {item.due && <p>{t('plan.deadline')} · {formatTime(item.due, t)}</p>}
        {item.milestones.length > 0 && <p>{t('plan.milestones')} · {item.milestones.join(' · ')}</p>}
        {(['ready', 'waiting', 'accepted'] as const).map(group => <div key={group}>
          <strong>{t(`plan.review.${group}`)} · {item[group].length}</strong>
          <ul>{item[group].map(taskId => {
            const task = tasks.find(candidate => candidate.id === taskId && candidate.projectId === item.projectId)
            return <li key={taskId}>{task ? <button type="button" onClick={() => chooseTask(taskId)}>{task.outcome}</button> : taskId}</li>
          })}</ul>
        </div>)}
      </li>)}</ol>
    </section>}
  </section>
}

export function TaskPlanning({ task, tasks, writable, busy, mutate, t }: {
  task: InboxTask; tasks: readonly InboxTask[]; writable: boolean; busy: boolean; mutate: Mutate; t: Translate
}) {
  const [chosen, setChosen] = useState(() => task.prerequisites?.map(row => row.id) ?? [])
  const canEdit = writable && (task.status === 'queued' || task.status === 'blocked') && task.runtime === 'inactive'
  const candidates = tasks.filter(item => item.id !== task.id && item.projectId === task.projectId)
  const ids = new Set([...candidates.map(item => item.id), ...chosen, ...(task.prerequisites?.map(row => row.id) ?? [])])
  return <details className="dshpa-card">
    <summary>{t('plan.taskPlanning')}</summary>
    {task.proposal && <div>
      <h3>{t('plan.proposal')}</h3>
      <ol>{task.proposal.steps.map((step, index) => <li key={step}>
        <p>{step}</p><button type="button" disabled={!writable || busy} onClick={() => mutate('task-plan', {
          type: 'accept_plan_step', taskId: task.id, cursor: task.proposal!.cursor, index,
        })}>{t('plan.acceptStep')}</button>
      </li>)}</ol>
    </div>}
    <form className="dshpa-form" onSubmit={event => {
      event.preventDefault()
      if (canEdit) mutate('task-plan', { type: 'set_prerequisites', taskId: task.id, expectedVersion: task.version, prerequisiteIds: chosen })
    }}>
      <fieldset disabled={!canEdit || busy}>
        <legend>{t('plan.prerequisites')}</legend>
        {[...ids].map(id => <label key={id}><span><input type="checkbox" checked={chosen.includes(id)}
          disabled={!chosen.includes(id) && chosen.length >= 16}
          onChange={event => setChosen(event.currentTarget.checked ? [...chosen, id] : chosen.filter(item => item !== id))} />
          {' '}{candidates.find(item => item.id === id)?.outcome ?? id}</span></label>)}
        <button type="submit">{t('plan.savePrerequisites')}</button>
      </fieldset>
    </form>
  </details>
}
