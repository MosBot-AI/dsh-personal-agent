import type { MemoryActiveRecord, MemoryScope } from '@mosbot-ai/dshpa-plugin-api'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { InboxPort, InboxProject, InboxRequest, InboxResponse, InboxTask } from '../inbox/protocol.js'
import { formatTime, type MessageKey, type Translate } from './copy.js'
import { requestId } from './task.js'

type Records = Extract<InboxResponse, { kind: 'memory_records' }>
type ReadRequest = Extract<InboxRequest, { type: 'memory_search' | 'memory_inspect' }>
type ChangeRequest = Extract<InboxRequest, { type: 'memory_remember' | 'memory_correct' | 'memory_forget' }>
type Draft = { text: string; expires: string }
type RecordFence = { recordId: string; expectedRevision: number }
type Editor = ({ kind: 'remember' } & Draft) | ({ kind: 'correct' } & Draft & RecordFence) | ({ kind: 'forget' } & RecordFence)

interface MemoryProps {
  readonly t: Translate
  readonly port: InboxPort
  readonly projects: readonly InboxProject[]
  readonly tasks: readonly InboxTask[]
  readonly connectionKey: string
  readonly currentConnection: () => string
  readonly readable: boolean
  readonly writable: boolean
}

const profileScope = { kind: 'profile' } as const
const maxText = 16_384
const maxQuery = 4_096

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  switch (left.kind) {
    case 'profile': return right.kind === 'profile'
    case 'project': return right.kind === 'project' && left.projectId === right.projectId
    case 'task': return right.kind === 'task' && left.taskId === right.taskId
  }
}

function scopeChoice(kind: string): MemoryScope {
  if (kind === 'project') return { kind: 'project', projectId: '' }
  if (kind === 'task') return { kind: 'task', taskId: '' }
  return profileScope
}

function resultMatches(request: ReadRequest, response: Records): boolean {
  const records = [...response.confirmed, ...response.inferred]
  return records.every(record => sameScope(record.scope, request.scope))
    && response.confirmed.every(record => record.origin === 'explicit') && response.inferred.every(record => record.origin === 'inferred')
    && (request.type !== 'memory_inspect' || (records.length <= 1 && records.every(record => record.id === request.recordId)))
}

function errorNotice(code: string): MessageKey {
  switch (code) {
    case 'permission_denied': return 'notice.denied'
    case 'not_found': return 'notice.notFound'
    case 'version_conflict':
    case 'conflict': return 'memory.conflict'
    case 'provider_unavailable':
    case 'resource_unavailable': return 'memory.providerUnavailable'
    case 'recovery_required': return 'notice.recovery'
    default: return 'memory.failed'
  }
}

function recordFence(record: MemoryActiveRecord): RecordFence {
  return { recordId: record.id, expectedRevision: record.revision }
}

function pendingEditor(request: ChangeRequest): Editor {
  if (request.type === 'memory_forget') {
    return { kind: 'forget', recordId: request.recordId, expectedRevision: request.expectedRevision }
  }
  const draft = { text: request.text, expires: request.validUntil?.slice(0, -1) ?? '' }
  return request.type === 'memory_correct'
    ? { kind: 'correct', ...draft, recordId: request.recordId, expectedRevision: request.expectedRevision }
    : { kind: 'remember', ...draft }
}

function MemoryRecord({ record, t, busy, editable, inspect, edit }: {
  readonly record: MemoryActiveRecord
  readonly t: Translate
  readonly busy: boolean
  readonly editable: boolean
  inspect(): void
  edit(value: Editor): void
}) {
  const contentId = useId()
  const confidence = new Intl.NumberFormat(t('locale'), { style: 'percent', maximumFractionDigits: 1 }).format(record.confidence)
  return <li>
    <p id={contentId} style={{ whiteSpace: 'pre-wrap' }}>
      {record.value.kind === 'fact' ? record.value.text : <code>{record.value.ref}</code>}
    </p>
    <dl className="dshpa-fields">
      <dt>{t('memory.revision')}</dt><dd>{record.revision}</dd>
      <dt>{t('memory.confidence')}</dt><dd>{confidence}</dd>
      <dt>{t('memory.validFrom')}</dt><dd><time dateTime={record.validFrom}>{formatTime(record.validFrom, t)}</time></dd>
      <dt>{t('memory.validUntil')}</dt><dd>{record.validUntil === undefined ? t('memory.noExpiry')
        : <time dateTime={record.validUntil}>{formatTime(record.validUntil, t)}</time>}</dd>
      <dt>{t('memory.sources')}</dt><dd>{record.sourceEventIds.map(source => <div key={source}><code>{source}</code></div>)}</dd>
    </dl>
    <div className="dshpa-actions">
      <button type="button" aria-describedby={contentId} disabled={busy} onClick={inspect}>{t('memory.inspect')}</button>
      <button type="button" aria-describedby={contentId} disabled={busy || !editable} onClick={() => edit({
        kind: 'correct', ...recordFence(record), text: record.value.kind === 'fact' ? record.value.text : '',
        expires: record.validUntil?.slice(0, -1) ?? '',
      })}>{t('memory.correct')}</button>
      <button type="button" className="dshpa-danger" aria-describedby={contentId} disabled={busy || !editable}
        onClick={() => edit({ kind: 'forget', ...recordFence(record) })}>{t('memory.forget')}</button>
    </div>
  </li>
}

export function PersonalMemory({ t, port, projects, tasks, connectionKey, currentConnection, readable, writable }: MemoryProps) {
  const [selection, setSelection] = useState<MemoryScope>(profileScope)
  const [query, setQuery] = useState('')
  const [records, setRecords] = useState<{ key: string; response: Records }>()
  const [edit, setEdit] = useState<{ key: string; draft: Editor }>()
  const [busyKey, setBusyKey] = useState<string>()
  const [notice, setNotice] = useState<MessageKey>()
  const [pending, setPending] = useState<ReadonlyMap<string, ChangeRequest>>(() => new Map())
  const operation = useRef<AbortController>()
  const retry = useRef<{ signature: string; id: string }>()
  const scope = (selection.kind === 'project' && !projects.some(project => project.id === selection.projectId))
    || (selection.kind === 'task' && !tasks.some(task => task.id === selection.taskId)) ? undefined : selection
  const key = JSON.stringify([connectionKey, scope])
  const enabled = readable && scope !== undefined
  const editable = writable && enabled
  const busy = busyKey === key
  const view = enabled && records?.key === key ? records.response : undefined
  const retryPending = enabled ? pending.get(key) : undefined
  const draft = editable ? edit?.key === key ? edit.draft : retryPending && pendingEditor(retryPending) : undefined
  const canEdit = editable && !retryPending
  const editHeading = useId()

  useEffect(() => {
    retry.current = undefined
    setRecords(undefined)
    setEdit(undefined)
    setBusyKey(undefined)
    setNotice(undefined)
    return () => {
      operation.current?.abort()
      operation.current = undefined
    }
  }, [enabled, key, port])

  useEffect(() => {
    setPending(current => current.size === 0 ? current : new Map())
    setQuery('')
  }, [connectionKey, port])

  function choose(next: MemoryScope) {
    if (sameScope(next, selection)) return
    operation.current?.abort()
    operation.current = undefined
    setSelection(next)
    setQuery('')
  }

  function begin(next: Editor) {
    if (canEdit && !busy) setEdit({ key, draft: next })
  }

  async function perform(raw: ReadRequest | ChangeRequest) {
    const changing = 'commandId' in raw
    if (!scope || !enabled || (changing && !editable) || operation.current || currentConnection() !== connectionKey) return
    if (changing && retryPending && raw.commandId !== retryPending.commandId) return
    let request = raw
    if (changing) {
      const { commandId, ...fields } = raw
      const signature = JSON.stringify(fields)
      const id = retry.current?.signature === signature ? retry.current.id : commandId
      retry.current = { signature, id }
      request = { ...raw, commandId: id }
    } else if (!retryPending) {
      setEdit(undefined)
    }
    const controller = new AbortController()
    const current = () => !controller.signal.aborted && operation.current === controller && currentConnection() === connectionKey
    operation.current = controller
    setBusyKey(key)
    setNotice(undefined)
    setRecords(undefined)
    try {
      const response = await port(request, controller.signal)
      if (!current()) return
      if (!response.ok) {
        setNotice(errorNotice(response.code))
      } else if ('commandId' in request && response.kind === 'memory_change') {
        if (response.state === 'pending') {
          setPending(current => new Map(current).set(key, request))
        } else {
          retry.current = undefined
          setPending(current => {
            const next = new Map(current)
            next.delete(key)
            return next
          })
          setEdit(undefined)
          setNotice('memory.completed')
        }
      } else if (!('commandId' in request) && response.kind === 'memory_records' && resultMatches(request, response)) {
        setRecords({ key, response })
      } else {
        throw new Error('Invalid memory response')
      }
    } catch {
      if (current()) setNotice(changing ? 'memory.unknown' : 'memory.providerUnavailable')
    } finally {
      if (operation.current === controller) {
        operation.current = undefined
        setBusyKey(undefined)
      }
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (scope) void perform({ type: 'memory_search', scope, query: query.trim() })
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft || !scope || retryPending) return
    const commandId = requestId()
    if (draft.kind === 'forget') {
      void perform({ type: 'memory_forget', scope, commandId, recordId: draft.recordId, expectedRevision: draft.expectedRevision })
      return
    }
    const text = draft.text.trim()
    if (!text) return
    const expiry = draft.expires ? new Date(`${draft.expires}Z`) : undefined
    if (expiry && Number.isNaN(expiry.getTime())) {
      setNotice('memory.invalidExpiry')
      return
    }
    const fields = { scope, commandId, text, ...(expiry ? { validUntil: expiry.toISOString() } : {}) }
    void perform(draft.kind === 'remember' ? { type: 'memory_remember', ...fields }
      : { type: 'memory_correct', ...fields, recordId: draft.recordId, expectedRevision: draft.expectedRevision })
  }

  function recordList(heading: MessageKey, items: readonly MemoryActiveRecord[]) {
    if (!scope || items.length === 0) return null
    return <>
      <h3>{t(heading)}</h3>
      <ul>{items.map(record => <MemoryRecord key={record.id} record={record} t={t} busy={busy} editable={canEdit}
        inspect={() => { void perform({ type: 'memory_inspect', scope, recordId: record.id }) }} edit={begin} />)}</ul>
    </>
  }

  return <details className="dshpa-card dshpa-projects dshpa-memory">
    <summary>{t('memory.heading')}</summary>
    <p className="dshpa-muted">{t('memory.backups')}</p>
    <form className="dshpa-form" onSubmit={search}>
      <label>{t('memory.scope')}<select disabled={!readable} value={selection.kind} onChange={event => choose(scopeChoice(event.currentTarget.value))}>
        <option value="profile">{t('memory.profile')}</option>
        <option value="project">{t('memory.project')}</option>
        <option value="task">{t('memory.task')}</option>
      </select></label>
      {selection.kind === 'project' && <label>{t('memory.project')}<select disabled={!readable} value={scope?.kind === 'project' ? scope.projectId : ''}
        onChange={event => choose({ kind: 'project', projectId: event.currentTarget.value })}>
        <option value="">{t('memory.chooseProject')}</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select></label>}
      {selection.kind === 'task' && <label>{t('memory.task')}<select disabled={!readable} value={scope?.kind === 'task' ? scope.taskId : ''}
        onChange={event => choose({ kind: 'task', taskId: event.currentTarget.value })}>
        <option value="">{t('memory.chooseTask')}</option>
        {tasks.map(task => <option key={task.id} value={task.id}>{task.outcome}</option>)}
      </select></label>}
      <label>{t('memory.query')}<input type="search" maxLength={maxQuery} disabled={!enabled} value={query}
        onChange={event => setQuery(event.currentTarget.value)} /></label>
      <div className="dshpa-actions">
        <button disabled={!enabled || busy}>{t(query.trim() ? 'memory.search' : 'memory.recent')}</button>
        <button type="button" disabled={!canEdit || busy} onClick={() => begin({ kind: 'remember', text: '', expires: '' })}>{t('memory.remember')}</button>
      </div>
    </form>
    {notice && readable && <p className="dshpa-muted" role="status">{t(notice)}</p>}
    {busy && <p className="dshpa-muted" role="status">{t('memory.loading')}</p>}
    {retryPending && <div className="dshpa-actions">
      <p className="dshpa-muted" role="status">{t('memory.pending')}</p>
      <button type="button" disabled={!editable || busy} onClick={() => { void perform(retryPending) }}>{t('memory.retry')}</button>
    </div>}
    {draft && <form className="dshpa-form" aria-labelledby={editHeading} onSubmit={save}>
      <h3 id={editHeading}>{t(draft.kind === 'remember' ? 'memory.remember' : draft.kind === 'correct' ? 'memory.correct' : 'memory.forget')}</h3>
      {draft.kind === 'forget' ? <p>{t('memory.forgetPrompt')}</p> : <>
        <label>{t('memory.text')}<textarea required maxLength={maxText} rows={3} disabled={busy || Boolean(retryPending)} value={draft.text}
          onChange={event => setEdit({ key, draft: { ...draft, text: event.currentTarget.value } })} /></label>
        <label>{t('memory.expiryInput')}<input type="datetime-local" step="0.001" disabled={busy || Boolean(retryPending)} value={draft.expires}
          onChange={event => setEdit({ key, draft: { ...draft, expires: event.currentTarget.value } })} /></label>
      </>}
      <div className="dshpa-actions">
        <button className={draft.kind === 'forget' ? 'dshpa-danger' : 'dshpa-primary'}
          disabled={busy || Boolean(retryPending) || (draft.kind !== 'forget' && !draft.text.trim())}>
          {t(draft.kind === 'forget' ? 'memory.confirmForget' : 'memory.save')}
        </button>
        <button type="button" disabled={busy || Boolean(retryPending)} onClick={() => setEdit(undefined)}>{t('memory.close')}</button>
      </div>
    </form>}
    {view && view.confirmed.length + view.inferred.length === 0 && <p className="dshpa-muted">{t('memory.empty')}</p>}
    {view && recordList('memory.confirmed', view.confirmed)}
    {view && recordList('memory.inferred', view.inferred)}
  </details>
}
