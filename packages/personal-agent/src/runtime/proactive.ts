import { createHash } from 'node:crypto'
import { z } from 'zod'
import { knowledgeTerms } from '../context/search-index.js'
import { artifactIdSchema, utcInstantSchema, versionSchema, type SourceEvent, type UtcInstant } from '../domain/model.js'
import {
  candidateIdSchema, effectiveProactiveMode, proactiveDraftSchema, proactiveModeSchema, proactiveRuleIdSchema, usefulEvidence,
  type ProactiveCandidate, type ProactiveRule,
} from '../domain/proactive.js'
import type { IdentityBoundary } from '../policy/identity.js'
import { proactiveRuleScope, type ProactiveScope } from '../storage/proactive.js'
import type { WorkRef, WorkStore } from '../storage/store.js'
import { currentRoutingBody, type RoutingBody } from './intake.js'
import { readDecisions, type AssessmentCandidate, type RoutingAssessor } from './router.js'
import type { RoutingReceipt } from './subscriptions.js'

export const proactiveRequests = [
  z.strictObject({ type: z.literal('proactive_state') }),
  z.strictObject({ type: z.literal('proactive_save_rule'), ruleId: proactiveRuleIdSchema, expectedVersion: versionSchema.nullable(),
    draft: proactiveDraftSchema }),
  z.strictObject({ type: z.literal('proactive_replay'), ruleId: proactiveRuleIdSchema, expectedVersion: versionSchema }),
  z.strictObject({ type: z.literal('proactive_mode'), ruleId: proactiveRuleIdSchema, expectedVersion: versionSchema, mode: proactiveModeSchema,
    grant: z.enum(['read_source', 'surface_private_brief']).optional() }),
  z.strictObject({ type: z.literal('proactive_feedback'), candidateId: candidateIdSchema, useful: z.boolean() }),
  z.strictObject({ type: z.literal('proactive_artifact'), candidateId: candidateIdSchema }),
] as const
const requestSchema = z.discriminatedUnion('type', proactiveRequests)
const fail = <T extends string>(code: T) => ({ ok: false as const, code })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const liveStatuses = new Set(['queued', 'running', 'verifying'])
const ASSESSMENT_MS = 10_000
const noText = (candidate: ProactiveCandidate) => ({ ...candidate, summary: undefined, artifactId: undefined })

export function createProactive(options: {
  store: WorkStore; identity: IdentityBoundary; scope: ProactiveScope
  attention: ReturnType<WorkStore['createAttention']>
  assess?: RoutingAssessor; canAssess?: (batch: readonly AssessmentCandidate[]) => boolean
  assessmentDataScope?: readonly string[]
  assessmentRoute?: { provider: string; model: string }
  now?: () => UtcInstant
}) {
  const { store, identity, scope, attention } = options
  const ledger = store.createProactiveLedger(scope)
  const now = options.now ?? (() => utcInstantSchema.parse(new Date().toISOString()))
  const allowedLabels = new Set(options.assessmentDataScope ?? [])
  let closed = false
  let active: { controller: AbortController; pending: Promise<void> } | undefined
  ledger.recover()

  function exactSource(rule: ProactiveRule, event: SourceEvent, receipt: RoutingReceipt): RoutingBody | undefined {
    const { draft } = rule
    if (event.ownerId !== scope.ownerId || event.profileId !== scope.profileId || event.sourceInstanceId !== draft.sourceInstanceId
      || event.actor.accountId !== draft.accountId || event.threadId !== draft.threadId || receipt.projectId !== draft.projectId) return
    const body = currentRoutingBody(identity, event, receipt.authority)
    return body?.kind === 'candidate' && !body.target && !body.waitReference ? body : undefined
  }

  function target(rule: ProactiveRule) {
    const { draft } = rule
    const project = store.getProject(scope, draft.projectId)
    if (project?.kind !== 'goal' || project.status !== 'active') return undefined
    const ref: WorkRef = { ...scope, taskId: draft.taskId }
    const state = store.getWork(ref)
    return state?.task.projectId === draft.projectId && liveStatuses.has(state.task.status)
      && state.task.generation === state.attempt.generation ? { ref, state, project } : undefined
  }

  function specification(draft: ProactiveRule['draft']): string | undefined {
    const profile = identity.currentProfile(scope.profileId)
    const project = store.getProject(scope, draft.projectId)
    const enrollment = profile?.verifiedAccounts.filter(account => account.sourceInstanceId === draft.sourceInstanceId && account.accountId === draft.accountId)
    if (profile?.ownerId !== scope.ownerId || project?.kind !== 'goal' || enrollment?.length !== 1) return undefined
    return hash([draft, project.planRevision, profile.policyVersion, enrollment[0]!.verifiedAt, options.assessmentRoute, [...allowedLabels].sort()])
  }

  function currentRule(rule: ProactiveRule): boolean { return specification(rule.draft) === rule.spec }

  function matches(rule: ProactiveRule, body: RoutingBody, event: SourceEvent, at: UtcInstant): string | undefined {
    const age = Date.parse(at) - Date.parse(event.occurredAt)
    if (age < 0 || age > rule.draft.freshForMs) return 'stale_source'
    if (!body.dataScope.every(label => allowedLabels.has(label))) return 'disclosure_denied'
    const terms = knowledgeTerms(rule.draft.query)
    const text = normalize(body.text)
    if (!terms?.every(term => text.includes(term))) return 'rule_no_match'
    return undefined
  }

  function qualified(rule: ProactiveRule) {
    const counts = ledger.counts(rule)
    return usefulEvidence(counts.reviewed, counts.useful)
  }

  function consider(event: SourceEvent, _body: RoutingBody, receipt: RoutingReceipt): string {
    if (closed) return 'proactive_closed'
    if (!event.actor.accountId || !event.threadId) return 'proactive_scope_unavailable'
    const rule = ledger.ruleFor(proactiveRuleScope({ projectId: receipt.projectId, sourceInstanceId: event.sourceInstanceId,
      accountId: event.actor.accountId, threadId: event.threadId }))
    if (!rule) return 'proactive_no_rule'
    const body = exactSource(rule, event, receipt)
    const work = target(rule)
    if (!body || !work) return 'proactive_scope_unavailable'
    const { ref, state, project } = work
    const policy = attention.policy(scope)
    const mode = effectiveProactiveMode(rule.mode, policy.mode)
    const at = now()
    const assessment = { id: event.id, kind: 'candidate' as const,
      text: JSON.stringify({ goal: project.purpose.slice(0, 1024), rule: rule.draft.title, keywords: rule.draft.query, source: body.text }) }
    let reason = !currentRule(rule) ? 'rule_authority_changed' : mode === 'off' ? 'mode_off' : matches(rule, body, event, at)
    if (!reason && mode !== 'observe' && (!rule.readGrant || !qualified(rule))) reason = 'read_grant_required'
    if (!reason && active) reason = 'assessment_busy'
    if (!reason && (!options.assess || !options.canAssess?.([assessment]))) reason = 'budget_unavailable'
    const candidate: ProactiveCandidate = {
      id: `proactive-${hash([rule.id, event.id])}`, ruleId: rule.id, version: rule.version, spec: rule.spec, eventId: event.id,
      mode, at, attemptId: state.attempt.id, generation: state.attempt.generation, taskVersion: state.task.version, policyVersion: policy.version,
      status: reason ? 'suppressed' : 'pending', reason: reason ?? 'assessing',
    }
    const admitted = ledger.admit(rule, candidate, hash(normalize(body.text)))
    if (!admitted.ok) return `proactive-${admitted.code}`
    if (admitted.candidate.status !== 'pending') return `proactive-${admitted.candidate.reason}`

    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ASSESSMENT_MS)])
    const current = () => {
      if (closed || signal.aborted || !store.canDispatch() || ledger.rule(rule.id)?.version !== rule.version || !currentRule(rule)) return false
      const latest = target(rule)?.state
      const live = exactSource(rule, event, receipt)
      return attention.policy(scope).version === policy.version && latest?.task.version === candidate.taskVersion
        && latest.attempt.id === candidate.attemptId && latest.attempt.generation === candidate.generation
        && !!live && !matches(rule, live, event, now()) && (mode === 'observe' || (rule.readGrant && qualified(rule)))
    }

    const pending = Promise.resolve().then(async () => {
      if (!current()) { ledger.settle(candidate.id, { status: 'suppressed', reason: 'authority_changed' }); return }
      const output = await options.assess!([assessment], signal)
      if (!current()) { ledger.settle(candidate.id, { status: 'suppressed', reason: 'authority_changed' }); return }
      const result = readDecisions(output, [assessment]).get(event.id)
      if (result?.kind !== 'propose_task') { ledger.settle(candidate.id, { status: 'suppressed', reason: 'no_useful_suggestion' }); return }
      if (mode === 'observe') {
        ledger.settle(candidate.id, { status: 'proposed', reason: 'observe_only', summary: result.summary })
        return
      }
      const artifactId = artifactIdSchema.parse(`brief-${hash([candidate.id])}`)
      store.artifacts.preparePrivate(ref, { id: artifactId, attemptId: candidate.attemptId, generation: candidate.generation,
        expectedVersion: candidate.taskVersion, mediaType: 'text/plain', visibility: 'private',
        sourceEventIds: [event.id], bytes: new TextEncoder().encode(result.summary) })
      let noticeReason = 'prepare_only'
      let surfaced = false
      if (mode === 'act' && rule.localGrant) {
        const notice = attention.consider(ref, { attemptId: candidate.attemptId, generation: candidate.generation,
          expectedVersion: candidate.taskVersion, category: 'proactive', local: true,
          source: { sourceInstanceId: event.sourceInstanceId, externalEventId: event.externalEventId, externalRevision: event.externalRevision },
        }, current)
        noticeReason = notice.ok ? notice.decision.reason : notice.code
        surfaced = notice.ok && notice.decision.action === 'local'
      }
      ledger.settle(candidate.id, { status: surfaced ? 'surfaced' : 'prepared', reason: noticeReason, summary: result.summary, artifactId })
    }).catch(() => {
      if (!closed) ledger.settle(candidate.id, { status: 'suppressed', reason: signal.aborted ? 'authority_changed' : 'assessment_unavailable' })
    }).finally(() => { if (active?.controller === controller) active = undefined })
    active = { controller, pending }
    return 'proactive-assessing'
  }

  function canSee(candidate: ProactiveCandidate): boolean {
    const rule = ledger.rule(candidate.ruleId)
    if (!rule || rule.spec !== candidate.spec || !currentRule(rule)) return false
    const source = store.getRoutingEvent({ ...scope, eventId: candidate.eventId })
    const body = source && exactSource(rule, source.event, source.receipt)
    const work = target(rule)
    return !!body && body.dataScope.every(label => allowedLabels.has(label)) && !!work
      && work.state.attempt.id === candidate.attemptId && work.state.attempt.generation === candidate.generation
  }

  function state() {
    const policy = attention.policy(scope)
    return { ok: true as const, kind: 'proactive_state' as const, policy,
      rules: ledger.rules().map(rule => ({ ...rule, evidence: ledger.counts(rule), current: currentRule(rule) })),
      candidates: ledger.candidates().map(candidate => {
        if (candidate.summary === undefined && candidate.artifactId === undefined) return candidate
        if (!canSee(candidate)) return noText(candidate)
        const rule = ledger.rule(candidate.ruleId)
        if (candidate.status === 'surfaced' && (policy.mode !== 'act' || policy.version !== candidate.policyVersion
          || rule?.version !== candidate.version || !rule.localGrant || !qualified(rule))) return { ...candidate, status: 'prepared' as const }
        return candidate
      }),
    }
  }

  function notices() {
    const policy = attention.policy(scope)
    if (policy.mode !== 'act' || !store.canDispatch()) return []
    const format = new Intl.DateTimeFormat('en', { timeZone: policy.timeZone, dateStyle: 'short' })
    const day = format.format(new Date(now()))
    return ledger.candidates().flatMap(candidate => {
      const rule = ledger.rule(candidate.ruleId)
      if (candidate.status !== 'surfaced' || !candidate.summary || candidate.policyVersion !== policy.version
        || format.format(new Date(candidate.at)) !== day || rule?.version !== candidate.version || !rule.localGrant || !qualified(rule)
        || !canSee(candidate)) return []
      return [{ id: candidate.id, at: candidate.at, summary: candidate.summary }]
    }).slice(0, 3)
  }

  function handle(input: unknown) {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_input')
    if (!store.canDispatch() || closed) return fail('recovery_required')
    const request = parsed.data
    if (request.type === 'proactive_state') return state()
    if (request.type === 'proactive_artifact' || request.type === 'proactive_feedback') {
      const candidate = ledger.candidate(request.candidateId)
      if (!candidate || !canSee(candidate)) return fail('source_unavailable')
      if (request.type === 'proactive_feedback') {
        const saved = ledger.feedback(candidate.id, request.useful)
        return saved.ok ? state() : saved
      }
      const rule = ledger.rule(candidate.ruleId)
      if (!candidate.artifactId || !rule?.readGrant) return fail('source_unavailable')
      const artifact = store.artifacts.read({ ...scope, taskId: rule.draft.taskId }, candidate.artifactId)
      if (!artifact || artifact.artifact.visibility !== 'private' || artifact.artifact.attemptId !== candidate.attemptId
        || !artifact.artifact.provenance.sourceEventIds.includes(candidate.eventId)) return fail('source_unavailable')
      return { ok: true as const, kind: 'proactive_artifact' as const, candidateId: candidate.id, text: new TextDecoder().decode(artifact.bytes) }
    }

    const existing = ledger.rule(request.ruleId)
    let rule: ProactiveRule
    if (request.type === 'proactive_save_rule') {
      const spec = specification(request.draft)
      if (!spec) return fail('scope_unavailable')
      if (!knowledgeTerms(request.draft.query)) return fail('invalid_input')
      if (existing && existing.spec === spec && (request.expectedVersion === null || request.expectedVersion === existing.version)) return state()
      rule = { id: request.ruleId, spec, draft: request.draft, mode: 'off', version: (request.expectedVersion ?? 0) + 1,
        readGrant: false, localGrant: false }
      if (!target(rule)) return fail('scope_unavailable')
    } else {
      if (!existing) return fail('not_found')
      if (existing.version !== request.expectedVersion) return fail('version_conflict')
      if (!currentRule(existing) && !(request.type === 'proactive_mode' && request.mode === 'off')) return fail('rule_authority_changed')
      rule = { ...existing, version: existing.version + 1 }
      if (request.type === 'proactive_replay') {
        const at = now()
        const rows = store.replayRoutingEvents(scope, rule.draft)
        const matched = rows.filter(({ event, receipt }) => {
          const body = exactSource(rule, event, receipt)
          return body && !matches(rule, body, event, at)
        }).length
        rule = { ...rule, replay: { at, examined: rows.length, matched } }
      } else {
        const mode = request.mode
        if (mode !== 'off' && (!target(rule) || !rule.replay?.matched)) return fail('replay_required')
        if (mode === 'prepare' && (existing.mode !== 'observe' || !qualified(rule) || request.grant !== 'read_source')) {
          return fail('observation_required')
        }
        if (mode === 'act' && (existing.mode !== 'prepare' || !existing.readGrant || !qualified(rule)
          || ledger.counts(rule).prepared === 0 || request.grant !== 'surface_private_brief')) return fail('preparation_required')
        rule = { ...rule, mode, readGrant: mode === 'prepare' || mode === 'act', localGrant: mode === 'act' }
      }
    }
    if (!Number.isSafeInteger(rule.version)) return fail('invalid_input')
    const saved = ledger.save(rule, request.expectedVersion)
    if (!saved.ok) return saved
    active?.controller.abort()
    return state()
  }

  return { consider, handle, notices, invalidate() { active?.controller.abort() },
    async close() { closed = true; active?.controller.abort(); await active?.pending; ledger.recover() } }
}

export type ProactiveService = ReturnType<typeof createProactive>
