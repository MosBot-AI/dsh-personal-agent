import type { AttemptId, UtcInstant } from '../domain/model.js'
import type { StoredWorkResult, WorkRef, WorkStore } from '../storage/store.js'

/** The caller has verified the exact native handle stopped or has a durable release record. */
export function confirmOwnedCancellation(
  store: WorkStore,
  ref: WorkRef,
  attemptId: AttemptId,
  generation: number,
  at: UtcInstant,
): StoredWorkResult {
  const state = store.getWork(ref)
  if (!state) return { ok: false, code: 'not_found' }
  if (state.attempt.id !== attemptId || state.attempt.generation !== generation) {
    return { ok: false, code: 'stale_attempt' }
  }
  if (state.task.status !== 'cancelling' || store.recoveryMode() === 'restore') {
    return { ok: false, code: 'invalid_transition' }
  }
  return store.applyEvent(ref, {
    type: 'confirm_cancel',
    expectedVersion: state.task.version,
    attemptId,
    generation,
    at,
    runtimeQuiescent: true,
    uncertainEffects: store.hasUnsettledEffects(ref, attemptId),
  })
}
