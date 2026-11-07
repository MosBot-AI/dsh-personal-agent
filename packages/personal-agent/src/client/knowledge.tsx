import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { InboxPort, InboxRequest, InboxResponse, KnowledgeRootStatus, KnowledgeSource } from '../inbox/protocol.js'
import type { Translate } from './copy.js'

type Search = Extract<InboxResponse, { kind: 'knowledge_search' }>
type Page = Extract<InboxResponse, { kind: 'knowledge_page' }>
type Request = Extract<InboxRequest, { type: 'knowledge_status' | 'knowledge_search' | 'knowledge_read' }>

export function LocalKnowledge({ t, port, readable, current }: {
  t: Translate; port: InboxPort; readable: boolean; current: () => boolean
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [root, setRoot] = useState('')
  const [roots, setRoots] = useState<readonly KnowledgeRootStatus[]>([])
  const [results, setResults] = useState<Search>()
  const [page, setPage] = useState<Page>()
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'stale' | 'failed'>()
  const active = useRef<AbortController>()

  useEffect(() => {
    if (!readable) {
      setResults(undefined)
      setPage(undefined)
      setRoots([])
      setBusy(false)
    }
    return () => {
      active.current?.abort()
      active.current = undefined
    }
  }, [readable, port])

  async function read(request: Request) {
    if (!readable || !current()) return
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setNotice(undefined)
    setBusy(true)
    setPage(undefined)
    if (request.type !== 'knowledge_read') setResults(undefined)
    try {
      const result = await port(request, controller.signal)
      if (controller.signal.aborted || !current()) return
      if (!result.ok) {
        const stale = result.code === 'stale_source' || result.code === 'source_unavailable'
        setNotice(stale ? 'stale' : 'failed')
        if (stale && request.type === 'knowledge_read') {
          setResults(previous => previous && { ...previous, hits: previous.hits.filter(hit => hit.ref.id !== request.ref.id) })
        }
        return
      }
      if (request.type === 'knowledge_status' && result.kind === 'knowledge_status') setRoots(result.roots)
      else if (request.type === 'knowledge_search' && result.kind === 'knowledge_search') {
        setRoots(result.roots)
        setResults(result)
      } else if (request.type === 'knowledge_read' && result.kind === 'knowledge_page'
        && result.source.ref.id === request.ref.id && result.source.ref.rootId === request.ref.rootId
        && result.source.revision === request.revision) {
        setPage(result)
        setOffset(request.offset ?? 0)
      } else setNotice('failed')
    } catch {
      if (!controller.signal.aborted && current()) setNotice('failed')
    } finally {
      if (active.current === controller && !controller.signal.aborted) setBusy(false)
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (query.trim()) void read({ type: 'knowledge_search', query, ...(root ? { rootId: root } : {}) })
  }

  function open(source: KnowledgeSource, next = 0) {
    void read({ type: 'knowledge_read', ref: source.ref, revision: source.revision, offset: next })
  }

  return <details className="dshpa-card dshpa-section dshpa-knowledge">
    <summary id={id}>{t('knowledge.heading')}</summary>
    <section aria-labelledby={id}>
      <p className="dshpa-muted">{t('knowledge.readOnly')}</p>
      <button type="button" disabled={!readable || busy} onClick={() => { void read({ type: 'knowledge_status' }) }}>{t('knowledge.refresh')}</button>
      {readable && roots.length > 0 && <ul>{roots.map(item => <li key={item.id}>
        {item.id} · {t(`knowledge.status.${item.status}`)} · {item.files}
      </li>)}</ul>}
      <form className="dshpa-form" onSubmit={search}>
        <label>{t('knowledge.root')}<select value={root} disabled={!readable || busy} onChange={event => {
          setRoot(event.currentTarget.value)
          setResults(undefined)
          setPage(undefined)
        }}>
          <option value="">{t('knowledge.allRoots')}</option>
          {roots.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
        </select></label>
        <label>{t('knowledge.query')}<input required maxLength={256} value={query}
          disabled={!readable || busy} onChange={event => setQuery(event.currentTarget.value)} /></label>
        <button type="submit" disabled={!readable || busy || !query.trim()}>{t('knowledge.search')}</button>
      </form>
      {busy && <p role="status">{t('knowledge.loading')}</p>}
      {notice && <p role="status">{t(`knowledge.notice.${notice}`)}</p>}
      {readable && results && (results.hits.length === 0 ? <p>{t('knowledge.empty')}</p> : <ul>
        {results.hits.map(hit => <li key={hit.ref.id}>
          <button type="button" disabled={busy} onClick={() => open(hit)}>{hit.ref.rootId} / {hit.path}</button>
          <p>{hit.snippet}</p>
        </li>)}
      </ul>)}
      {readable && page && <article className="dshpa-detail">
        <h3>{page.source.ref.rootId} / {page.source.path}</h3>
        <p>{t('knowledge.reference')} <code>{page.source.ref.rootId}/{page.source.ref.id}@{page.source.revision}</code></p>
        <p className="dshpa-muted">{t('knowledge.offset')} {offset} / {page.totalBytes}</p>
        <pre className="dshpa-summary">{page.text}</pre>
        {offset > 0 && <button type="button" disabled={busy} onClick={() => open(page.source)}>{t('knowledge.first')}</button>}
        {page.nextOffset !== undefined && <button type="button" disabled={busy}
          onClick={() => open(page.source, page.nextOffset)}>{t('knowledge.next')}</button>}
      </article>}
    </section>
  </details>
}
