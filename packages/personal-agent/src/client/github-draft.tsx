import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { InboxPort, InboxRequest, InboxResponse, InboxTask } from '../inbox/protocol.js'
import type { Translate } from './copy.js'
import { requestId } from './task.js'

type Draft = NonNullable<Extract<InboxResponse, { kind: 'github_draft' }>['draft']>
type Request = Extract<InboxRequest, { type: 'github_draft_prepare' | 'github_draft_inspect' | 'github_draft_dispatch' }>
  | Extract<InboxRequest, { type: 'github_draft_reconcile' | 'github_draft_revoke' }>

export function GitHubDraft({ task, port, t, readable, writable, current, refresh }: {
  task: InboxTask; port: InboxPort; t: Translate; readable: boolean; writable: boolean; current: () => boolean
  refresh: () => void
}) {
  const id = useId()
  const [draft, setDraft] = useState<Draft>()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const active = useRef<AbortController>()
  const prepareCommand = useRef<{ signature: string; id: string }>()
  useEffect(() => {
    if (!readable) { setDraft(undefined); setError(undefined); setBusy(false) }
    return () => { active.current?.abort(); active.current = undefined }
  }, [readable, port])

  async function submit(request: Request) {
    if (!readable || !current() || active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError(undefined)
    try {
      const result = await port(request, controller.signal)
      if (controller.signal.aborted || !current()) return
      if (!result.ok) setError(result.code)
      else if (result.kind === 'github_draft') {
        setDraft(result.draft ?? undefined)
        if (request.type !== 'github_draft_inspect') refresh()
      } else setError('invalid_result')
    } catch {
      if (!controller.signal.aborted && current()) setError('host_unavailable')
    } finally {
      if (active.current === controller) {
        active.current = undefined
        setBusy(false)
      }
    }
  }

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!writable || !title.trim() || !body.trim() || !content.trim()) return
    const input = { title: title.trim(), body, content }
    const signature = JSON.stringify(input)
    if (prepareCommand.current?.signature !== signature) prepareCommand.current = { signature, id: requestId() }
    void submit({ type: 'github_draft_prepare', taskId: task.id, expectedVersion: task.version,
      commandId: prepareCommand.current.id, draft: input })
  }

  const operationId = draft?.payload.operationId
  const canPrepare = writable && task.status === 'queued' && !draft
  return <details className="dshpa-card dshpa-section dshpa-knowledge">
    <summary id={id}>{t('draft.heading')}</summary>
    <section aria-labelledby={id}>
      <p>{t('draft.testOnly')}</p>
      <button type="button" disabled={!readable || busy} onClick={() => { void submit({ type: 'github_draft_inspect', taskId: task.id }) }}>
        {t('draft.status')}</button>
      {canPrepare && <form className="dshpa-form" onSubmit={prepare}>
        <label>{t('draft.title')}<input required maxLength={200} value={title} disabled={busy}
          onChange={event => setTitle(event.currentTarget.value)} /></label>
        <label>{t('draft.body')}<textarea required maxLength={4096} value={body} disabled={busy}
          onChange={event => setBody(event.currentTarget.value)} /></label>
        <label>{t('draft.content')}<textarea required maxLength={8192} value={content} disabled={busy}
          onChange={event => setContent(event.currentTarget.value)} /></label>
        <button type="submit" disabled={busy}>{t('draft.prepare')}</button>
      </form>}
      {busy && <p role="status">{t('draft.loading')}</p>}
      {error && <p role="status">{t('draft.failed')} <code>{error}</code></p>}
      {readable && draft && operationId && <div>
        <p>{t('draft.review')} · <code>{draft.approval}</code> · <code>{draft.effect}</code></p>
        <p><code>{draft.digest}</code></p>
        <pre>{JSON.stringify(draft.payload, null, 2)}</pre>
        {draft.receipt && <p>{t('draft.receipt')} <code>{draft.receipt}</code></p>}
        {draft.revoked && <p>{t('draft.revoked')}</p>}
        <div className="dshpa-actions">
          {draft.approval === 'approved' && draft.effect === 'authorized' && !draft.revoked && <>
            <button type="button" disabled={!writable || busy || task.status !== 'running'} onClick={() => { void submit({
              type: 'github_draft_dispatch', taskId: task.id, operationId, expectedVersion: task.version,
            }) }}>{t('draft.dispatch')}</button>
            <button type="button" disabled={!writable || busy} onClick={() => { void submit({
              type: 'github_draft_revoke', taskId: task.id, operationId,
            }) }}>{t('draft.revoke')}</button>
          </>}
          {(draft.effect === 'dispatching' || draft.effect === 'uncertain' || draft.effect === 'manual_reconciliation') && <>
            <button type="button" disabled={busy} onClick={() => { void submit({
              type: 'github_draft_reconcile', taskId: task.id, operationId,
            }) }}>{t('draft.lookup')}</button>
            {!draft.revoked && <button type="button" disabled={!writable || busy} onClick={() => { void submit({
              type: 'github_draft_revoke', taskId: task.id, operationId,
            }) }}>{t('draft.revoke')}</button>}
          </>}
        </div>
      </div>}
    </section>
  </details>
}
