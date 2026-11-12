import type { TaskStatus } from '../domain/model.js'

/** Public protocol projection only. This does not grant native/runtime authority. */
export const sharedCapabilityIds = [
  'tasks.list', 'approvals.read', 'approvals.respond', 'changes.poll',
  'conversations.resume', 'memory.read', 'memory.write',
] as const

export function sharedCapabilities(tasksAvailable = false) {
  return {
    schema_version: 'personal.api.v1',
    data: {
      contract_version: '0.1.0', backend: { id: 'dsh' },
      capabilities: sharedCapabilityIds.map(id => ({
        id, supported: id === 'tasks.list' && tasksAvailable, enabled: id === 'tasks.list' && tasksAvailable,
        available: id === 'tasks.list' && tasksAvailable,
        reason: id === 'tasks.list' && tasksAvailable ? null : 'not_implemented', remediation: null,
      })),
      transport: { polling: true, sse: false }, limits: { max_page_size: 64 },
    },
  } as const
}

export type SharedErrorCode = 'auth_required' | 'invalid_request' | 'cursor_invalid'
  | 'capability_unavailable' | 'forbidden' | 'internal_unavailable'

export function sharedError(code: SharedErrorCode, message: string, capability?: string) {
  return {
    schema_version: 'personal.api.v1',
    error: { code, message, retryable: code === 'internal_unavailable',
      ...(capability === undefined ? {} : { capability }) },
  } as const
}

/** Strict public task view. Recorded state is not proof of live worker or external-effect status. */
export function projectSharedTask(task: {
  id: string; requestedOutcome: string; version: number; status: TaskStatus;
}) {
  // JSON Schema lengths count Unicode code points. Identifiers and revisions must stay exact.
  if (typeof task.id !== 'string' || [...task.id].length < 1 || [...task.id].length > 256
    || typeof task.requestedOutcome !== 'string'
    || !Number.isSafeInteger(task.version) || task.version < 1) {
    throw new RangeError('Task cannot be represented by the shared client contract')
  }
  const states = {
    queued: ['queued', null], running: ['running', null], verifying: ['running', 'verification'],
    completed: ['completed', null], waiting_input: ['waiting', 'input'],
    waiting_approval: ['waiting', 'approval'], waiting_event: ['waiting', 'event'],
    waiting_environment: ['waiting', 'environment'], waiting_resource: ['waiting', 'resource'],
    blocked: ['waiting', 'dependency'], failed: ['failed', null], paused: ['paused', null],
    cancelling: ['waiting', 'cancellation_requested'], cancelled: ['cancelled', null],
    reconciliation_required: ['unknown', 'reconciliation_required'],
  } as const satisfies Record<TaskStatus, readonly [string, string | null]>
  if (!Object.hasOwn(states, task.status)) throw new RangeError('Unknown native task status')
  const [state, wait_reason] = states[task.status]
  // Capture 4,095 code points only when at least 4,097 exist, leaving room for the ellipsis.
  const titlePrefix = /^.{4095}(?=.{2})/su.exec(task.requestedOutcome)?.[0]
  const title = titlePrefix === undefined ? task.requestedOutcome : titlePrefix + '…'
  return { id: task.id, title, revision: String(task.version), state, wait_reason }
}
