import { createHash } from 'node:crypto'
import { z } from 'zod'
import { commandIdSchema, nonEmptyTextSchema, taskIdSchema, timeZoneSchema, utcInstantSchema, versionSchema } from '../domain/model.js'
import { routineIdSchema, type RoutineAuthority, type RoutineIntent, type RoutineTarget } from '../domain/routines.js'
import type { OwnerIdentity } from '../policy/identity.js'
import type { createScheduleAdapter } from '../runtime/schedule-adapter.js'
import type { WorkStore } from '../storage/store.js'
import type { InboxResponse, InboxSnapshot } from './protocol.js'

const timingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('at'), at: utcInstantSchema }),
  z.strictObject({ kind: z.literal('cron'), expression: nonEmptyTextSchema.max(256), timeZone: timeZoneSchema }),
])
const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reminder'), text: nonEmptyTextSchema.max(4096) }),
  z.strictObject({ kind: z.literal('goal'), taskId: taskIdSchema, expectedVersion: versionSchema }),
])
export const routineRequestSchemas = [
  z.strictObject({
    type: z.literal('save_routine'), commandId: commandIdSchema.max(256),
    routineId: routineIdSchema.optional(), expectedRevision: versionSchema.optional(),
    draft: z.strictObject({ title: nonEmptyTextSchema.max(120), timing: timingSchema, target: targetSchema,
      misfire: z.enum(['skip', 'latest']) }),
  }).refine(request => (request.routineId === undefined) === (request.expectedRevision === undefined)),
  z.strictObject({ type: z.enum(['arm_routine', 'pause_routine', 'run_routine_now']), commandId: commandIdSchema.max(256),
    routineId: routineIdSchema, expectedRevision: versionSchema }),
] as const

export type RoutineRequest = z.infer<typeof routineRequestSchemas[number]>

export interface RoutineInbox {
  snapshot(owner: OwnerIdentity): NonNullable<InboxSnapshot['schedules']>
  handle(owner: OwnerIdentity, request: RoutineRequest): InboxResponse
}

function ownerScope({ ownerId, profileId }: OwnerIdentity) { return { ownerId, profileId } }

export function routineAuthority({ clientId, deviceId, verifiedAt, policyVersion }: OwnerIdentity): RoutineAuthority {
  return { clientId, deviceId, verifiedAt, policyVersion }
}

export function createRoutineInbox(store: WorkStore, schedule: ReturnType<typeof createScheduleAdapter>): RoutineInbox {
  function targetFor(owner: OwnerIdentity, input: z.infer<typeof targetSchema>): RoutineTarget | undefined {
    if (input.kind === 'reminder') return input
    const state = store.getWork({ ...ownerScope(owner), taskId: input.taskId })
    if (!state || state.task.version !== input.expectedVersion || state.task.status !== 'waiting_event'
      || state.task.wait?.reason !== 'event' || state.attempt.mandate.policyVersion !== owner.policyVersion) return undefined
    return { kind: 'goal', taskId: state.task.id, projectId: state.task.projectId,
      attemptId: state.attempt.id, generation: state.task.generation, expectedVersion: state.task.version,
      waitReference: state.task.wait.referenceId }
  }

  function updated(result: { ok: true } | { ok: false; code: string }): InboxResponse {
    return result.ok ? { ok: true, kind: 'updated' } : result
  }

  return {
    snapshot(owner) {
      const scope = ownerScope(owner)
      const occurrences = store.listRoutineOccurrences(scope)
      const issues = new Set(store.listRoutineMappings(scope).filter(mapping => mapping.state === 'uncertain')
        .map(mapping => JSON.stringify([mapping.routineId, mapping.routineRevision])))
      return {
        routines: store.listRoutines(scope).map(routine => {
          const last = occurrences.find(item => item.routineId === routine.id)
          return { id: routine.id, revision: routine.revision, title: routine.title, state: routine.status,
            timing: routine.timing.kind === 'at' ? routine.timing : { ...routine.timing, timeZone: routine.timeZone },
            target: routine.target.kind === 'reminder' ? routine.target : { kind: 'goal', taskId: routine.target.taskId },
            misfire: routine.misfire, nextAt: routine.nextIntendedAt,
            issue: issues.has(JSON.stringify([routine.id, routine.revision])),
            ...(last === undefined ? {} : { last: { status: last.status, reason: last.reason, at: last.observedAt } }),
          }
        }),
        reminders: occurrences.flatMap(item => item.status !== 'reminded' || item.reminderText === undefined ? [] : [{
          id: item.id, title: item.title, text: item.reminderText, intendedAt: item.intendedAt, deliveredAt: item.observedAt,
        }]),
      }
    },
    handle(owner, request) {
      const scope = ownerScope(owner)
      const authority = routineAuthority(owner)
      if (request.type === 'save_routine') {
        const { draft } = request
        const target = targetFor(owner, draft.target)
        if (!target) return { ok: false, code: 'version_conflict' }
        const timing = draft.timing.kind === 'at' ? draft.timing : { kind: 'cron' as const, expression: draft.timing.expression }
        const intent: RoutineIntent = { title: draft.title, timing, target, misfire: draft.misfire,
          timeZone: draft.timing.kind === 'at' ? timeZoneSchema.parse('UTC') : draft.timing.timeZone,
          localTimeIntent: timing.kind === 'at' ? timing.at : timing.expression,
          dst: { gap: 'skip', overlap: 'earlier' } }
        if (request.routineId !== undefined && request.expectedRevision !== undefined) {
          return updated(schedule.update({ ...scope, routineId: request.routineId }, {
            type: 'edit', expectedRevision: request.expectedRevision, intent,
          }))
        }
        const key = createHash('sha256').update(JSON.stringify([scope.ownerId, scope.profileId, owner.clientId, request.commandId])).digest('hex')
        return updated(schedule.create(scope, { ...intent, id: routineIdSchema.parse(`routine-${key}`) }))
      }
      const ref = { ...scope, routineId: request.routineId }
      const { expectedRevision, commandId } = request
      if (request.type === 'run_routine_now') return updated(schedule.runNow(ref, { expectedRevision, commandId }, authority))
      return updated(schedule.update(ref, { type: request.type === 'arm_routine' ? 'arm' : 'pause', expectedRevision }, authority))
    },
  }
}
