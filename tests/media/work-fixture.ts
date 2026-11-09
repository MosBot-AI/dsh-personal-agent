import {
  attemptIdSchema, clientIdSchema, deviceIdSchema, mandateRefSchema, ownerIdSchema, profileIdSchema,
  projectSchema, taskIdSchema, utcInstantSchema,
} from '../../packages/personal-agent/src/domain/model.js'
import type { WorkStore } from '../../packages/personal-agent/src/storage/store.js'

export function createAttempt(store: WorkStore, label: string) {
  const scope = { ownerId: ownerIdSchema.parse('media-owner'), profileId: profileIdSchema.parse('media-profile') }
  const actor = { ...scope, role: 'owner' as const, clientId: clientIdSchema.parse('local'),
    deviceId: deviceIdSchema.parse('local'), policyVersion: 'media-test' }
  const project = projectSchema.parse({ ...scope, id: 'project-' + label, kind: 'project', title: 'Media fixture',
    purpose: 'Exercise media recovery', resourceRefs: [], status: 'active', successCriteria: ['Read back output'], planRevision: 1, milestones: [] })
  store.insertProject(project)
  const taskId = taskIdSchema.parse('task-' + label)
  const result = store.applyCommand({ type: 'work.create', commandId: 'create-' + label,
    payload: { projectId: project.id, requestedOutcome: 'Render media', constraints: [],
      acceptance: { criteria: ['Verify output'], requiresArtifact: false, requiresReceipt: false } } },
  {
    actor, at: utcInstantSchema.parse('2026-11-08T08:00:00.000Z'), projectId: project.id, newTaskId: taskId,
    newAttempt: { id: attemptIdSchema.parse('attempt-' + label),
      mandate: mandateRefSchema.parse({ ...scope, id: 'mandate-' + label, policyVersion: actor.policyVersion }) },
  })
  if (!result.ok) throw new Error(result.code)
  return { ...scope, taskId, attemptId: result.state.attempt.id, generation: result.state.attempt.generation }
}
