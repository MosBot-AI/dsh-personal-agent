import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { InboxPort, InboxRequest, InboxResponse } from '../inbox/protocol.js'
import { formatTime, type MessageKey, type Translate } from './copy.js'

type Request = Extract<InboxRequest, { type: 'connector_read' | 'connector_status' }>
type Read = Extract<Request, { type: 'connector_read' }>['read']
type Page = Extract<InboxResponse, { kind: 'connector_page' }>
type Binding = Page['binding']

function notice(code: string): MessageKey {
  switch (code) {
    case 'credential_unavailable': return 'github.noCredential'
    case 'permission_denied': return 'github.denied'
    case 'capability_changed': return 'github.changed'
    case 'rate_limited': return 'github.rateLimited'
    default: return 'github.failed'
  }
}

export function GitHubRead({ t, port, projectId, readable, current }: {
  t: Translate; port: InboxPort; projectId?: string; readable: boolean; current: () => boolean
}) {
  const id = useId()
  const [issue, setIssue] = useState('')
  const [binding, setBinding] = useState<Binding>()
  const [page, setPage] = useState<{ response: Page; read: Read }>()
  const [error, setError] = useState<{ label: MessageKey; retryAt?: string }>()
  const [busy, setBusy] = useState(false)
  const active = useRef<AbortController>()
  useEffect(() => {
    setBinding(undefined)
    setPage(undefined)
    setError(undefined)
    setBusy(false)
    return () => { active.current?.abort(); active.current = undefined }
  }, [readable, port, projectId])

  async function send(request: Request) {
    if (!readable || !current()) return
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setPage(undefined)
    setError(undefined)
    try {
      const result = await port(request, controller.signal)
      if (controller.signal.aborted || !current()) return
      if (!result.ok) {
        setBinding(undefined)
        setError({ label: notice(result.code), retryAt: result.retryAt })
      } else if (request.type === 'connector_status' && result.kind === 'connector_status') {
        setBinding(result.binding)
      } else if (request.type === 'connector_read' && result.kind === 'connector_page') {
        setBinding(result.binding)
        setPage({ response: result, read: request.read })
      } else setError({ label: 'github.failed' })
    } catch {
      if (!controller.signal.aborted && current()) setError({ label: 'github.failed' })
    } finally {
      if (active.current === controller && !controller.signal.aborted) setBusy(false)
    }
  }

  const scope = projectId === undefined ? {} : { projectId }
  function read(request: Read) { void send({ type: 'connector_read', ...scope, read: request }) }
  function comments(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const number = Number(issue)
    if (/^[1-9]\d*$/u.test(issue) && Number.isSafeInteger(number)) read({ operation: 'comments', issue: number })
  }

  return <details className="dshpa-card dshpa-section dshpa-knowledge">
    <summary id={id}>{t('github.heading')}</summary>
    <section aria-labelledby={id}>
      <p className="dshpa-muted">{t('github.readOnly')}</p>
      <div className="dshpa-actions">
        <button type="button" disabled={!readable || busy} onClick={() => { void send({ type: 'connector_status', ...scope }) }}>
          {t('github.verify')}</button>
        <button type="button" disabled={!readable || busy} onClick={() => read({ operation: 'issues' })}>{t('github.issues')}</button>
      </div>
      <form className="dshpa-form" onSubmit={comments}>
        <label>{t('github.issue')}<input type="number" required min={1} step={1} value={issue}
          disabled={!readable || busy} onChange={event => setIssue(event.currentTarget.value)} /></label>
        <button type="submit" disabled={!readable || busy}>{t('github.comments')}</button>
      </form>
      {busy && <p role="status">{t('github.loading')}</p>}
      {readable && binding && <p>{binding.repository.owner}/{binding.repository.name} · {binding.account.login}</p>}
      {error && <p role="status">{t(error.label)} {error.retryAt && formatTime(error.retryAt, t)}</p>}
      {readable && page && (page.response.items.length === 0 ? <p>{t('github.empty')}</p> : <ul>
        {page.response.items.map(item => <li key={item.id}>
          <a href={item.url} target="_blank" rel="noreferrer noopener">#{item.number} {item.title ?? t('github.comment')}</a>
          <p className="dshpa-muted">{item.author} · {formatTime(item.updatedAt, t)}</p>
          <pre>{item.text}</pre>
        </li>)}
      </ul>)}
      {readable && page?.response.nextCursor && <button type="button" disabled={busy}
        onClick={() => read({ ...page.read, cursor: page.response.nextCursor })}>{t('github.next')}</button>}
    </section>
  </details>
}
