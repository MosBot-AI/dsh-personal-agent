import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { skillResponseSchema, type SkillResponse } from '../../packages/personal-agent/src/context/skill-contract.js'
import { artifactIdSchema, profileSchema, projectSchema, taskIdSchema, utcInstantSchema } from '../../packages/personal-agent/src/domain/model.js'
import type { WorkState } from '../../packages/personal-agent/src/domain/transitions.js'
import type { InboxResponse } from '../../packages/personal-agent/src/inbox/protocol.js'
import { createInboxService } from '../../packages/personal-agent/src/inbox/service.js'
import { createIdentityBoundary } from '../../packages/personal-agent/src/policy/identity.js'
import { openWorkStore } from '../../packages/personal-agent/src/storage/store.js'

const at = utcInstantSchema.parse('2026-11-07T08:00:00.000Z')
const device = { deviceId: 'fixture-device', verifiedAt: at }
const profile = profileSchema.parse({ id: 'skills-profile', ownerId: 'skills-owner', policyVersion: 'skills-policy',
  verifiedAccounts: [], verifiedDevices: [device] })
const outsider = profileSchema.parse({ ...profile, id: 'other-profile', ownerId: 'other-owner' })
const scope = { ownerId: profile.ownerId, profileId: profile.id }
const project = projectSchema.parse({ ...scope, id: 'skills-project', kind: 'project', title: 'Briefing', purpose: 'Produce reviewed briefings.',
  resourceRefs: [], status: 'active', successCriteria: ['Create the briefing.'], planRevision: 1, milestones: [] })
const projectId = project.id
const otherProject = projectSchema.parse({ ...project, id: 'other-project' })
const template = '## {{topic}}\n{{summary}}'
const owner = { ...scope, deviceId: device.deviceId, clientId: 'fixture-client', sessionId: 'fixture-session' }

function fence(state: WorkState) {
  return { at, expectedVersion: state.task.version, attemptId: state.attempt.id, generation: state.attempt.generation }
}

function detail(result: InboxResponse): Extract<SkillResponse, { kind: 'skill_revision' }> {
  expect(skillResponseSchema.safeParse(result).success, JSON.stringify(result)).toBe(true)
  if (!result.ok || result.kind !== 'skill_revision') throw new Error(JSON.stringify(result))
  return result
}

function exact(result: ReturnType<typeof detail>) {
  return { projectId: result.projectId, skillId: result.skill.skillId, revision: result.detail.revision, digest: result.detail.digest }
}

const denied = (code: string) => ({ ok: false, code })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dshpa-skills-'))
  let currentProfile = profile
  const identity = createIdentityBoundary(id => id === profile.id ? currentProfile : id === outsider.id ? outsider : undefined)
  let token = identity.bindOwner(owner)!
  const outsiderToken = identity.bindOwner({ ...owner, ownerId: outsider.ownerId, profileId: outsider.id })!
  let store = openWorkStore(dir)
  store.insertProject(project)
  store.insertProject(otherProject)
  const service = () => createInboxService({ store, identity, resolveSession: () => true, now: () => at })
  let inbox = service()
  const call = (input: unknown, authority: unknown = token) => inbox.handle(authority, input)
  onTestFinished(() => { try { store.close() } finally { rmSync(dir, { recursive: true, force: true }) } })

  async function accept(label: string, text: string, { target = projectId, complete = true } = {}) {
    const created = await call({ type: 'create_task', projectId: target, sessionId: owner.sessionId,
      commandId: `create-${label}`, outcome: `Prepare the ${label} briefing.` })
    if (!created.ok || created.kind !== 'updated' || !created.taskId) throw new Error(JSON.stringify(created))
    const ref = { ...scope, taskId: taskIdSchema.parse(created.taskId) }
    const started = store.applyEvent(ref, { type: 'start', ...fence(store.getWork(ref)!), executor: 'skills-fixture' })
    if (!started.ok) throw new Error(started.code)
    const artifactId = artifactIdSchema.parse(`artifact-${label}`)
    const sourceId = started.state.task.provenance.sourceEventIds[0]!
    store.artifacts.seal(ref, { id: artifactId, attemptId: started.state.attempt.id, generation: started.state.attempt.generation,
      expectedVersion: started.state.task.version, mediaType: 'text/markdown', visibility: 'private',
      sourceEventIds: [sourceId], bytes: new TextEncoder().encode(text) })
    const ready = store.applyEvent(ref, { type: 'ready', ...fence(started.state), artifactIds: [artifactId] })
    if (!ready.ok) throw new Error(ready.code)
    if (complete) {
      const checked = await store.createVerifier({ now: () => at, check: view => view.state.task.acceptance.criteria.map(criterion =>
        ({ criterion, satisfied: true, evidence: 'Read back the sealed briefing fixture.' })) })
        .verify(ref, { expectedVersion: ready.state.task.version })
      expect(checked).toMatchObject({ ok: true, state: { task: { status: 'completed' } } })
    }
    return { ref, source: { taskId: ref.taskId, artifactId }, sourceId }
  }

  async function draft(name = 'Briefing') {
    const exampleA = await accept('east', '## East\nFirst accepted outcome.')
    const exampleB = await accept('west', '## West\nSecond accepted outcome.')
    const heldOut = await accept('north', '## North\nIndependent expected output.')
    return { exampleA, exampleB, heldOut, proposed: {
      type: 'skill_propose', projectId, skillId: randomUUID(), expectedLatest: 0,
      draft: { name, template, sources: [exampleA.source, exampleB.source], fixtures: [
        { source: heldOut.source, inputs: { topic: 'North', summary: 'Independent expected output.' } },
      ] },
    } as const }
  }

  return { get store() { return store }, call, accept, draft,
    restart() { store.close(); store = openWorkStore(dir); inbox = service() },
    changePolicy() {
      currentProfile = { ...profile, policyVersion: 'changed-policy' }
      const fresh = identity.bindOwner(owner)!
      const old = token
      token = fresh
      return old
    },
    revokeSourceDevice() {
      currentProfile = profileSchema.parse({ ...profile, verifiedDevices: [{ deviceId: 'replacement-device', verifiedAt: at }] })
      token = identity.bindOwner({ ...owner, deviceId: 'replacement-device' })!
    },
    outsiderToken,
  }
}

describe('owner-reviewed skills through the inbox', () => {
  it('evaluates an exact candidate, persists outcome feedback, and rolls back to the prior approved version after restart', async () => {
    const f = fixture()
    const { proposed } = await f.draft()
    const first = detail(await f.call(proposed))
    expect(first.detail.spec).toMatchObject({ requiredCapabilities: ['render-markdown'],
      inputSchema: { required: ['summary', 'topic'], additionalProperties: false },
      outputSchema: { mediaType: 'text/markdown' }, sources: [{ digest: expect.any(String) }, { digest: expect.any(String) }] })
    expect(JSON.stringify(first)).not.toContain('First accepted outcome.')
    expect(detail(await f.call(proposed))).toEqual(first)
    const approve = { type: 'skill_activate', ...exact(first), expectedSelection: 0 }
    expect(await f.call(approve)).toEqual(denied('skill_evaluation_required'))
    const reuse = { type: 'skill_run', ...exact(first), runId: randomUUID(),
      inputs: { topic: '南区', summary: '{{topic}} <img src=x onerror=evil()> [send](https://invalid.test)' } }
    expect(await f.call(reuse)).toEqual(denied('invalid_transition'))
    expect(detail(await f.call({ type: 'skill_evaluate', ...exact(first) })).detail.evaluation).toEqual([true])
    expect(await f.call({ ...approve, digest: 'a'.repeat(64) })).toEqual(denied('version_conflict'))
    expect(detail(await f.call(approve)).skill).toMatchObject({ active: 1, selection: 1 })
    expect(detail(await f.call(approve)).skill.selection).toBe(1)
    expect(await f.call(reuse)).toMatchObject({ kind: 'skill_output',
      text: '## 南区\n{{topic}} <img src=x onerror=evil()> [send](https://invalid.test)', feedback: null })
    const accepted = { type: 'skill_feedback', ...exact(first), runId: reuse.runId, feedback: 'accepted' }
    expect(detail(await f.call(accepted)).detail.accepted).toBe(1)
    expect(detail(await f.call(accepted)).detail.accepted).toBe(1)
    expect(await f.call({ ...accepted, feedback: 'correction' })).toEqual(denied('version_conflict'))
    expect(await f.call(reuse)).toMatchObject({ kind: 'skill_output', feedback: 'accepted' })
    expect(await f.call({ ...reuse, inputs: { topic: 'Other', summary: 'Different request.' } })).toEqual(denied('version_conflict'))
    expect(await f.call({ ...reuse, runId: randomUUID(), inputs: { topic: 'Other', summary: 'x', extra: 'z' } })).toEqual(denied('invalid_input'))

    const heldOutTwo = await f.accept('new-format', '### South\nRevised heading.')
    const second = detail(await f.call({ ...proposed, expectedLatest: 1, draft: { ...proposed.draft,
      template: '### {{topic}}\n{{summary}}',
      fixtures: [{ source: heldOutTwo.source, inputs: { topic: 'South', summary: 'Revised heading.' } }],
    } }))
    expect(second.skill.active).toBe(1)
    expect(second.detail.digest).not.toBe(first.detail.digest)
    const approveSecond = { type: 'skill_activate', ...exact(second), expectedSelection: 1 }
    expect(await f.call(approveSecond)).toEqual(denied('skill_evaluation_required'))
    expect(detail(await f.call({ type: 'skill_evaluate', ...exact(second) })).detail.evaluation).toEqual([true])
    expect(detail(await f.call(approveSecond)).skill.active).toBe(2)
    const correctedRun = { ...reuse, ...exact(second), runId: randomUUID() }
    expect(await f.call(correctedRun)).toMatchObject({ kind: 'skill_output', text: expect.stringMatching(/^### 南区/u) })
    expect(detail(await f.call({ ...accepted, ...exact(second), runId: correctedRun.runId, feedback: 'correction' }))
      .detail).toMatchObject({ corrections: 1, accepted: 0 })

    f.restart()
    expect(await f.call(reuse)).toEqual(denied('invalid_transition'))
    expect(detail(await f.call({ type: 'skill_inspect', projectId, skillId: second.skill.skillId, revision: 2 }))
      .detail).toMatchObject({ corrections: 1, approved: true })
    const rollBack = { type: 'skill_rollback', ...exact(first), expectedSelection: 2 }
    expect(await f.call({ ...rollBack, expectedSelection: 1 })).toEqual(denied('version_conflict'))
    expect(detail(await f.call(rollBack))).toMatchObject({ skill: { active: 1, selection: 3 }, detail: { rollbacks: 1, accepted: 1 } })
    expect(detail(await f.call(rollBack)).detail.rollbacks).toBe(1)
    expect(await f.call(reuse)).toMatchObject({ kind: 'skill_output', feedback: 'accepted' })
    expect(await f.call({ ...correctedRun, ...exact(first) })).toEqual(denied('version_conflict'))
  })

  it('requires separate verified project evidence and fails evaluation on an incorrect outcome', async () => {
    const f = fixture()
    const { proposed, exampleA, heldOut } = await f.draft()
    const unfinished = await f.accept('unfinished', 'Unverified result.', { complete: false })
    const foreign = await f.accept('other', 'Other project result.', { target: otherProject.id })
    const copy = await f.accept('same-bytes', '## East\nFirst accepted outcome.')
    const proposeFixture = (source: typeof heldOut.source) => ({ ...proposed, draft: {
      ...proposed.draft, fixtures: [{ ...proposed.draft.fixtures[0], source }],
    } })
    expect(await f.call(proposed, {})).toEqual(denied('permission_denied'))
    expect(await f.call(proposed, f.outsiderToken)).toEqual(denied('not_found'))
    expect(await f.call(proposeFixture(exampleA.source))).toEqual(denied('skill_fixture_overlap'))
    expect(await f.call(proposeFixture(copy.source))).toEqual(denied('skill_fixture_overlap'))
    expect(await f.call(proposeFixture(unfinished.source))).toEqual(denied('source_unavailable'))
    expect(await f.call(proposeFixture(foreign.source))).toEqual(denied('source_unavailable'))
    expect(await f.call({ ...proposed, draft: { ...proposed.draft, requiredCapabilities: ['install-plugin'] } })).toEqual(denied('invalid_input'))
    expect(await f.call({ ...proposed, draft: { ...proposed.draft, template: '{{run(shell)}}' } })).toEqual(denied('invalid_input'))
    const fixtureTwo = await f.accept('south', '## South\nAnother expected outcome.')
    const mismatch = detail(await f.call({ ...proposed, draft: { ...proposed.draft, fixtures: [
      proposed.draft.fixtures[0], { source: fixtureTwo.source, inputs: { topic: 'South', summary: 'Wrong outcome.' } },
    ] } }))
    const evaluated = detail(await f.call({ type: 'skill_evaluate', ...exact(mismatch) }))
    expect(evaluated.detail.evaluation).toEqual([true, false])
    expect(await f.call({ type: 'skill_activate', ...exact(evaluated), expectedSelection: 0 })).toEqual(denied('skill_evaluation_required'))
    expect(await f.call({ type: 'skill_inspect', ...exact(evaluated), digest: undefined })).toEqual(denied('invalid_input'))
    expect(await f.call({ type: 'skill_evaluate', ...exact(mismatch), projectId: otherProject.id })).toEqual(denied('not_found'))
  })

  it.each(['artifact', 'event', 'device', 'policy'] as const)('invalidates the active revision after %s evidence revocation', async kind => {
    const f = fixture()
    const { proposed, exampleA } = await f.draft()
    const approved = detail(await f.call(proposed))
    await f.call({ type: 'skill_evaluate', ...exact(approved) })
    detail(await f.call({ type: 'skill_activate', ...exact(approved), expectedSelection: 0 }))
    const run = { type: 'skill_run', ...exact(approved), runId: randomUUID(), inputs: { topic: 'Run', summary: 'Known source.' } }
    expect(await f.call(run)).toMatchObject({ kind: 'skill_output' })
    if (kind === 'artifact' || kind === 'event') {
      expect(f.store.excludeContextPointer(exampleA.ref, kind === 'artifact'
        ? { kind, artifactId: exampleA.source.artifactId } : { kind, eventId: exampleA.sourceId },
      { at, kind: kind === 'artifact' ? 'superseded' : 'forgotten' })).toMatchObject({ ok: true })
    } else if (kind === 'device') f.revokeSourceDevice()
    else {
      const old = f.changePolicy()
      expect(await f.call(run, old)).toEqual(denied('permission_denied'))
    }
    f.restart()
    expect(await f.call(run)).toEqual(denied('source_unavailable'))
    expect(await f.call({ type: 'skill_evaluate', ...exact(approved) })).toEqual(denied('source_unavailable'))
    const result = detail(await f.call({ type: 'skill_inspect', projectId, skillId: approved.skill.skillId, revision: 1 }))
    expect(result.detail.spec).toBeUndefined()
    expect(await f.call({ type: 'snapshot' })).toMatchObject({ ok: true, kind: 'snapshot' })
  })
})
