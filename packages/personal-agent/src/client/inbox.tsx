import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { InboxArtifact, InboxPort, InboxRequest, InboxResponse, InboxSnapshot, InboxTask } from '../inbox/protocol.js'
import type { MessageKey, Translate } from './copy.js'
import { ApprovalCard, requestId, TaskDetail, TaskStatus } from './task.js'
import { Usage } from './usage.js'
import { Reminders, Routines } from './routines.js'
import { PersonalMemory } from './memory.js'
import { LocalKnowledge } from './knowledge.js'
import { GitHubRead } from './github-read.js'
import { Suggestions } from './suggestions.js'
import { Projects, TaskPlanning } from './projects.js'

type Updated = Extract<InboxResponse, { kind: 'updated' }>
type ArtifactContent = Extract<InboxResponse, { kind: 'artifact' }>['artifact']
export type ConnectionSnapshot = `${'connected' | 'connecting' | 'disconnected'}:${number}`

export interface InboxConnection {
  getSnapshot(): ConnectionSnapshot
  subscribe(listener: () => void): () => void
}

export interface InboxMemory {
  form?: 'project' | 'task'
  taskId?: string
  project: { title: string; purpose: string }
  task: { projectId: string; sessionId: string; outcome: string }
  readonly redirect: Map<string, string>
  readonly answer: Map<string, string>
  readonly requests: Map<string, { signature: string; id: string }>
  notice?: MessageKey
}

export function createInboxMemory(): InboxMemory {
  return {
    project: { title: '', purpose: '' },
    task: { projectId: '', sessionId: '', outcome: '' },
    redirect: new Map(),
    answer: new Map(),
    requests: new Map(),
  }
}

interface InboxProps {
  readonly t: Translate
  readonly port: InboxPort
  readonly connection: InboxConnection
  readonly openSession: (id: string, signal: AbortSignal) => Promise<boolean>
  readonly memory?: InboxMemory
  readonly saveArtifact?: (artifact: ArtifactContent) => void
}

const refreshIntervalMs = 3_000
const initialConnection = () => 'connecting:0' as const

function noticeFor(code: string): MessageKey {
  switch (code) {
    case 'permission_denied': return 'notice.denied'
    case 'not_found': return 'notice.notFound'
    case 'version_conflict':
    case 'stale_attempt':
    case 'action_changed': return 'notice.conflict'
    case 'capacity': return 'notice.capacity'
    case 'budget_exceeded':
    case 'context_budget_exceeded':
    case 'context_budget_unavailable':
    case 'invalid_context_budget':
    case 'price_unknown':
    case 'pricing_unavailable': return 'notice.budget'
    case 'condition_unmet': return 'notice.waitCondition'
    case 'recovery_required': return 'notice.recovery'
    case 'outcome_uncertain':
    case 'host_unavailable': return 'notice.unknown'
    default: return 'notice.failed'
  }
}

/** Preserve an exact submission identity if the acknowledgment is lost. */
function retainRequest(memory: InboxMemory, key: string, request: InboxRequest): InboxRequest {
  if ('commandId' in request) {
    const signature = JSON.stringify({ ...request, commandId: undefined })
    const prior = memory.requests.get(key)
    const id = prior?.signature === signature ? prior.id : request.commandId
    memory.requests.set(key, { signature, id })
    return { ...request, commandId: id }
  }
  if (request.type === 'start' || request.type === 'redirect' || request.type === 'answer') {
    const signature = JSON.stringify({ ...request, cursor: undefined, expectedVersion: undefined })
    const prior = memory.requests.get(key)
    const id = prior?.signature === signature ? prior.id : request.cursor
    memory.requests.set(key, { signature, id })
    return { ...request, cursor: id }
  }
  return request
}

function downloadArtifact(artifact: ArtifactContent): void {
  const extension = artifact.mediaType === 'application/json' ? 'json'
    : artifact.mediaType === 'text/markdown' ? 'md' : 'txt'
  const name = artifact.id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'artifact'
  const url = URL.createObjectURL(new Blob([artifact.text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${name}-v${artifact.version}.${extension}`
  link.hidden = true
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

interface CreateProps {
  readonly memory: InboxMemory
  readonly snapshot?: InboxSnapshot
  readonly t: Translate
  readonly writable: boolean
  readonly busy: boolean
  readonly changed: () => void
  readonly createProject: (event: FormEvent<HTMLFormElement>) => void
  readonly createTask: (event: FormEvent<HTMLFormElement>) => void
}

function CreateForm({ memory, snapshot, t, writable, busy, changed, createProject, createTask }: CreateProps) {
  const label = useId()
  if (memory.form === undefined) return null
  const disabled = !writable || busy
  if (memory.form === 'project') return <form className="dshpa-form dshpa-card" aria-labelledby={label} onSubmit={createProject}>
    <h3 id={label}>{t('action.newProject')}</h3>
    <label>{t('form.projectTitle')}
      <input required maxLength={160} value={memory.project.title} onChange={event => {
        memory.project.title = event.currentTarget.value
        changed()
      }} />
    </label>
    <label>{t('form.projectPurpose')}
      <textarea required rows={2} maxLength={4000} value={memory.project.purpose} onChange={event => {
        memory.project.purpose = event.currentTarget.value
        changed()
      }} />
    </label>
    <button className="dshpa-primary" disabled={disabled || !memory.project.title.trim() || !memory.project.purpose.trim()}>
      {t('form.createProject')}
    </button>
  </form>
  const projects = snapshot?.projects ?? []
  const sessions = snapshot?.sessions ?? []
  const projectAvailable = projects.some(project => project.id === memory.task.projectId)
  const sessionAvailable = sessions.some(session => session.id === memory.task.sessionId)
  return <form className="dshpa-form dshpa-card" aria-labelledby={label} onSubmit={createTask}>
    <h3 id={label}>{t('action.newTask')}</h3>
    <label>{t('form.project')}
      <select required value={projectAvailable ? memory.task.projectId : ''} onChange={event => {
        memory.task.projectId = event.currentTarget.value
        changed()
      }}>
        <option value="">{t('form.chooseProject')}</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>
    </label>
    <label>{t('form.conversation')}
      <select required value={sessionAvailable ? memory.task.sessionId : ''} onChange={event => {
        memory.task.sessionId = event.currentTarget.value
        changed()
      }}>
        <option value="">{t('form.chooseConversation')}</option>
        {sessions.map(session => <option key={session.id} value={session.id}>{session.label}</option>)}
      </select>
    </label>
    {!projects.length && <p className="dshpa-muted">{t('form.noProject')}</p>}
    {!sessions.length && <p className="dshpa-muted">{t('form.noConversation')}</p>}
    <label>{t('form.taskOutcome')}
      <textarea required rows={3} maxLength={4000} value={memory.task.outcome} onChange={event => {
        memory.task.outcome = event.currentTarget.value
        changed()
      }} />
    </label>
    <button className="dshpa-primary" disabled={disabled || !projectAvailable || !sessionAvailable || !memory.task.outcome.trim()}>
      {t('form.createTask')}
    </button>
  </form>
}

function TaskRow({ task, selected, t, choose }: { task: InboxTask; selected: boolean; t: Translate; choose: () => void }) {
  return <li><button type="button" className="dshpa-task-row" aria-current={selected ? 'true' : undefined} onClick={choose}>
    <span>{task.outcome}</span><TaskStatus task={task} t={t} />
  </button></li>
}

export function Inbox({ t, port, connection, openSession, memory: suppliedMemory, saveArtifact = downloadArtifact }: InboxProps) {
  const [memory] = useState(() => suppliedMemory ?? createInboxMemory())
  const [, render] = useState(0)
  const changed = () => render(revision => revision + 1)
  const connectionKey = useSyncExternalStore(connection.subscribe, connection.getSnapshot, initialConnection)
  const connected = connectionKey.startsWith('connected:')
  const [snapshot, setSnapshot] = useState<InboxSnapshot>()
  const [loadedKey, setLoadedKey] = useState<ConnectionSnapshot>()
  const [loading, setLoading] = useState(false)
  const previousConnection = useRef(connectionKey)
  const read = useRef<AbortController>()
  const mutations = useRef(new Map<string, AbortController>())
  const navigation = useRef<AbortController>()
  const mounted = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const focusDetail = useRef(false)
  const writable = connected && loadedKey === connectionKey && snapshot !== undefined

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      read.current?.abort()
      read.current = undefined
      navigation.current?.abort()
      for (const [key, controller] of mutations.current) {
        if (!key.startsWith('artifact:')) memory.notice = 'notice.unknown'
        controller.abort()
      }
      mutations.current.clear()
    }
  }, [memory])

  const refresh = useCallback(async (background = false) => {
    const key = connection.getSnapshot()
    if (!key.startsWith('connected:') || !mounted.current || (background && read.current)) return
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    if (!background) setLoading(true)
    try {
      const result = await port({ type: 'snapshot' }, controller.signal)
      if (controller.signal.aborted || !mounted.current || connection.getSnapshot() !== key) return
      if (!result.ok || result.kind !== 'snapshot') throw new Error('Snapshot unavailable')
      setSnapshot(result.snapshot)
      setLoadedKey(key)
    } catch {
      if (!controller.signal.aborted && mounted.current) setLoadedKey(undefined)
    } finally {
      if (read.current === controller) {
        read.current = undefined
        if (mounted.current) setLoading(false)
      }
    }
  }, [connection, port])

  useEffect(() => {
    const changedGeneration = previousConnection.current !== connectionKey
    previousConnection.current = connectionKey
    if (!connected || changedGeneration) {
      read.current?.abort()
      read.current = undefined
      setLoading(false)
      let interrupted = false
      for (const [key, controller] of mutations.current) {
        controller.abort()
        if (!key.startsWith('artifact:')) interrupted = true
      }
      mutations.current.clear()
      if (interrupted) {
        memory.notice = 'notice.unknown'
        render(revision => revision + 1)
      }
    }
    if (!connected) return
    void refresh()
    const timer = setInterval(() => { void refresh(true) }, refreshIntervalMs)
    return () => clearInterval(timer)
  }, [connected, connectionKey, memory, refresh])

  const task = snapshot?.tasks.find(task => task.id === memory.taskId)
  useEffect(() => {
    if (focusDetail.current && task) {
      focusDetail.current = false
      heading.current?.focus()
    }
  }, [task])

  function chooseTask(id: string) {
    memory.taskId = id
    if (task?.id === id) heading.current?.focus()
    else focusDetail.current = true
    changed()
  }

  async function mutate(key: string, raw: InboxRequest, acknowledged?: (result: Updated) => void) {
    if (!writable || connection.getSnapshot() !== connectionKey || mutations.current.has(key)) return
    const identityKey = `${key}:${raw.type}`
    const request = retainRequest(memory, identityKey, raw)
    const controller = new AbortController()
    mutations.current.set(key, controller)
    memory.notice = undefined
    changed()
    try {
      const result = await port(request, controller.signal)
      if (controller.signal.aborted || !mounted.current) return
      if (!result.ok) memory.notice = noticeFor(result.code)
      else {
        if (result.kind !== 'updated') throw new Error('Invalid mutation acknowledgment')
        memory.requests.delete(identityKey)
        memory.notice = 'notice.updated'
        acknowledged?.(result)
      }
    } catch {
      if (!controller.signal.aborted && mounted.current) memory.notice = 'notice.unknown'
    } finally {
      if (mutations.current.get(key) === controller) {
        mutations.current.delete(key)
        if (mounted.current) {
          setLoadedKey(undefined)
          changed()
          void refresh()
        }
      }
    }
  }

  function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const draft = { ...memory.project }
    if (!draft.title.trim() || !draft.purpose.trim()) return
    void mutate('project:create', { type: 'create_project', commandId: requestId(), ...draft }, result => {
      if (memory.project.title === draft.title && memory.project.purpose === draft.purpose) {
        memory.project = { title: '', purpose: '' }
        if (memory.form === 'project') memory.form = undefined
      }
      if (!memory.task.projectId && result.projectId) memory.task.projectId = result.projectId
    })
  }

  function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const draft = { ...memory.task }
    if (!draft.outcome.trim() || !snapshot?.projects.some(project => project.id === draft.projectId)
      || !snapshot.sessions.some(session => session.id === draft.sessionId)) return
    void mutate('task:create', { type: 'create_task', commandId: requestId(), ...draft }, result => {
      if (memory.task.outcome === draft.outcome && memory.task.projectId === draft.projectId && memory.task.sessionId === draft.sessionId) {
        memory.task.outcome = ''
        if (memory.form === 'task') memory.form = undefined
      }
      if (result.taskId) chooseTask(result.taskId)
    })
  }

  function submitTask(request: InboxRequest) {
    if (!('taskId' in request)) return
    void mutate(`task:${request.taskId}`, request, () => {
      if (request.type === 'redirect' && memory.redirect.get(request.taskId) === request.text) memory.redirect.delete(request.taskId)
      if (request.type === 'answer' && memory.answer.get(request.taskId) === request.text) memory.answer.delete(request.taskId)
    })
  }

  async function open(id: string) {
    if (!writable || !snapshot?.sessions.some(session => session.id === id)) return
    navigation.current?.abort()
    const controller = new AbortController()
    navigation.current = controller
    try {
      if (await openSession(id, controller.signal) || controller.signal.aborted) return
    } catch {
      if (controller.signal.aborted) return
    }
    if (!mounted.current) return
    memory.notice = 'notice.sessionUnavailable'
    changed()
  }

  async function download(taskId: string, artifact: InboxArtifact) {
    const key = `artifact:${artifact.id}`
    if (!writable || connection.getSnapshot() !== connectionKey || mutations.current.has(key)) return
    const controller = new AbortController()
    mutations.current.set(key, controller)
    changed()
    try {
      const result = await port({ type: 'artifact', taskId, artifactId: artifact.id }, controller.signal)
      if (controller.signal.aborted || !mounted.current) return
      if (!result.ok || result.kind !== 'artifact' || result.artifact.id !== artifact.id
        || result.artifact.version !== artifact.version || result.artifact.mediaType !== artifact.mediaType
        || typeof result.artifact.text !== 'string') throw new Error('Artifact unavailable')
      saveArtifact(result.artifact)
    } catch {
      if (!controller.signal.aborted && mounted.current) memory.notice = 'notice.downloadFailed'
    } finally {
      if (mutations.current.get(key) === controller) {
        mutations.current.delete(key)
        if (mounted.current) changed()
      }
    }
  }

  const questions = snapshot?.tasks.filter(task => task.status === 'waiting_input' && task.wait?.reason === 'input') ?? []
  const approvals = snapshot?.approvals ?? []
  const attentionIds = new Set([...questions.map(task => task.id), ...approvals.map(approval => approval.taskId)])
  const hasResult = (task: InboxTask) => task.verifiedAt !== undefined || task.artifacts.length > 0
  const results = snapshot?.tasks.filter(hasResult) ?? []
  const routine = snapshot?.tasks.filter(task => !attentionIds.has(task.id) && !hasResult(task)) ?? []
  const taskRows = (items: readonly InboxTask[]) => <ul className="dshpa-task-list">{items.map(item =>
    <TaskRow key={item.id} task={item} selected={task?.id === item.id} t={t} choose={() => chooseTask(item.id)} />
  )}</ul>
  const connectionLabel = writable ? 'connection.ready'
    : connectionKey.startsWith('disconnected:') ? 'connection.disconnected'
      : !connected ? 'connection.connecting' : loading ? 'connection.loading' : 'connection.unknown'

  return <div className="dshpa-inbox" aria-label={t('app.title')}>
    <header className="dshpa-header">
      <div>
        <p className="dshpa-kicker">{t('app.eyebrow')}</p>
        <h1>{t('app.title')}</h1>
        <p className="dshpa-muted">{t('app.subtitle')}</p>
      </div>
      <div className="dshpa-header-actions">
        <span className="dshpa-connection" data-ready={writable} role="status">{t(connectionLabel)}</span>
        <button type="button" onClick={() => { void refresh() }} disabled={!connected || loading}>{t('action.refresh')}</button>
      </div>
    </header>
    {!writable && snapshot && <p className="dshpa-banner">{t('connection.stale')}</p>}
    {snapshot?.recoveryMode && <p className="dshpa-banner" role="status">
      {t(snapshot.recoveryMode === 'restore' ? 'notice.restore' : 'notice.recovery')}
    </p>}
    {memory.notice && <p className="dshpa-banner" role="status">{t(memory.notice)}</p>}
    <div className="dshpa-columns">
      <section className="dshpa-today">
        <section className="dshpa-section" aria-labelledby="dshpa-attention">
          <h2 id="dshpa-attention">{t('today.attention')} <span>{approvals.length + questions.length}</span></h2>
          {approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} t={t}
            task={snapshot?.tasks.find(task => task.id === approval.taskId)}
            disabled={!writable || Boolean(snapshot?.recoveryMode) || mutations.current.has(`approval:${approval.id}`)}
            submit={request => { void mutate(`approval:${approval.id}`, request) }} viewTask={chooseTask} />)}
          {questions.map(question => <article className="dshpa-card dshpa-attention" key={question.id}>
            <h3>{t('today.question')}</h3>
            <p className="dshpa-summary">{question.outcome}</p>
            <p>{question.wait?.prompt}</p>
            <button type="button" onClick={() => chooseTask(question.id)}>{t('today.showTask')}</button>
          </article>)}
          {!approvals.length && !questions.length && <p className="dshpa-muted">{t('today.clear')}</p>}
        </section>
        <section className="dshpa-section" aria-labelledby="dshpa-results">
          <h2 id="dshpa-results">{t('today.results')} <span>{results.length}</span></h2>
          {results.length ? taskRows(results) : <p className="dshpa-muted">{t('today.noResults')}</p>}
        </section>
        {snapshot?.schedules && <Reminders items={snapshot.schedules.reminders} t={t} />}
        {writable && snapshot?.proactiveNotices?.map(notice => <article key={notice.id} className="dshpa-card">
          <h3>{t('suggestions.notice')}</h3><p>{notice.summary}</p>
        </article>)}
        <section className="dshpa-section" aria-labelledby="dshpa-other">
          <h2 id="dshpa-other">{t('today.routine')} <span>{routine.length}</span></h2>
          {routine.length ? taskRows(routine) : <p className="dshpa-muted">{t('today.noTasks')}</p>}
        </section>
      </section>
      <div className="dshpa-work">
        <div className="dshpa-actions dshpa-create-actions">
          {(['project', 'task'] as const).map(form => <button key={form} type="button"
            aria-expanded={memory.form === form} onClick={() => {
              memory.form = memory.form === form ? undefined : form
              changed()
            }}>{t(form === 'project' ? 'action.newProject' : 'action.newTask')}</button>)}
        </div>
        <CreateForm memory={memory} snapshot={snapshot} t={t} writable={writable} changed={changed}
          busy={mutations.current.has(`${memory.form}:create`)} createProject={createProject} createTask={createTask} />
        {snapshot && connected && <Projects key={connectionKey} projects={writable ? snapshot.projects : []}
          tasks={writable ? snapshot.tasks : []} port={port} mutate={(key, request, acknowledge) => { void mutate(key, request, acknowledge) }}
          chooseTask={chooseTask} current={() => connection.getSnapshot() === connectionKey}
          writable={writable && !snapshot.recoveryMode} busy={mutations.current.has('goal-plan')} t={t} />}
        {snapshot?.usage && <Usage usage={snapshot.usage} t={t} />}
        {snapshot?.memoryConfigured && <PersonalMemory t={t} port={port} projects={snapshot.projects} tasks={snapshot.tasks}
          connectionKey={connectionKey} currentConnection={() => connection.getSnapshot()} readable={writable}
          writable={writable && !snapshot.recoveryMode} />}
        {snapshot?.knowledgeConfigured && connected && <LocalKnowledge key={connectionKey} t={t} port={port}
          readable={writable && !snapshot.recoveryMode} current={() => connection.getSnapshot() === connectionKey} />}
        {snapshot?.githubRead && connected && <GitHubRead key={connectionKey} t={t} port={port} projectId={snapshot.githubRead.projectId}
          readable={writable && !snapshot.recoveryMode} current={() => connection.getSnapshot() === connectionKey} />}
        {snapshot?.proactiveConfigured && connected && <Suggestions key={connectionKey} snapshot={snapshot} port={port} t={t}
          current={() => connection.getSnapshot() === connectionKey} writable={writable && !snapshot.recoveryMode}
          refresh={() => { void refresh() }} />}
        {snapshot?.schedules && <Routines routines={snapshot.schedules.routines} tasks={snapshot.tasks} t={t}
          writable={writable && !snapshot.recoveryMode} busy={mutations.current.has('routines')}
          submit={(request, acknowledged) => { void mutate('routines', request, acknowledged) }} />}
        {task && writable && <TaskPlanning key={`${connectionKey}:${task.id}:${task.version}`} task={task} tasks={snapshot?.tasks ?? []}
          writable={!snapshot?.recoveryMode} busy={mutations.current.has('task-plan')}
          mutate={(key, request, acknowledge) => { void mutate(key, request, acknowledge) }} t={t} />}
        {task ? <TaskDetail task={task} project={snapshot?.projects.find(project => project.id === task.projectId)}
          workerConfigured={snapshot?.workerConfigured === true && !snapshot.recoveryMode} t={t} writable={writable}
          canOpenSession={writable && snapshot?.sessions.some(session => session.id === task.sessionId) === true}
          busy={mutations.current.has(`task:${task.id}`)} headingRef={heading}
          redirectDraft={memory.redirect.get(task.id) ?? ''} answerDraft={memory.answer.get(task.id) ?? ''}
          onRedirectDraft={text => { memory.redirect.set(task.id, text); changed() }}
          onAnswerDraft={text => { memory.answer.set(task.id, text); changed() }}
          submit={submitTask} openSession={id => { void open(id) }} download={(id, artifact) => { void download(id, artifact) }}
          isDownloading={id => mutations.current.has(`artifact:${id}`)} />
          : <section className="dshpa-detail dshpa-empty">
            <h2>{t('detail.heading')}</h2><p className="dshpa-muted">{t('detail.noSelection')}</p>
          </section>}
      </div>
    </div>
  </div>
}
