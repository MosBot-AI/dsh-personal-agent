import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { projectIdSchema, taskIdSchema, taskStatusSchema, utcInstantSchema, versionSchema } from '../domain/model.js'
import type { MobileDeviceLedger, MobileDeviceScope } from './devices.js'

const replayWindow = 128
const cursorSchema = z.tuple([taskIdSchema, versionSchema])
const eventSchema = z.object({
  taskId: taskIdSchema, version: versionSchema, status: taskStatusSchema, at: utcInstantSchema,
})
const taskSchema = z.object({
  id: taskIdSchema, projectId: projectIdSchema, requestedOutcome: z.string(), version: versionSchema, status: taskStatusSchema,
})

type DatabaseAccess = <T>(operation: (db: DatabaseSync) => T) => T
const fail = <C extends string>(code: C) => ({ ok: false, code } as const)

function encodeCursor(event: Pick<z.output<typeof eventSchema>, 'taskId' | 'version'>): string {
  return Buffer.from(JSON.stringify([event.taskId, event.version])).toString('base64url')
}

function decodeCursor(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,1500}$/u.test(value)) return undefined
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
    return encodeCursor({ taskId: cursor[0], version: cursor[1] }) === value ? { key: cursor, encoded: value } : undefined
  } catch {
    return undefined
  }
}

const scopedEvents = `
  FROM work_events e JOIN tasks t ON t.id = e.task_id
  WHERE e.owner_id = ? AND e.profile_id = ? AND t.conversation_id IS NOT NULL
`
const eventFields = 'e.task_id AS taskId, e.version, e.status, e.occurred_at AS at'

/** Redacted, read-only projections over the same durable tasks used by the local inbox. */
export function createMobileFeed(dbAccess: DatabaseAccess, scope: MobileDeviceScope, devices: MobileDeviceLedger) {
  const key = [scope.ownerId, scope.profileId] as const
  return Object.freeze({
    snapshot(credential: unknown) {
      if (!devices.authenticate(credential)) return fail('unauthorized')
      return dbAccess(db => {
        const latest = db.prepare(`SELECT ${eventFields} ${scopedEvents} ORDER BY e.sequence DESC LIMIT 1`).get(...key)
        const tasks = db.prepare(`SELECT record FROM tasks
          WHERE owner_id = ? AND profile_id = ? AND conversation_id IS NOT NULL
          ORDER BY (record ->> '$.updatedAt') DESC, rowid DESC LIMIT 64`).all(...key).map(row => {
          const task = taskSchema.parse(JSON.parse(String(row.record)))
          return { id: task.id, projectId: task.projectId, outcome: task.requestedOutcome, version: task.version, status: task.status }
        })
        return { ok: true, cursor: latest ? encodeCursor(eventSchema.parse(latest)) : null, tasks } as const
      })
    },
    replay(credential: unknown, input: unknown) {
      if (!devices.authenticate(credential)) return fail('unauthorized')
      const cursor = decodeCursor(input)
      if (!cursor && input !== null) return fail('snapshot_required')
      return dbAccess(db => {
        const anchor = cursor
          ? db.prepare(`SELECT e.sequence ${scopedEvents} AND e.task_id = ? AND e.version = ?`).get(...key, ...cursor.key)?.sequence
          : 0
        if (typeof anchor !== 'number') return fail('snapshot_required')
        const rows = db.prepare(`SELECT ${eventFields} ${scopedEvents} AND e.sequence > ?
          ORDER BY e.sequence LIMIT ?`).all(...key, anchor, replayWindow + 1)
        if (rows.length > replayWindow) return fail('snapshot_required')
        const events = rows.map(row => {
          const event = eventSchema.parse(row)
          return { type: 'task.updated', ...event, cursor: encodeCursor(event) } as const
        })
        return { ok: true, cursor: events.at(-1)?.cursor ?? cursor?.encoded ?? null, events } as const
      })
    },
  })
}

export type MobileFeed = ReturnType<typeof createMobileFeed>
