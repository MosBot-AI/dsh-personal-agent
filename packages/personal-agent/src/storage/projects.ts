import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { wouldCycle } from '../domain/dependencies.js'
import {
  commandIdSchema, nonEmptyTextSchema, projectIdSchema, projectSchema, taskIdSchema, taskSchema,
  utcInstantSchema, versionSchema, workerCursorSchema, type Project, type ProjectId, type Task, type TaskId,
} from '../domain/model.js'
import { planRevisionSchema, projectPlanDraftSchema, taskPrerequisitesSchema, workerPlanStepsSchema } from '../domain/projects.js'
import type { WorkState } from '../domain/transitions.js'
import { dispatchPermitted } from './recovery-state.js'
import { StorageError } from './schema.js'

type Scope = Pick<Project, 'ownerId' | 'profileId'>
const saveSchema = z.strictObject({
  projectId: projectIdSchema, commandId: commandIdSchema.max(256), expectedRevision: versionSchema.optional(),
  draft: projectPlanDraftSchema, rationale: nonEmptyTextSchema.max(4096), at: utcInstantSchema,
})
const MAX_REVISIONS = 512
const MAX_GRAPH_EDGES = 4096
const fail = <T extends string>(code: T) => ({ ok: false as const, code })

function parse<S extends z.ZodType>(schema: S, record: unknown): z.output<S> {
  try {
    if (typeof record === 'string') return schema.parse(JSON.parse(record))
  } catch { /* Only validated disk records enter the work service. */ }
  throw new StorageError('corrupt', 'Stored project plan metadata failed validation')
}

export function readPlan(db: DatabaseSync, scope: Scope, projectId: ProjectId) {
  const row = db.prepare('SELECT record FROM projects WHERE id = ? AND owner_id = ? AND profile_id = ?')
    .get(projectId, scope.ownerId, scope.profileId)
  return row && parse(projectSchema, row.record)
}

export function projectHistory(db: DatabaseSync, scope: Scope, projectId: ProjectId) {
  const project = readPlan(db, scope, projectId)
  if (!project) return undefined
  const rows = db.prepare('SELECT record FROM project_plan_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 20').all(projectId)
  return { project, revisions: rows.length === 0 ? [{ project }] : rows.map(row => parse(planRevisionSchema, row.record)) }
}

export function initialProject(db: DatabaseSync, scope: Scope, projectId: ProjectId) {
  const project = readPlan(db, scope, projectId)
  if (!project) return undefined
  const row = db.prepare('SELECT record FROM project_plan_revisions WHERE project_id = ? ORDER BY revision LIMIT 1').get(projectId)
  return row ? parse(planRevisionSchema, row.record).project : project
}

/** Called within the WorkStore writer transaction. */
export function saveProjectPlan(db: DatabaseSync, scope: Scope, raw: unknown) {
  const parsed = saveSchema.safeParse(raw)
  if (!parsed.success) return fail('invalid_input')
  if (!dispatchPermitted(db)) return fail('recovery_required')
  const { projectId, commandId, expectedRevision, draft, rationale, at } = parsed.data
  const current = readPlan(db, scope, projectId)
  if (!current && expectedRevision !== undefined) return fail('not_found')
  if (current) {
    const existing = db.prepare('SELECT fingerprint FROM project_plan_revisions WHERE project_id = ? AND command_id = ?')
      .get(projectId, commandId)
    const fingerprint = digest(parsed.data)
    if (existing) return existing.fingerprint === fingerprint ? { ok: true as const, project: current } : fail('command_conflict')
    if (expectedRevision === undefined) return fail('command_conflict')
    if (current.planRevision !== expectedRevision) return fail('version_conflict')
    const count = db.prepare('SELECT count(*) AS total FROM project_plan_revisions WHERE project_id = ?').get(projectId)?.total
    if (typeof count !== 'number' || count >= MAX_REVISIONS || !Number.isSafeInteger(current.planRevision + 1)) return fail('capacity')
    if (count === 0) db.prepare('INSERT INTO project_plan_revisions (project_id, revision, record) VALUES (?, ?, ?)')
      .run(projectId, current.planRevision, JSON.stringify({ project: current }))
  }
  const project = projectSchema.parse({
    ...(current ?? { id: projectId, ownerId: scope.ownerId, profileId: scope.profileId, kind: 'goal', status: 'active', resourceRefs: [] }),
    ...draft, reviewCadence: draft.reviewCadence, planRevision: current ? current.planRevision + 1 : 1,
  })
  if (current) db.prepare('UPDATE projects SET record = ? WHERE id = ? AND owner_id = ? AND profile_id = ?')
    .run(JSON.stringify(project), projectId, scope.ownerId, scope.profileId)
  else db.prepare('INSERT INTO projects (id, record) VALUES (?, ?)').run(projectId, JSON.stringify(project))
  db.prepare('INSERT INTO project_plan_revisions (project_id, revision, command_id, fingerprint, record) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, project.planRevision, commandId, digest(parsed.data), JSON.stringify({ project, rationale, recordedAt: at }))
  return { ok: true as const, project }
}

function digest({ at: _time, ...command }: z.infer<typeof saveSchema>): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex')
}

export function projectTasks(db: DatabaseSync, scope: Scope, projectId: ProjectId): Task[] {
  return db.prepare(`
    SELECT record FROM tasks WHERE project_id = ? AND owner_id = ? AND profile_id = ?
    ORDER BY rowid DESC LIMIT 64
  `).all(projectId, scope.ownerId, scope.profileId).map(row => parse(taskSchema, row.record))
}

export function prerequisites(db: DatabaseSync, task: Task) {
  return db.prepare(`
    SELECT p.prerequisite_id AS id, t.record ->> '$.status' AS status
    FROM task_prerequisites p JOIN tasks t ON t.id = p.prerequisite_id
    WHERE p.task_id = ? AND t.owner_id = ? AND t.profile_id = ? AND t.project_id = ? ORDER BY p.prerequisite_id
  `).all(task.id, task.ownerId, task.profileId, task.projectId).map(row => ({
    id: taskIdSchema.parse(row.id), completed: row.status === 'completed',
  }))
}

export function hasIncompletePrerequisite(db: DatabaseSync, task: Task): boolean {
  if (prerequisites(db, task).some(row => !row.completed)) return true
  // Existing explicit dependency waits predate the graph.
  if (task.wait?.reason !== 'dependency') return false
  return !db.prepare(`
    SELECT 1 FROM tasks WHERE id = ? AND owner_id = ? AND profile_id = ? AND project_id = ?
      AND (record ->> '$.status') = 'completed'
  `).get(task.wait.referenceId, task.ownerId, task.profileId, task.projectId)
}

export function dependentIds(db: DatabaseSync, task: Task): TaskId[] {
  return db.prepare(`
    SELECT t.id, 0 AS priority FROM task_prerequisites p JOIN tasks t ON t.id = p.task_id
    WHERE p.prerequisite_id = ? AND t.owner_id = ? AND t.profile_id = ? AND t.project_id = ?
    UNION ALL
    SELECT t.id, 1 AS priority FROM tasks t WHERE t.owner_id = ? AND t.profile_id = ? AND t.project_id = ?
      AND (t.record ->> '$.status') = 'blocked' AND (t.record ->> '$.wait.referenceId') = ?
      AND NOT EXISTS (SELECT 1 FROM task_prerequisites WHERE task_id = t.id)
    ORDER BY priority, id LIMIT 64
  `).all(task.id, task.ownerId, task.profileId, task.projectId, task.ownerId, task.profileId, task.projectId, task.id)
    .map(row => taskIdSchema.parse(row.id))
}

/** Validate the entire bounded graph before replacing one scoped prerequisite list. */
export function replacePrerequisites(db: DatabaseSync, task: Task, raw: unknown) {
  const parsed = taskPrerequisitesSchema.safeParse(raw)
  if (!parsed.success) return fail('invalid_input')
  const ids = parsed.data
  const scope = [task.ownerId, task.profileId, task.projectId] as const
  const member = db.prepare('SELECT 1 FROM tasks WHERE owner_id = ? AND profile_id = ? AND project_id = ? AND id = ?')
  if (ids.some(id => !member.get(...scope, id))) return fail('not_found')
  const count = db.prepare('SELECT count(*) AS total FROM task_prerequisites WHERE prerequisite_id = ? AND task_id <> ?')
  if (ids.some(id => Number(count.get(id, task.id)?.total) >= 32)) return fail('condition_unmet')
  const rows = db.prepare(`
    SELECT p.task_id AS from_id, p.prerequisite_id AS to_id
    FROM task_prerequisites p JOIN tasks t ON t.id = p.task_id
    WHERE t.owner_id = ? AND t.profile_id = ? AND t.project_id = ? AND t.id <> ?
    UNION
    SELECT t.id, t.record ->> '$.wait.referenceId'
    FROM tasks t JOIN tasks predecessor ON predecessor.id = (t.record ->> '$.wait.referenceId')
      AND predecessor.owner_id = t.owner_id AND predecessor.profile_id = t.profile_id AND predecessor.project_id = t.project_id
    WHERE t.owner_id = ? AND t.profile_id = ? AND t.project_id = ? AND t.id <> ?
      AND (t.record ->> '$.wait.reason') = 'dependency'
    LIMIT ?
  `).all(...scope, task.id, ...scope, task.id, MAX_GRAPH_EDGES + 1)
  if (rows.length + ids.length > MAX_GRAPH_EDGES) return fail('condition_unmet')
  const edges = new Map<TaskId, TaskId[]>()
  for (const row of rows) {
    const from = taskIdSchema.parse(row.from_id)
    const to = taskIdSchema.parse(row.to_id)
    const previous = edges.get(from)
    if (previous) previous.push(to)
    else edges.set(from, [to])
  }
  if (wouldCycle(task.id, ids, edges)) return fail('condition_unmet')
  db.prepare('DELETE FROM task_prerequisites WHERE task_id = ?').run(task.id)
  const insert = db.prepare('INSERT INTO task_prerequisites (task_id, prerequisite_id) VALUES (?, ?)')
  for (const id of ids) insert.run(task.id, id)
  return { ok: true as const }
}

export function recordWorkerPlan(db: DatabaseSync, state: WorkState, cursor: string, steps: unknown): boolean {
  const parsed = workerPlanStepsSchema.safeParse(steps)
  if (!parsed.success || !workerCursorSchema.safeParse(cursor).success || !dispatchPermitted(db)
    || state.task.status !== 'running' || state.attempt.worker?.inputCursor !== cursor) return false
  const { task, attempt } = state
  const written = db.prepare(`
    INSERT INTO task_plan_proposals (task_id, attempt_id, generation, cursor, record) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET attempt_id = excluded.attempt_id, generation = excluded.generation,
      cursor = excluded.cursor, record = excluded.record WHERE task_plan_proposals.attempt_id <> excluded.attempt_id
      OR task_plan_proposals.cursor <> excluded.cursor
  `).run(task.id, attempt.id, attempt.generation, cursor, JSON.stringify(parsed.data))
  return written.changes === 1
}

export function workerPlan(db: DatabaseSync, state: WorkState) {
  const { task, attempt } = state
  const cursor = attempt.worker?.inputCursor
  if (!cursor || task.generation !== attempt.generation
    || ['failed', 'cancelled', 'reconciliation_required'].includes(task.status)) return undefined
  const row = db.prepare(`
    SELECT record FROM task_plan_proposals WHERE task_id = ? AND attempt_id = ? AND generation = ? AND cursor = ?
  `).get(task.id, attempt.id, attempt.generation, cursor)
  return row ? { cursor, steps: parse(workerPlanStepsSchema, row.record) } : undefined
}
