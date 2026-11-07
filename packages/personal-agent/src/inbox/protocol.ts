import type { Delivery, TaskStatus } from '../domain/model.js'

export const INBOX_RPC_ENDPOINT = 'dshpa/inbox'

export interface InboxSession {
  readonly id: string
  readonly label: string
}

export interface InboxProject {
  readonly id: string
  readonly title: string
  readonly purpose: string
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
  readonly progress?: { readonly summary: string; readonly at: string }
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

export type InboxRequest =
  | { type: 'snapshot' }
  | { type: 'create_project'; commandId: string; title: string; purpose: string }
  | { type: 'create_task'; commandId: string; projectId: string; sessionId: string; outcome: string }
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
  | { ok: true; kind: 'snapshot'; snapshot: InboxSnapshot }
  | { ok: true; kind: 'updated'; taskId?: string; projectId?: string }
  | { ok: true; kind: 'artifact'; artifact: InboxArtifact & { text: string } }
  | { ok: true; kind: 'subscription'; version: number }
  | { ok: true; kind: 'attention_policy'; version: number }
  | { ok: true; kind: 'resident'; value: object }
  | { ok: true; kind: 'context'; value: object | null }
  | { ok: false; code: string }

export type InboxPort = (request: InboxRequest, signal?: AbortSignal) => Promise<InboxResponse>
