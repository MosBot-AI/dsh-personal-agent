import { utcInstantSchema, type UtcInstant } from '../domain/model.js'
import type { RecoveryMode } from '../storage/recovery-state.js'
import type { WorkRef, WorkStore } from '../storage/store.js'
import { confirmOwnedCancellation } from './cancel.js'
import type { EffectRecoveryOptions } from './recovery-effects.js'
import type { SessionReadback } from './recovery-session.js'

export interface RecoveryOptions {
  readonly readSession?: SessionReadback
  readonly effects?: EffectRecoveryOptions
  readonly now?: () => UtcInstant
}

export interface RecoveryResult {
  readonly mode: RecoveryMode
  readonly inputs: number
  readonly fenced: number
  readonly cancellations: number
  readonly effects: number
  readonly deliveries: number
}

/** Classify cold work under the writer guard before admitting new dispatch. */
export function createRecovery(store: WorkStore, options: RecoveryOptions = {}) {
  const effects = store.createEffectRecovery(options.effects)
  const now = options.now ?? (() => utcInstantSchema.parse(new Date().toISOString()))
  let pending: Promise<RecoveryResult> | undefined

  async function startup(): Promise<RecoveryResult> {
    const mode = store.recoveryMode()
    if (mode === 'normal') return { mode, inputs: 0, fenced: 0, cancellations: 0, effects: 0, deliveries: 0 }

    const external = effects.classifyInterrupted()
    // An old snapshot can omit work that was issued after the snapshot.
    // Neither old release evidence nor a missing input can reopen it.
    if (mode === 'restore') return { mode, inputs: 0, fenced: 0, cancellations: 0, ...external }

    let inputs = 0
    let afterAttempt = ''
    for (;;) {
      const page = store.listColdInputAttempts(afterAttempt)
      if (page.length === 0) break
      for (const { ref, attempt } of page) {
        for (const input of store.workerInputs(ref, attempt.id)) {
          if (input.status !== 'intent' && input.status !== 'flushed') continue
          let observation: Awaited<ReturnType<SessionReadback>> = 'unknown'
          if (options.readSession && attempt.worker && input.sessionId === attempt.sessionId) {
            try {
              observation = await options.readSession({
                sessionId: input.sessionId, cwd: attempt.worker.cwd, cursor: input.cursor,
                messageId: input.messageId, digest: input.digest,
              })
            } catch {
              observation = 'unknown'
            }
          }
          if (store.observeWorkerInput(ref, input, observation, now())) inputs += 1
        }
      }
      afterAttempt = page[page.length - 1]!.attempt.id
    }

    let fenced = 0
    let cancellations = 0
    let afterTask = ''
    for (;;) {
      const page = store.listColdWork(afterTask)
      if (page.length === 0) break
      for (const { task, attempt } of page) {
        const ref: WorkRef = { ownerId: task.ownerId, profileId: task.profileId, taskId: task.id }
        if (attempt.worker?.releasedAt !== undefined) {
          if (task.status === 'cancelling'
            && confirmOwnedCancellation(store, ref, attempt.id, attempt.generation, now()).ok) cancellations += 1
          continue
        }
        const result = store.applyEvent(ref, {
          type: 'recover_attempt',
          at: now(),
          expectedVersion: task.version,
          attemptId: attempt.id,
          generation: attempt.generation,
        })
        if (result.ok) fenced += 1
      }
      afterTask = page[page.length - 1]!.task.id
    }
    store.canDispatch()
    return { mode: store.recoveryMode(), inputs, fenced, cancellations, ...external }
  }

  return Object.freeze({
    reconcileStartup(): Promise<RecoveryResult> {
      if (pending) return pending
      pending = startup().finally(() => { pending = undefined })
      return pending
    },
    reconcileEffect: effects.reconcile,
  })
}
