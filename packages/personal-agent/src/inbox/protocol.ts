import type { DesktopActivity, DesktopTarget } from '../domain/model.js'
import type { SkillRequestInput, SkillResponse } from '../context/skill-contract.js'
import type { Delivery, TaskStatus } from '../domain/model.js'
import type { MemoryActiveRecord, MemoryScope } from '@mosbot-ai/dshpa-plugin-api'
import type { ProjectPlanInput } from '../domain/projects.js'
import type { ConnectorBinding, ConnectorRecord } from '../connectors/registry.js'
import type { ProactiveDraftInput, ProactiveMode } from '../domain/proactive.js'
import type { ProactiveService } from '../runtime/proactive.js'
import type { DraftInput, DraftPayload } from '../connectors/github-draft-model.js'

export const INBOX_RPC_ENDPOINT = 'dshpa/inbox'

export interface MobileDeviceSummary {
  readonly deviceId: string
  readonly label: string
  readonly state: 'pending' | 'active' | 'revoked'
  readonly expiresAt: string
  readonly enrolledAt: string | null
}

export interface InboxSession {
  readonly id: string
  readonly label: string
}

export interface InboxProject {
  readonly id: string
  readonly title: string
  readonly purpose: string
  readonly kind?: 'project' | 'goal'
}

export interface InboxPlan {
  readonly projectId: string
  readonly kind: 'project' | 'goal'
  readonly revision: number
  readonly draft: ProjectPlanInput
  readonly history: readonly { revision: number; draft: ProjectPlanInput; rationale?: string; recordedAt?: string }[]
}

export interface InboxReviewProject {
  readonly projectId: string
  readonly title: string
  readonly priority: ProjectPlanInput['priority']
  readonly due?: string
  readonly milestones: readonly string[]
  readonly ready: readonly string[]
  readonly waiting: readonly string[]
  readonly accepted: readonly string[]
}

export interface KnowledgeRootStatus {
  readonly id: string
  readonly status: 'available' | 'limited' | 'unavailable'
  readonly files: number
}

export interface KnowledgeSource {
  readonly ref: { readonly rootId: string; readonly id: string }
  readonly path: string
  readonly revision: string
}

export interface InboxArtifact {
  readonly id: string
  readonly mediaType: string
  readonly version: number
}

export interface InboxTask {
  readonly id: string
  readonly projectId: string
  readonly sessionId?: string
  readonly outcome: string
  readonly status: TaskStatus
  readonly version: number
  readonly runtime: 'active' | 'inactive' | 'unknown'
  readonly wait?: { readonly reason: string; readonly referenceId: string; readonly prompt: string; readonly notBefore?: string }
  readonly artifacts: readonly InboxArtifact[]
  readonly deliveries: readonly { readonly id: string; readonly status: Delivery['status'] }[]
  readonly verifiedAt?: string
  readonly canAccept?: boolean
  readonly canResumeCompute?: boolean
  readonly desktopApplication?: string
  readonly canStartDesktop?: boolean
  readonly progress?: { readonly summary: string; readonly at: string }
  readonly prerequisites?: readonly { id: string; completed: boolean }[]
  readonly proposal?: { readonly cursor: string; readonly steps: readonly string[] }
}

export interface InboxApproval {
  readonly id: string
  readonly taskId: string
  readonly version: number
  readonly digest: string
  readonly expiresAt: string
  readonly kind: string
  readonly accountId: string
  readonly resourceRef: string
  readonly recipient?: string
  readonly dataScope: readonly string[]
  readonly preview: string
  readonly mobileDeviceId?: string
}

export interface InboxUsage {
  readonly day: string
  readonly currencies: readonly {
    readonly currency: string
    readonly spentMicros: number
    readonly reservedMicros: number
    readonly uncertainMicros: number
    readonly olderHeldMicros: number
    readonly dailyLimitMicros?: number
    readonly overflow: boolean
  }[]
  readonly unknownCalls: number
  readonly uncertainCalls: number
  readonly calls: number
  readonly routing: 'off' | 'configured' | 'pricing_unavailable' | 'provider_unavailable'
  readonly tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }
  readonly workerSlots: { readonly active: number; readonly limit: number }
  readonly gpu: { readonly active: number; readonly queued: number; readonly limit: number }
  readonly attention?: {
    readonly mode: 'off' | 'observe' | 'prepare' | 'act'
    readonly version: number
    readonly day: string
    readonly timeZone: string
    readonly unsolicited: number
    readonly limit: number
    readonly suppressed: number
    readonly recent: readonly { readonly id: string; readonly reason: string; readonly at: string }[]
  }
}

export type InboxRoutineTiming = { kind: 'at'; at: string } | { kind: 'cron'; expression: string; timeZone: string }
export type InboxRoutineTarget = { kind: 'reminder'; text: string } | { kind: 'goal'; taskId: string }

export interface InboxRoutine {
  readonly id: string
  readonly title: string
  readonly revision: number
  readonly state: 'draft' | 'armed' | 'paused' | 'ended'
  readonly timing: InboxRoutineTiming
  readonly target: InboxRoutineTarget
  readonly misfire: 'skip' | 'latest'
  readonly nextAt?: string
  readonly issue?: boolean
  readonly last?: { readonly status: 'reminded' | 'queued' | 'skipped'; readonly reason?: string; readonly at: string }
}

export interface InboxReminder {
  readonly id: string
  readonly title: string
  readonly text: string
  readonly intendedAt: string
  readonly deliveredAt: string
}

type RoutineDraft = {
  title: string; timing: InboxRoutineTiming; misfire: InboxRoutine['misfire'];
  target: Extract<InboxRoutineTarget, { kind: 'reminder' }> | { kind: 'goal'; taskId: string; expectedVersion: number };
}

export interface InboxSnapshot {
  readonly workerConfigured: boolean
  readonly mobileConfigured?: boolean
  readonly mobileReviewers?: readonly Pick<MobileDeviceSummary, 'deviceId' | 'label'>[]
  readonly desktopTargets?: readonly DesktopTarget[]
  readonly desktopActivities?: readonly DesktopActivity[]
  readonly memoryConfigured?: boolean
  readonly knowledgeConfigured?: boolean
  readonly githubRead?: { readonly projectId?: string }
  readonly proactiveConfigured?: boolean
  readonly proactiveNotices?: readonly { id: string; at: string; summary: string }[]
  readonly githubDraft?: { readonly projectId: string }
  readonly recoveryMode?: 'reconciling' | 'restore'
  readonly sessions: readonly InboxSession[]
  readonly projects: readonly InboxProject[]
  readonly tasks: readonly InboxTask[]
  readonly approvals: readonly InboxApproval[]
  readonly usage?: InboxUsage
  readonly schedules?: { readonly routines: readonly InboxRoutine[]; readonly reminders: readonly InboxReminder[] }
}

type TaskControl = { taskId: string; expectedVersion: number }
type EvidencePointer = { kind: 'event'; eventId: string } | { kind: 'artifact'; artifactId: string }
type MemoryControl = { scope: MemoryScope; commandId: string }
type MemoryRevision = { recordId: string; expectedRevision: number }

export type InboxRequest =
  | SkillRequestInput
  | { type: 'snapshot' }
  | { type: 'mobile_devices' }
  | { type: 'mobile_pair'; label: string }
  | { type: 'mobile_revoke'; deviceId: string }
  | { type: 'mobile_review'; requestId: string; expectedVersion: number; digest: string; deviceId: string | null }
  | ({ type: 'desktop_start'; cursor: string; application: string } & TaskControl)
  | { type: 'desktop_takeover' | 'desktop_release'; taskId: string; leaseId: string }
  | { type: 'knowledge_status' }
  | { type: 'knowledge_search'; rootId?: string; query: string; limit?: number }
  | { type: 'knowledge_read'; ref: KnowledgeSource['ref']; revision: string; offset?: number; maxBytes?: number }
  | { type: 'connector_status'; projectId?: string }
  | { type: 'connector_read'; projectId?: string; read: { operation: 'issues'; cursor?: string }
      | { operation: 'comments'; issue: number; cursor?: string } }
  | { type: 'proactive_state' }
  | { type: 'proactive_save_rule'; ruleId: string; expectedVersion: number | null; draft: ProactiveDraftInput }
  | { type: 'proactive_replay'; ruleId: string; expectedVersion: number }
  | { type: 'proactive_mode'; ruleId: string; expectedVersion: number; mode: ProactiveMode;
      grant?: 'read_source' | 'surface_private_brief' }
  | { type: 'proactive_feedback'; candidateId: string; useful: boolean }
  | { type: 'proactive_artifact'; candidateId: string }
  | ({ type: 'github_draft_prepare'; commandId: string; draft: DraftInput } & TaskControl)
  | { type: 'github_draft_inspect'; taskId: string }
  | ({ type: 'github_draft_dispatch'; operationId: string } & TaskControl)
  | { type: 'github_draft_reconcile' | 'github_draft_revoke'; taskId: string; operationId: string }
  | { type: 'create_project'; commandId: string; title: string; purpose: string }
  | { type: 'create_task'; commandId: string; projectId: string; sessionId: string; outcome: string }
  | { type: 'save_plan'; commandId: string; projectId?: string; expectedRevision?: number; draft: ProjectPlanInput; rationale: string }
  | { type: 'project_plan'; projectId: string }
  | { type: 'project_review' }
  | ({ type: 'set_prerequisites'; prerequisiteIds: string[] } & TaskControl)
  | { type: 'accept_plan_step'; taskId: string; cursor: string; index: number }
  | ({ type: 'start'; cursor: string } & TaskControl)
  | ({ type: 'pause' | 'cancel'; commandId: string } & TaskControl)
  | ({ type: 'resume'; commandId: string } & TaskControl)
  | ({ type: 'redirect'; cursor: string; text: string } & TaskControl)
  | ({ type: 'answer'; cursor: string; referenceId: string; text: string } & TaskControl)
  | ({ type: 'accept_result' } & TaskControl)
  | { type: 'approval'; requestId: string; expectedVersion: number; digest: string; decision: 'approve' | 'deny' }
  | { type: 'artifact'; taskId: string; artifactId: string }
  | { type: 'context_recall'; taskId: string; ref: EvidencePointer | { kind: 'task'; taskId: string }; cursor?: string; maxBytes?: number }
  | { type: 'context_search'; taskId: string; query: string; limit?: number }
  | { type: 'context_checkpoint'; taskId: string }
  | ({ type: 'context_exclude'; ref: EvidencePointer; reason: 'forgotten' | 'superseded' } & TaskControl)
  | { type: 'memory_search'; scope: MemoryScope; query: string; limit?: number }
  | { type: 'memory_inspect'; scope: MemoryScope; recordId: string }
  | ({ type: 'memory_remember'; text: string; validUntil?: string } & MemoryControl)
  | ({ type: 'memory_correct'; text: string; validUntil?: string } & MemoryControl & MemoryRevision)
  | ({ type: 'memory_forget' } & MemoryControl & MemoryRevision)
  | { type: 'set_subscription'; subscription: {
    sourceInstanceId: string; accountId: string; threadId: string; projectId: string; taskId: string;
    mode: 'context' | 'work'; enabled: boolean; expectedVersion?: number; expiresAt?: string;
  } }
  | { type: 'set_attention_policy'; expectedVersion: number; policy: unknown }
  | { type: 'save_routine'; commandId: string; routineId?: string; expectedRevision?: number; draft: RoutineDraft }
  | { type: 'arm_routine' | 'pause_routine' | 'run_routine_now'; commandId: string; routineId: string; expectedRevision: number }
  | { type: 'resident_status' | 'resident_backup' }
  | { type: 'resident_audit'; afterSequence?: number }

export type InboxResponse =
  | SkillResponse
  | { ok: true; kind: 'snapshot'; snapshot: InboxSnapshot }
  | { ok: true; kind: 'mobile_devices'; available: boolean; devices: readonly MobileDeviceSummary[] }
  | { ok: true; kind: 'mobile_pair'; pairingCode: string; expiresAt: string; origin: string }
  | { ok: true; kind: 'updated'; taskId?: string; projectId?: string }
  | { ok: true; kind: 'artifact'; artifact: InboxArtifact & { text: string } }
  | { ok: true; kind: 'subscription'; version: number }
  | { ok: true; kind: 'attention_policy'; version: number }
  | { ok: true; kind: 'resident'; value: object }
  | { ok: true; kind: 'context'; value: object | null }
  | { ok: true; kind: 'knowledge_status'; roots: readonly KnowledgeRootStatus[] }
  | { ok: true; kind: 'knowledge_search'; roots: readonly KnowledgeRootStatus[]; hits: readonly (KnowledgeSource & { snippet: string })[] }
  | { ok: true; kind: 'knowledge_page'; source: KnowledgeSource; text: string; totalBytes: number; nextOffset?: number }
  | { ok: true; kind: 'connector_status'; binding: ConnectorBinding; fingerprint: string }
  | { ok: true; kind: 'connector_page'; binding: ConnectorBinding; fingerprint: string;
      items: readonly ConnectorRecord[]; nextCursor?: string }
  | Extract<ReturnType<ProactiveService['handle']>, { ok: true }>
  | { ok: true; kind: 'github_draft'; draft: { payload: Omit<DraftPayload, 'preparedAt'> & { preparedAt: string };
      digest: string; approval: string; effect: string; revoked: boolean; receipt?: string } | null }
  | { ok: true; kind: 'project_plan'; plan: InboxPlan }
  | { ok: true; kind: 'project_review'; projects: readonly InboxReviewProject[]; needsPriority: boolean; at: string }
  | { ok: true; kind: 'memory_records'; confirmed: readonly MemoryActiveRecord[]; inferred: readonly MemoryActiveRecord[] }
  | { ok: true; kind: 'memory_change'; state: 'completed' | 'pending'; recordId: string; revision: number }
  | { ok: false; code: string; retryAt?: string }

export type InboxPort = (request: InboxRequest, signal?: AbortSignal) => Promise<InboxResponse>
