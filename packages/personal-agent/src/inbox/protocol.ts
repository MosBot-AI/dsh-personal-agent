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
  readonly wait?: { readonly reason: string; readonly referenceId: string; readonly prompt: string }
  readonly artifacts: readonly InboxArtifact[]
  readonly deliveries: readonly { readonly id: string; readonly status: Delivery['status'] }[]
  readonly verifiedAt?: string
  readonly canAccept?: boolean
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

export interface InboxSnapshot {
  readonly workerConfigured: boolean
  readonly recoveryMode?: 'reconciling' | 'restore'
  readonly sessions: readonly InboxSession[]
  readonly projects: readonly InboxProject[]
  readonly tasks: readonly InboxTask[]
  readonly approvals: readonly InboxApproval[]
}

type TaskControl = { taskId: string; expectedVersion: number }

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

export type InboxResponse =
  | { ok: true; kind: 'snapshot'; snapshot: InboxSnapshot }
  | { ok: true; kind: 'updated'; taskId?: string; projectId?: string }
  | { ok: true; kind: 'artifact'; artifact: InboxArtifact & { text: string } }
  | { ok: false; code: string }

export type InboxPort = (request: InboxRequest, signal?: AbortSignal) => Promise<InboxResponse>
