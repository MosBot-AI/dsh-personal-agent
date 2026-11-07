import type { FormEvent, RefObject } from 'react'
import type { InboxApproval, InboxArtifact, InboxProject, InboxRequest, InboxTask } from '../inbox/protocol.js'
import { formatTime, type Translate } from './copy.js'

export function requestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function TaskStatus({ task, t }: { task: InboxTask; t: Translate }) {
  return <span className="dshpa-status" data-state={task.status}>{t(`task.status.${task.status}`)}</span>
}

interface ApprovalProps {
  readonly approval: InboxApproval
  readonly task?: InboxTask
  readonly disabled: boolean
  readonly t: Translate
  readonly submit: (request: InboxRequest) => void
  readonly viewTask: (id: string) => void
}

export function ApprovalCard({ approval, task, disabled, t, submit, viewTask }: ApprovalProps) {
  const expired = Date.parse(approval.expiresAt) <= Date.now()
  const decide = (decision: 'approve' | 'deny') => submit({
    type: 'approval',
    requestId: approval.id,
    expectedVersion: approval.version,
    digest: approval.digest,
    decision,
  })
  return <article className="dshpa-card dshpa-attention">
    <h3>{t('today.approval')}</h3>
    {task && <p className="dshpa-summary">{task.outcome}</p>}
    <dl className="dshpa-fields">
      <dt>{t('approval.kind')}</dt><dd>{approval.kind}</dd>
      <dt>{t('approval.account')}</dt><dd>{approval.accountId}</dd>
      <dt>{t('approval.resource')}</dt><dd>{approval.resourceRef}</dd>
      {approval.recipient && <><dt>{t('approval.recipient')}</dt><dd>{approval.recipient}</dd></>}
      {approval.dataScope.length > 0 && <><dt>{t('approval.dataScope')}</dt><dd>{approval.dataScope.join(', ')}</dd></>}
      <dt>{t('approval.digest')}</dt><dd><code>{approval.digest}</code></dd>
      <dt>{t('approval.expires')}</dt><dd><time dateTime={approval.expiresAt}>{formatTime(approval.expiresAt, t)}</time></dd>
    </dl>
    <details className="dshpa-preview" open>
      <summary>{t('approval.preview')}</summary>
      <pre>{approval.preview}</pre>
    </details>
    <div className="dshpa-actions">
      <button type="button" className="dshpa-primary" disabled={disabled || expired} onClick={() => decide('approve')}>
        {t('action.approve')}
      </button>
      <button type="button" disabled={disabled || expired} onClick={() => decide('deny')}>{t('action.deny')}</button>
      {task && <button type="button" onClick={() => viewTask(task.id)}>{t('today.showTask')}</button>}
    </div>
  </article>
}

const terminal = new Set<InboxTask['status']>(['completed', 'cancelled', 'failed', 'cancelling', 'reconciliation_required'])

export interface TaskDetailProps {
  readonly task: InboxTask
  readonly project?: InboxProject
  readonly workerConfigured: boolean
  readonly canOpenSession: boolean
  readonly writable: boolean
  readonly busy: boolean
  readonly redirectDraft: string
  readonly answerDraft: string
  readonly headingRef: RefObject<HTMLHeadingElement>
  readonly t: Translate
  readonly onRedirectDraft: (text: string) => void
  readonly onAnswerDraft: (text: string) => void
  readonly submit: (request: InboxRequest) => void
  readonly openSession: (id: string) => void
  readonly download: (taskId: string, artifact: InboxArtifact) => void
  readonly isDownloading: (artifactId: string) => boolean
}

export function TaskDetail(props: TaskDetailProps) {
  const { task, project, t } = props
  const control = { taskId: task.id, expectedVersion: task.version }
  const disabled = !props.writable || props.busy
  const stopped = terminal.has(task.status)
  const wait = task.wait
  const asking = task.status === 'waiting_input' && wait?.reason === 'input'

  function redirect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !props.redirectDraft.trim()) return
    props.submit({ type: 'redirect', ...control, cursor: requestId(), text: props.redirectDraft })
  }

  function answer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !wait || !props.answerDraft.trim()) return
    props.submit({
      type: 'answer', ...control, referenceId: wait.referenceId, cursor: requestId(), text: props.answerDraft,
    })
  }

  return <section className="dshpa-detail" aria-labelledby="dshpa-task-heading">
    <div className="dshpa-detail-head">
      <div>
        <p className="dshpa-kicker">{project?.title ?? t('detail.heading')}</p>
        <h2 ref={props.headingRef} id="dshpa-task-heading" tabIndex={-1}>{task.outcome}</h2>
      </div>
      <TaskStatus task={task} t={t} />
    </div>
    <p className="dshpa-muted" role="status">
      {t(task.runtime === 'active' ? 'detail.runtimeActive'
        : task.runtime === 'inactive' ? 'detail.runtimeInactive' : 'detail.runtimeUnknown')}
    </p>
    {wait && <aside className="dshpa-card dshpa-attention">
      <h3>{asking ? t('detail.pendingInput') : t(`task.status.${task.status}`)}</h3>
      <p>{wait.prompt}</p>
      {asking && <form className="dshpa-form" onSubmit={answer}>
        <label>{t('form.answer')}
          <textarea required rows={3} maxLength={4000} value={props.answerDraft}
            onChange={event => props.onAnswerDraft(event.currentTarget.value)} />
        </label>
        <button className="dshpa-primary" disabled={disabled || !props.answerDraft.trim()}>{t('action.answer')}</button>
      </form>}
    </aside>}
    <div className="dshpa-actions dshpa-controls">
      {task.sessionId && <button type="button" disabled={!props.canOpenSession} onClick={() => {
        if (task.sessionId) props.openSession(task.sessionId)
      }}>{t('action.openConversation')}</button>}
      {task.status === 'queued' && <button type="button" className="dshpa-primary"
        disabled={disabled || !props.workerConfigured || task.runtime !== 'inactive'}
        onClick={() => props.submit({ type: 'start', ...control, cursor: requestId() })}>{t('action.start')}</button>}
      {!stopped && task.status !== 'paused' && <button type="button" disabled={disabled}
        onClick={() => props.submit({ type: 'pause', ...control, commandId: requestId() })}>{t('action.pause')}</button>}
      {task.status === 'paused' && <button type="button" className="dshpa-primary" disabled={disabled || task.runtime !== 'inactive'}
        onClick={() => props.submit({ type: 'resume', ...control, commandId: requestId() })}>{t('action.resume')}</button>}
      {!stopped && <button type="button" className="dshpa-danger" disabled={disabled}
        onClick={() => props.submit({ type: 'cancel', ...control, commandId: requestId() })}>{t('action.cancel')}</button>}
    </div>
    {task.status === 'queued' && !props.workerConfigured && <p className="dshpa-muted">{t('detail.noWorker')}</p>}
    {task.status === 'running' && <p className="dshpa-muted">{t('detail.controlNotice')}</p>}
    {task.status === 'running' && task.runtime === 'active' && <form className="dshpa-form dshpa-card" onSubmit={redirect}>
      <label>{t('form.redirect')}
        <textarea required rows={3} maxLength={4000} value={props.redirectDraft}
          onChange={event => props.onRedirectDraft(event.currentTarget.value)} />
      </label>
      <button disabled={disabled || !props.redirectDraft.trim()}>{t('action.redirect')}</button>
    </form>}
    {(task.verifiedAt || task.artifacts.length > 0) && <section className="dshpa-card"
      aria-label={t(task.verifiedAt ? 'detail.verified' : 'detail.candidate')}>
      <h3>{t(task.verifiedAt ? 'detail.verified' : 'detail.candidate')}</h3>
      {task.verifiedAt && <p className="dshpa-muted">{t('detail.verifiedAt')} <time dateTime={task.verifiedAt}>{formatTime(task.verifiedAt, t)}</time></p>}
      {task.canAccept && <p className="dshpa-muted">{t('detail.reviewCandidate')}</p>}
      {task.artifacts.length > 0 && <>
        <h4>{t('detail.artifacts')}</h4>
        <ul className="dshpa-artifacts">{task.artifacts.map(artifact => <li key={artifact.id}>
          <div><strong>{artifact.id}</strong><small>{artifact.mediaType} · {t('detail.version')} {artifact.version}</small></div>
          <button type="button" disabled={!props.writable || props.isDownloading(artifact.id)}
            aria-label={`${t('action.download')} ${artifact.id}`}
            onClick={() => props.download(task.id, artifact)}>{t('action.download')}</button>
        </li>)}</ul>
      </>}
      {task.deliveries.length > 0 && <>
        <h4>{t('detail.deliveries')}</h4>
        <ul className="dshpa-deliveries">{task.deliveries.map(delivery => <li key={delivery.id}>
          <span className="dshpa-status" data-state={delivery.status}>{t(`delivery.status.${delivery.status}`)}</span>
        </li>)}</ul>
      </>}
      {task.canAccept && <button type="button" className="dshpa-primary" disabled={disabled}
        onClick={() => props.submit({ type: 'accept_result', ...control })}>{t('action.acceptResult')}</button>}
    </section>}
  </section>
}
