import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { SkillRequestInput, SkillResponse } from '../context/skill-contract.js'
import type { InboxPort, InboxProject, InboxTask } from '../inbox/protocol.js'
import type { MessageKey, Translate } from './copy.js'

type Detail = Extract<SkillResponse, { kind: 'skill_revision' }>
type Output = Extract<SkillResponse, { kind: 'skill_output' }>
type Summary = Detail['skill']
type Source = { taskId: string; artifactId: string }
type Draft = { id: string; latest: number; name: string; template: string; sources: string[];
  fixtures: { artifactId: string; inputs: string }[] }

const blankFixture = () => ({ artifactId: '', inputs: '{}' })
const skillErrors: Record<string, MessageKey> = {
  source_unavailable: 'skills.sourceUnavailable', skill_fixture_overlap: 'skills.fixtureOverlap',
  skill_evaluation_required: 'skills.evaluationRequired', invalid_input: 'skills.invalid',
  invalid_transition: 'skills.stale', version_conflict: 'skills.stale',
}

function matches(response: SkillResponse, request: SkillRequestInput): boolean {
  if (response.projectId !== request.projectId) return false
  if (request.type === 'skill_list') return response.kind === 'skill_list'
  if (request.type === 'skill_run') return response.kind === 'skill_output' && response.skillId === request.skillId
    && response.revision === request.revision && response.digest === request.digest && response.runId === request.runId
  return response.kind === 'skill_revision' && response.skill.skillId === request.skillId
    && (request.type === 'skill_propose' ? response.detail.revision === request.expectedLatest + 1
      : response.detail.revision === request.revision && (!('digest' in request) || response.detail.digest === request.digest))
}

function SkillProject({ projectId, tasks, port, t, current, chooseTask }: {
  projectId: string; tasks: readonly InboxTask[]; port: InboxPort; t: Translate; current: () => boolean; chooseTask: (id: string) => void
}) {
  const [list, setList] = useState<Summary[]>([])
  const [selected, setSelected] = useState<Detail>()
  const [draft, setDraft] = useState<Draft>()
  const [output, setOutput] = useState<Output>()
  const [values, setValues] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<MessageKey>()
  const [busy, setBusy] = useState(false)
  const pending = useRef<AbortController>()
  const available = new Map<string, { source: Source; label: string }>()
  for (const task of tasks) {
    if (task.projectId !== projectId || task.status !== 'completed' || !task.verifiedAt) continue
    for (const artifact of task.artifacts) {
      if (artifact.mediaType !== 'text/markdown' && artifact.mediaType !== 'text/plain') continue
      available.set(artifact.id, { source: { taskId: task.id, artifactId: artifact.id }, label: `${task.outcome} · ${artifact.id}` })
    }
  }

  async function send(request: SkillRequestInput) {
    if (pending.current || !current()) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setNotice(undefined)
    try {
      const response = await port(request, controller.signal)
      if (controller.signal.aborted || !current()) return
      if (!response.ok) {
        setNotice(Object.hasOwn(skillErrors, response.code) ? skillErrors[response.code] : 'skills.unavailable')
        if (response.code === 'source_unavailable') { setSelected(undefined); setOutput(undefined) }
        return
      }
      if ((response.kind !== 'skill_list' && response.kind !== 'skill_revision' && response.kind !== 'skill_output')
        || !matches(response, request)) { setNotice('skills.unavailable'); return }
      if (response.kind === 'skill_list') setList(response.skills)
      if (response.kind === 'skill_output') setOutput(response)
      if (response.kind === 'skill_revision') {
        const next = { ...response.skill, name: response.detail.spec?.name }
        setList(rows => rows.some(row => row.skillId === next.skillId)
          ? rows.map(row => row.skillId === next.skillId ? { ...next, name: row.name ?? next.name } : row)
          : [next, ...rows])
        setSelected(response)
        if (request.type === 'skill_propose') { setDraft(undefined); setValues({}) }
        if (request.type === 'skill_feedback') setOutput(undefined)
      }
    } catch {
      if (!controller.signal.aborted && current()) setNotice('skills.unavailable')
    } finally {
      if (pending.current === controller) {
        pending.current = undefined
        if (current()) setBusy(false)
      }
    }
  }

  useEffect(() => {
    void send({ type: 'skill_list', projectId })
    return () => { pending.current?.abort(); pending.current = undefined }
  }, [projectId])

  function inspect(skillId: string, revision: number) {
    setSelected(undefined)
    setOutput(undefined)
    setValues({})
    setDraft(undefined)
    if (skillId) void send({ type: 'skill_inspect', projectId, skillId, revision })
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft) return
    const sources = []
    for (const id of draft.sources) {
      const source = available.get(id)?.source
      if (!source) { setNotice('skills.invalid'); return }
      sources.push(source)
    }
    const fixtures = []
    for (const item of draft.fixtures) {
      const source = available.get(item.artifactId)?.source
      if (!source) { setNotice('skills.invalid'); return }
      try {
        const parsed: unknown = JSON.parse(item.inputs)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
          || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('Invalid fixture input')
        fixtures.push({ source, inputs: parsed as Record<string, string> })
      } catch { setNotice('skills.invalid'); return }
    }
    void send({ type: 'skill_propose', projectId, skillId: draft.id, expectedLatest: draft.latest,
      draft: { name: draft.name, template: draft.template, sources, fixtures } })
  }

  const sourcePicker = (label: MessageKey, value: string, change: (id: string) => void) => <label>
    {t(label)} <select required value={value} onChange={event => change(event.currentTarget.value)}>
      <option value="">{t('skills.chooseArtifact')}</option>
      {[...available].map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
    </select>
  </label>

  const spec = selected?.detail.spec
  const passed = selected?.detail.evaluation?.every(Boolean)
  const exact = selected && { projectId, skillId: selected.skill.skillId, revision: selected.detail.revision, digest: selected.detail.digest }
  const selection = selected && exact && { ...exact, expectedSelection: selected.skill.selection }
  return <div className="dshpa-form">
    <div className="dshpa-actions">
      <button type="button" disabled={busy} onClick={() => {
        setSelected(undefined); setOutput(undefined); setDraft(undefined)
        void send({ type: 'skill_list', projectId })
      }}>{t('skills.refresh')}</button>
      <button type="button" disabled={busy} onClick={() => {
        setSelected(undefined); setOutput(undefined); setNotice(undefined)
        setDraft({ id: crypto.randomUUID(), latest: 0, name: '', template: '', sources: ['', ''], fixtures: [blankFixture()] })
      }}>{t('skills.propose')}</button>
    </div>
    {notice && <p role="status">{t(notice)}</p>}
    <label>{t('skills.chooseSkill')} <select value={selected?.skill.skillId ?? ''} disabled={busy}
      onChange={event => {
        const row = list.find(item => item.skillId === event.currentTarget.value)
        inspect(row?.skillId ?? '', row?.active ?? row?.latest ?? 0)
      }}>
      <option value="">{t('skills.chooseSkill')}</option>
      {list.map(item => <option key={item.skillId} value={item.skillId}>{item.name ?? item.skillId}</option>)}
    </select></label>
    {selected && <div className="dshpa-form">
      <label>{t('skills.revision')} <select value={selected.detail.revision} disabled={busy}
        onChange={event => inspect(selected.skill.skillId, Number(event.currentTarget.value))}>
        {Array.from({ length: selected.skill.latest }, (_, i) => i + 1).map(version =>
          <option key={version} value={version}>v{version}{version === selected.skill.active ? ` · ${t('skills.active')}` : ''}</option>)}
      </select></label>
      <p><code>{selected.detail.digest}</code></p>
      <p>{t('skills.accepted')} {selected.detail.accepted} · {t('skills.corrections')} {selected.detail.corrections}
        {' · '}{t('skills.rollbacks')} {selected.detail.rollbacks}</p>
      {!spec && <>
        <p>{t('skills.sourceUnavailable')}</p>
        {selected.detail.revision === selected.skill.latest &&
          <button type="button" disabled={busy} onClick={() => setDraft({
            id: selected.skill.skillId, latest: selected.skill.latest, name: '', template: '', sources: ['', ''], fixtures: [blankFixture()],
          })}>{t('skills.revise')}</button>}
      </>}
      {spec && exact && selection && <>
        <pre>{spec.template}</pre>
        <p>{t('skills.schema')} {spec.inputSchema.required.join(', ')} → {spec.outputSchema.mediaType}
          {' · '}{spec.requiredCapabilities.join(', ')}</p>
        <ul>
          {spec.sources.map(source => <li key={source.taskId}>
            <button type="button" onClick={() => chooseTask(source.taskId)}>{t('skills.source')} · {source.artifactId}</button>
          </li>)}
          {spec.fixtures.map(({ source, inputs }, index) => <li key={source.taskId}>
            <button type="button" onClick={() => chooseTask(source.taskId)}>{t('skills.fixture')} · {source.artifactId}</button>
            {' · '}{t(selected.detail.evaluation === null ? 'skills.untested'
              : selected.detail.evaluation[index] ? 'skills.passed' : 'skills.failed')}
            <pre>{JSON.stringify(inputs, null, 2)}</pre>
          </li>)}
        </ul>
        <div className="dshpa-actions">
          <button type="button" disabled={busy} onClick={() => { void send({ type: 'skill_evaluate', ...exact }) }}>{t('skills.evaluate')}</button>
          {!selected.detail.approved && selected.detail.revision === selected.skill.latest &&
            <button type="button" disabled={busy || !passed} onClick={() => { void send({ type: 'skill_activate', ...selection }) }}>
              {t('skills.activate')} v{selected.detail.revision}
            </button>}
          {selected.detail.approved && selected.skill.active !== null && selected.detail.revision < selected.skill.active &&
            <button type="button" disabled={busy || !passed} onClick={() => { void send({ type: 'skill_rollback', ...selection }) }}>
              {t('skills.rollback')} v{selected.detail.revision}
            </button>}
          {selected.detail.revision === selected.skill.latest &&
            <button type="button" disabled={busy} onClick={() => setDraft({
              id: selected.skill.skillId, latest: selected.skill.latest, name: spec.name, template: spec.template,
              sources: spec.sources.map(source => source.artifactId),
              fixtures: spec.fixtures.map(item => ({ artifactId: item.source.artifactId, inputs: JSON.stringify(item.inputs) })),
            })}>{t('skills.revise')}</button>}
        </div>
        {selected.skill.active === selected.detail.revision && <form className="dshpa-form" onSubmit={event => {
          event.preventDefault()
          setOutput(undefined)
          void send({ type: 'skill_run', ...exact, runId: crypto.randomUUID(), inputs: values })
        }}>
          {spec.inputSchema.required.map(field => <label key={field}>{field}
            <textarea required maxLength={spec.inputSchema.maxLength} value={values[field] ?? ''}
              onChange={event => setValues({ ...values, [field]: event.currentTarget.value })} />
          </label>)}
          <button type="submit" disabled={busy}>{t('skills.run')}</button>
        </form>}
        {output && <div className="dshpa-form">
          <label>{t('skills.output')}<textarea readOnly value={output.text} /></label>
          <div className="dshpa-actions">
            {(['accepted', 'correction'] as const).map(feedback => <button key={feedback} type="button" disabled={busy || output.feedback !== null}
              onClick={() => { void send({ type: 'skill_feedback', ...exact, runId: output.runId, feedback }) }}>
              {t(feedback === 'accepted' ? 'skills.accept' : 'skills.correct')}
            </button>)}
          </div>
        </div>}
      </>}
    </div>}
    {draft && <form className="dshpa-form" onSubmit={save}>
      <fieldset className="dshpa-form" disabled={busy}>
        <legend>{t('skills.draft')}</legend>
        <p>{t('skills.draftHelp')}</p>
        <label>{t('skills.name')}<input required maxLength={100} value={draft.name}
          onChange={event => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
        <label>{t('skills.template')}<textarea required maxLength={4096} value={draft.template} placeholder="## {{topic}}"
          onChange={event => setDraft({ ...draft, template: event.currentTarget.value })} /></label>
        {draft.sources.map((id, index) => <div key={index}>{sourcePicker('skills.source', id, value =>
          setDraft({ ...draft, sources: draft.sources.map((entry, i) => i === index ? value : entry) }))}</div>)}
        {draft.fixtures.map((fixture, index) => {
          const change = (next: typeof fixture) => setDraft({ ...draft, fixtures: draft.fixtures.map((item, i) => i === index ? next : item) })
          return <div key={index} className="dshpa-form">
            {sourcePicker('skills.fixture', fixture.artifactId, value => change({ ...fixture, artifactId: value }))}
            <label>{t('skills.fixtureInputs')}<textarea required value={fixture.inputs}
              onChange={event => change({ ...fixture, inputs: event.currentTarget.value })} /></label>
          </div>
        })}
        <div className="dshpa-actions">
          <button type="button" disabled={draft.fixtures.length >= 4} onClick={() =>
            setDraft({ ...draft, fixtures: [...draft.fixtures, blankFixture()] })}>{t('skills.addFixture')}</button>
          {draft.fixtures.length > 1 && <button type="button" onClick={() =>
            setDraft({ ...draft, fixtures: draft.fixtures.slice(0, -1) })}>{t('skills.removeFixture')}</button>}
          <button type="submit">{t('skills.save')}</button>
        </div>
      </fieldset>
    </form>}
  </div>
}

export function ReviewedSkills({ projects, tasks, port, t, current, chooseTask }: {
  projects: readonly InboxProject[]; tasks: readonly InboxTask[]; port: InboxPort; t: Translate
  current: () => boolean; chooseTask: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState('')
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('skills.title')}</summary>
    <label>{t('skills.project')} <select value={projectId} onChange={event => setProjectId(event.currentTarget.value)}>
      <option value="">{t('skills.project')}</option>
      {projects.map(project =>
        <option key={project.id} value={project.id}>{project.title}</option>)}
    </select></label>
    {open && projects.some(project => project.id === projectId) &&
      <SkillProject key={projectId} projectId={projectId} tasks={tasks} port={port} t={t} current={current} chooseTask={chooseTask} />}
  </details>
}
