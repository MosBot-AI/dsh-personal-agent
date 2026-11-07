import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { utcInstantSchema, type ProjectId, type UtcInstant } from '../domain/model.js'
import type { IdentityBoundary, OwnerIdentity } from '../policy/identity.js'
import type { WorkStore } from '../storage/store.js'
import {
  skillInputLimit, skillOutputLimit, type skillSourceSchema, type SkillProof, type SkillRequest, type SkillResponse, type SkillSpec,
} from './skill-contract.js'
import { contextSourceLabels } from './source-authority.js'

type Source = z.infer<typeof skillSourceSchema>
type Ledger = ReturnType<WorkStore['createSkillLedger']>
type Revision = NonNullable<ReturnType<Ledger['read']>>
type Header = NonNullable<ReturnType<Ledger['header']>>
const placeholder = /\{\{([a-z][a-z0-9_]{0,31})\}\}/gu
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const error = (code: string) => ({ ok: false, code }) as const

function fields(template: string) {
  if (/\{\{|\}\}/u.test(template.replace(placeholder, ''))) return []
  return [...new Set(Array.from(template.matchAll(placeholder), match => match[1]!))].sort()
}

function render(spec: SkillSpec, values: Record<string, string>): string | undefined {
  const keys = spec.inputSchema.required
  if (keys.length !== Object.keys(values).length || !keys.every(key => Object.hasOwn(values, key))) return undefined
  // Interpolate once. Values are opaque text even if they contain template syntax, links or commands.
  const text = spec.template.replace(placeholder, (_match, key: string) => values[key]!)
  if (!text.length || text.length > skillOutputLimit) return undefined
  return text
}

function revisionDigest(owner: OwnerIdentity, projectId: ProjectId, skillId: string, revision: number, spec: SkillSpec) {
  return hash(JSON.stringify([owner.ownerId, owner.profileId, owner.policyVersion, projectId, skillId, revision, spec]))
}

export function createSkillCandidates({ store, identity, now = () => utcInstantSchema.parse(new Date().toISOString()) }: {
  store: WorkStore; identity: IdentityBoundary; now?: () => UtcInstant
}) {
  function acceptedSource(owner: OwnerIdentity, projectId: ProjectId, source: Source, at: UtcInstant): SkillProof | undefined {
    const ref = { ownerId: owner.ownerId, profileId: owner.profileId, taskId: source.taskId }
    const state = store.getWork(ref)
    if (state?.task.status !== 'completed' || state.task.projectId !== projectId
      || state.attempt.mandate.policyVersion !== owner.policyVersion) return undefined
    const verification = store.getVerification(ref, state.task.version)
    const proof = verification?.artifacts.find(item => item.id === source.artifactId)
    if (!proof || verification?.attemptId !== state.attempt.id || verification.generation !== state.attempt.generation) return undefined
    const sealed = store.getContextArtifact(ref, source.artifactId, at)
    if (!sealed || sealed.version !== proof.version || sealed.artifact.contentHash !== proof.digest
      || sealed.artifact.attemptId !== verification.attemptId || sealed.generation !== verification.generation
      || !['text/markdown', 'text/plain'].includes(sealed.artifact.mediaType)) return undefined
    const history = store.workerContextSources(ref, state.attempt.id)
    if (!history || ![...new Set([...history, ...sealed.artifact.provenance.sourceEventIds])].every(id => {
      const event = store.getContextSource(ref, id, at)
      return event !== undefined && contextSourceLabels(store, identity, event) !== undefined
    })) return undefined
    return { taskId: source.taskId, artifactId: source.artifactId, taskVersion: state.task.version,
      artifactVersion: proof.version, digest: proof.digest }
  }

  function usable(owner: OwnerIdentity, projectId: ProjectId, skillId: string, record: Revision, at: UtcInstant): boolean {
    return record.policyVersion === owner.policyVersion
      && revisionDigest(owner, projectId, skillId, record.revision, record.spec) === record.digest
      && [...record.spec.sources, ...record.spec.fixtures.map(item => item.source)].every(proof => {
        const current = acceptedSource(owner, projectId, proof, at)
        return current?.taskVersion === proof.taskVersion && current.artifactVersion === proof.artifactVersion
          && current.digest === proof.digest
      })
  }

  function detail(projectId: ProjectId, skill: Header, record: Revision, visible: boolean): SkillResponse {
    const { revision, digest, spec, approved, evaluation, accepted, corrections, rollbacks } = record
    return { ok: true, kind: 'skill_revision', projectId, skill,
      detail: { revision, digest, ...(visible ? { spec } : {}), approved, evaluation, accepted, corrections, rollbacks } }
  }

  function propose(owner: OwnerIdentity, request: Extract<SkillRequest, { type: 'skill_propose' }>, ledger: Ledger, at: UtcInstant) {
    const { projectId, skillId, expectedLatest, draft } = request
    const selected = [...draft.sources, ...draft.fixtures.map(item => item.source)]
    if (new Set(selected.map(item => item.taskId)).size !== selected.length) return error('skill_fixture_overlap')
    const required = fields(draft.template)
    if (required.length === 0 || required.length > 8) return error('invalid_input')
    const proofs = new Map(selected.map(item => [item.taskId, acceptedSource(owner, projectId, item, at)]))
    if ([...proofs.values()].some(proof => proof === undefined)) return error('source_unavailable')
    const sources = draft.sources.map(item => proofs.get(item.taskId)!)
    const fixtures = draft.fixtures.map(item => ({ source: proofs.get(item.source.taskId)!, inputs: item.inputs }))
    const known = new Set(sources.map(item => item.digest))
    for (const item of fixtures) {
      if (known.has(item.source.digest)) return error('skill_fixture_overlap')
      known.add(item.source.digest)
    }
    const spec: SkillSpec = { name: draft.name, template: draft.template,
      inputSchema: { type: 'object', required, valueType: 'string', maxLength: skillInputLimit, additionalProperties: false },
      outputSchema: { type: 'string', mediaType: 'text/markdown', maxLength: skillOutputLimit },
      requiredCapabilities: ['render-markdown'], sources, fixtures }
    if (fixtures.some(item => render(spec, item.inputs) === undefined)
      || new Set(fixtures.map(item => JSON.stringify(required.map(key => item.inputs[key])))).size !== fixtures.length) return error('invalid_input')
    const version = expectedLatest + 1
    const digest = revisionDigest(owner, projectId, skillId, version, spec)
    const existing = ledger.read(skillId, version)
    if (existing?.digest !== digest && !ledger.propose(skillId, expectedLatest, digest, owner.policyVersion, spec)) {
      return error('version_conflict')
    }
    return detail(projectId, ledger.header(skillId)!, ledger.read(skillId, version)!, true)
  }

  return {
    handle(owner: OwnerIdentity, request: SkillRequest): SkillResponse | ReturnType<typeof error> {
      const { projectId } = request
      if (store.recoveryMode() !== 'normal') return error('recovery_required')
      if (store.getProject(owner, projectId)?.status !== 'active') return error('not_found')
      const ledger = store.createSkillLedger({ ...owner, projectId })
      if (request.type === 'skill_list') {
        return { ok: true, kind: 'skill_list', projectId, skills: ledger.list().map(skill => {
          const record = ledger.read(skill.skillId, skill.latest)
          return { ...skill, name: record?.policyVersion === owner.policyVersion ? record.spec.name : undefined }
        }) }
      }
      const at = now()
      if (request.type === 'skill_propose') return propose(owner, request, ledger, at)
      const { skillId, revision } = request
      const skill = ledger.header(skillId)
      const record = ledger.read(skillId, revision)
      if (!skill || !record) return error('not_found')
      if ('digest' in request && request.digest !== record.digest) return error('version_conflict')
      const visible = usable(owner, projectId, skillId, record, at)
      if (request.type === 'skill_inspect') return detail(projectId, skill, record, visible)
      if (!visible) return error('source_unavailable')

      switch (request.type) {
        case 'skill_evaluate': {
          const evaluation = record.spec.fixtures.map(item => {
            const text = render(record.spec, item.inputs)
            return text !== undefined && hash(text) === item.source.digest
          })
          ledger.evaluate(skillId, revision, evaluation)
          return detail(projectId, skill, { ...record, evaluation }, true)
        }
        case 'skill_activate':
        case 'skill_rollback': {
          if (!record.evaluation?.every(Boolean)) return error('skill_evaluation_required')
          if (skill.active === revision && skill.selection === request.expectedSelection + 1) return detail(projectId, skill, record, true)
          const rollback = request.type === 'skill_rollback'
          if (rollback ? (!record.approved || skill.active === null || revision >= skill.active)
            : (record.approved || revision !== skill.latest)) return error('invalid_transition')
          if (!ledger.select(skillId, revision, request.expectedSelection, rollback)) return error('version_conflict')
          return detail(projectId, ledger.header(skillId)!, ledger.read(skillId, revision)!, true)
        }
        case 'skill_run': {
          if (skill.active !== revision || !record.approved || !record.evaluation?.every(Boolean)) return error('invalid_transition')
          const text = render(record.spec, request.inputs)
          if (text === undefined) return error('invalid_input')
          const inputDigest = hash(JSON.stringify(record.spec.inputSchema.required.map(key => request.inputs[key])))
          const saved = ledger.use(skillId, revision, request.runId, inputDigest)
          if (saved?.revision !== revision || saved.digest !== inputDigest) return error('version_conflict')
          return { ok: true, kind: 'skill_output', projectId, skillId, revision, digest: record.digest,
            runId: request.runId, text, feedback: saved.feedback }
        }
        case 'skill_feedback': {
          if (!ledger.feedback(skillId, revision, request.runId, request.feedback)) return error('version_conflict')
          return detail(projectId, skill, ledger.read(skillId, revision)!, true)
        }
      }
    },
  }
}
