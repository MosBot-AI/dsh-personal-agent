import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { ProactiveDraftInput, ProactiveMode } from '../domain/proactive.js'
import type { InboxPort, InboxRequest, InboxResponse, InboxSnapshot } from '../inbox/protocol.js'
import { formatTime, type Translate } from './copy.js'
import { requestId } from './task.js'

type State = Extract<InboxResponse, { kind: 'proactive_state' }>
type Rule = State['rules'][number]
type Request = Extract<InboxRequest, { type: `proactive_${string}` | 'set_attention_policy' }>
const modes: ProactiveMode[] = ['off', 'observe', 'prepare', 'act']
const empty: ProactiveDraftInput = { title: '', projectId: '', taskId: '', sourceInstanceId: '', accountId: '', threadId: '', query: '' }

export function Suggestions({ snapshot, port, t, current, writable, refresh }: {
  snapshot: InboxSnapshot; port: InboxPort; t: Translate; current: () => boolean; writable: boolean; refresh: () => void
}) {
  const id = useId()
  const [state, setState] = useState<State>()
  const [draft, setDraft] = useState<{ id: string; version: number | null; value: ProactiveDraftInput }>()
  const [artifact, setArtifact] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const operation = useRef<AbortController>()
  useEffect(() => {
    if (!writable) { setState(undefined); setDraft(undefined); setArtifact(undefined); setBusy(false); setError(undefined) }
    return () => { operation.current?.abort(); operation.current = undefined }
  }, [writable, port])

  async function send(request: Request) {
    if (!writable || !current() || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError(undefined)
    setArtifact(undefined)
    try {
      const result = await port(request, controller.signal)
      if (controller.signal.aborted || !current()) return
      if (!result.ok) { setError(result.code); return }
      if (result.kind === 'proactive_state') {
        setState(result)
        if (request.type === 'proactive_save_rule') setDraft(undefined)
        if (request.type !== 'proactive_state') refresh()
      } else if (result.kind === 'proactive_artifact') setArtifact(result.text)
      else if (result.kind === 'attention_policy') {
        const latest = await port({ type: 'proactive_state' }, controller.signal)
        if (!controller.signal.aborted && current() && latest.ok && latest.kind === 'proactive_state') {
          setState(latest)
          refresh()
        }
      } else setError('invalid_result')
    } catch {
      if (!controller.signal.aborted && current()) setError('host_unavailable')
    } finally {
      if (operation.current === controller) { operation.current = undefined; setBusy(false) }
    }
  }

  function mode(rule: Rule, next: ProactiveMode) {
    const grant = next === 'prepare' ? 'read_source' : next === 'act' ? 'surface_private_brief' : undefined
    void send({ type: 'proactive_mode', ruleId: rule.id, expectedVersion: rule.version, mode: next, grant })
  }

  function edit(value: Partial<ProactiveDraftInput>) {
    setDraft(current => current && ({ ...current, value: { ...current.value, ...value } }))
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (draft) void send({ type: 'proactive_save_rule', ruleId: draft.id, expectedVersion: draft.version, draft: draft.value })
  }

  const goals = snapshot.projects.filter(project => project.kind === 'goal')
  const tasks = snapshot.tasks.filter(task => task.projectId === draft?.value.projectId
    && ['queued', 'running', 'verifying'].includes(task.status))
  const disabled = !writable || busy
  return <details className="dshpa-card dshpa-section dshpa-knowledge">
    <summary id={id}>{t('suggestions.heading')}</summary>
    <section aria-labelledby={id}>
      <p>{t('suggestions.boundary')}</p>
      <button type="button" disabled={disabled} onClick={() => { void send({ type: 'proactive_state' }) }}>{t('suggestions.refresh')}</button>
      {state && <>
        <label>{t('suggestions.globalMode')} <select disabled={disabled} value={state.policy.mode} onChange={event => {
          const next = event.currentTarget.value as ProactiveMode
          const { version, ...policy } = state.policy
          void send({ type: 'set_attention_policy', expectedVersion: version, policy: { ...policy, mode: next } })
        }}>
          {modes.map(value => <option key={value} value={value}>{t(`suggestions.mode.${value}`)}</option>)}
        </select></label>
        <button type="button" disabled={disabled || goals.length === 0} onClick={() => setDraft({ id: requestId(), version: null, value: empty })}>
          {t('suggestions.newRule')}</button>
        <ul>{state.rules.map(rule => {
          const enough = rule.evidence.reviewed >= 20 && rule.evidence.useful * 10 >= rule.evidence.reviewed * 7
          return <li key={rule.id} className="dshpa-card">
            <strong>{rule.draft.title}</strong> · {t(`suggestions.mode.${rule.mode}`)}
            {!rule.current && <p>{t('suggestions.revalidate')}</p>}
            <p>{rule.draft.sourceInstanceId} / {rule.draft.accountId} / {rule.draft.threadId}</p>
            <p>{t('suggestions.evidence')} {rule.evidence.useful} / {rule.evidence.reviewed}</p>
            {rule.replay && <p>{t('suggestions.replayEvidence')} {rule.replay.matched} / {rule.replay.examined}</p>}
            <div className="dshpa-actions">
              <button type="button" disabled={disabled} onClick={() => setDraft({ id: rule.id, version: rule.version, value: rule.draft })}>
                {t('suggestions.edit')}</button>
              <button type="button" disabled={disabled || !rule.current} onClick={() => { void send({
                type: 'proactive_replay', ruleId: rule.id, expectedVersion: rule.version,
              }) }}>{t('suggestions.replay')}</button>
              <button type="button" disabled={disabled || !rule.current || !rule.replay?.matched || rule.mode === 'observe'}
                onClick={() => mode(rule, 'observe')}>{t('suggestions.observe')}</button>
              <button type="button" disabled={disabled || !rule.current || rule.mode !== 'observe' || !enough}
                onClick={() => mode(rule, 'prepare')}>{t('suggestions.prepare')}</button>
              <button type="button" disabled={disabled || !rule.current || rule.mode !== 'prepare' || !enough || rule.evidence.prepared === 0}
                onClick={() => mode(rule, 'act')}>{t('suggestions.act')}</button>
              <button type="button" disabled={disabled || rule.mode === 'off'} onClick={() => mode(rule, 'off')}>{t('suggestions.off')}</button>
            </div>
          </li>
        })}</ul>
      </>}
      {draft && <form className="dshpa-form" onSubmit={save}>
        <fieldset className="dshpa-form" disabled={disabled}>
          <label>{t('suggestions.title')}<input required maxLength={128} value={draft.value.title} onChange={event => edit({ title: event.currentTarget.value })} /></label>
          <label>{t('suggestions.goal')}<select required value={draft.value.projectId}
            onChange={event => edit({ projectId: event.currentTarget.value, taskId: '' })}>
            <option value="" />{goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
          </select></label>
          <label>{t('suggestions.task')}<select required value={draft.value.taskId} onChange={event => edit({ taskId: event.currentTarget.value })}>
            <option value="" />{tasks.map(task => <option key={task.id} value={task.id}>{task.outcome}</option>)}
          </select></label>
          <label>{t('suggestions.source')}<input required value={draft.value.sourceInstanceId} maxLength={256}
            onChange={event => edit({ sourceInstanceId: event.currentTarget.value })} /></label>
          <label>{t('suggestions.account')}<input required value={draft.value.accountId} maxLength={256}
            onChange={event => edit({ accountId: event.currentTarget.value })} /></label>
          <label>{t('suggestions.thread')}<input required value={draft.value.threadId} maxLength={512}
            onChange={event => edit({ threadId: event.currentTarget.value })} /></label>
          <label>{t('suggestions.query')}<input required value={draft.value.query} maxLength={256}
            onChange={event => edit({ query: event.currentTarget.value })} /></label>
          <button type="submit">{t('suggestions.save')}</button>
        </fieldset>
      </form>}
      {error && <p role="status">{t('suggestions.failed')} <code>{error}</code></p>}
      {artifact && <pre>{artifact}</pre>}
      {state && <details>
        <summary>{t('suggestions.decisions')}</summary>
        <ul>{state.candidates.map(candidate => <li key={candidate.id}>
          <p><time dateTime={candidate.at}>{formatTime(candidate.at, t)}</time> · <code>{candidate.reason}</code></p>
          {candidate.summary && <>
            <p>{candidate.summary}</p>
            <button type="button" disabled={disabled} aria-pressed={candidate.useful === true}
              onClick={() => { void send({ type: 'proactive_feedback', candidateId: candidate.id, useful: true }) }}>
              {t('suggestions.useful')}</button>
            <button type="button" disabled={disabled} aria-pressed={candidate.useful === false}
              onClick={() => { void send({ type: 'proactive_feedback', candidateId: candidate.id, useful: false }) }}>
              {t('suggestions.notUseful')}</button>
          </>}
          {candidate.artifactId && <button type="button" disabled={disabled}
            onClick={() => { void send({ type: 'proactive_artifact', candidateId: candidate.id }) }}>{t('suggestions.openBrief')}</button>}
        </li>)}</ul>
      </details>}
    </section>
  </details>
}
