import type { TaskStatus } from '../domain/model.js'

/** Public protocol projection only. This does not grant native/runtime authority. */
export const sharedCapabilityIds = [
  'tasks.list', 'approvals.read', 'approvals.respond', 'changes.poll',
  'conversations.resume', 'memory.read', 'memory.write',
] as const

export function sharedCapabilities() {
  return {
    schema_version: 'personal.api.v1',
    data: {
      contract_version: '0.1.0', backend: { id: 'dsh' },
      capabilities: sharedCapabilityIds.map(id => ({
        id, supported: false, enabled: false, available: false,
        reason: 'not_implemented', remediation: null,
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

/** Future list adapter seam; deliberately not connected to a collection route yet. */
export function projectSharedTask(task: {
  id: string; requestedOutcome: string; version: number; status: TaskStatus;
}) {
  // JSON Schema lengths count Unicode code points. Reject instead of truncating identity or content.
  if (typeof task.id !== 'string' || [...task.id].length < 1 || [...task.id].length > 256
    || typeof task.requestedOutcome !== 'string' || [...task.requestedOutcome].length > 4096
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
  return { id: task.id, title: task.requestedOutcome, revision: String(task.version), state, wait_reason }
}
