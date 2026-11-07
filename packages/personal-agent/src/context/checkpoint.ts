import { z } from 'zod'
import {
  acceptanceSchema, artifactIdSchema, attemptIdSchema, generationSchema, nonEmptyTextSchema, ownerIdSchema,
  profileIdSchema, projectIdSchema, sessionIdSchema, sha256DigestSchema, sourceEventIdSchema, taskIdSchema,
  utcInstantSchema, versionSchema, waitReasonSchema,
} from '../domain/model.js'

export const MAX_CHECKPOINT_BYTES = 1024 * 1024
export const MAX_CHECKPOINT_POINTERS = 64

const taskPointerSchema = z.strictObject({ kind: z.literal('task'), taskId: taskIdSchema })
const eventPointerSchema = z.strictObject({ kind: z.literal('event'), eventId: sourceEventIdSchema })
const artifactPointerSchema = z.strictObject({ kind: z.literal('artifact'), artifactId: artifactIdSchema })

export const contextEvidencePointerSchema = z.discriminatedUnion('kind', [eventPointerSchema, artifactPointerSchema])
export const contextPointerSchema = z.discriminatedUnion('kind', [taskPointerSchema, eventPointerSchema, artifactPointerSchema])
export type ContextEvidencePointer = z.infer<typeof contextEvidencePointerSchema>
export type ContextPointer = z.infer<typeof contextPointerSchema>

export function contextPointerId(pointer: ContextPointer): string {
  switch (pointer.kind) {
    case 'task': return pointer.taskId
    case 'event': return pointer.eventId
    case 'artifact': return pointer.artifactId
  }
}

export function contextPointerKey(pointer: ContextPointer): string {
  return JSON.stringify([pointer.kind, contextPointerId(pointer)])
}

function distinctPointers(pointers: readonly ContextPointer[]): boolean {
  return new Set(pointers.map(contextPointerKey)).size === pointers.length
}

const contextPointersSchema = z.array(contextPointerSchema).max(MAX_CHECKPOINT_POINTERS).refine(distinctPointers)
const statementsSchema = z.array(z.strictObject({
  text: nonEmptyTextSchema.max(8192),
  sources: z.array(contextEvidencePointerSchema).min(1).max(8).refine(distinctPointers),
})).max(24)

const compactionIdSchema = z.string().min(1).max(256).regex(/^[^\s\p{Cc}]+$/u)
const captureFields = {
  sessionId: sessionIdSchema,
  compactionId: compactionIdSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  nativeSeq: z.int().nonnegative().optional(),
}

export const checkpointCaptureSchema = z.strictObject({
  ...captureFields,
  expectedVersion: versionSchema,
  at: utcInstantSchema,
  decisions: statementsSchema.optional(),
  questions: statementsSchema.optional(),
  pointers: contextPointersSchema.optional(),
})

export const contextCheckpointSchema = z.strictObject({
  ...captureFields,
  id: sha256DigestSchema,
  revision: z.int().positive(),
  ownerId: ownerIdSchema,
  profileId: profileIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  taskVersion: versionSchema,
  createdAt: utcInstantSchema,
  objective: nonEmptyTextSchema,
  constraints: z.array(nonEmptyTextSchema),
  acceptance: acceptanceSchema,
  wait: waitReasonSchema.optional(),
  decisions: statementsSchema,
  questions: statementsSchema,
  pointers: contextPointersSchema,
})
export type ContextCheckpoint = z.infer<typeof contextCheckpointSchema>

export const contextExclusionSchema = z.strictObject({
  kind: z.enum(['superseded', 'forgotten']),
  at: utcInstantSchema,
})
export type ContextExclusion = z.infer<typeof contextExclusionSchema>

export type CheckpointCaptureResult = { ok: true; checkpoint: ContextCheckpoint; replayed: boolean }
  | { ok: false; code: 'invalid_input' | 'not_found' | 'stale_attempt' | 'version_conflict' | 'source_unavailable'
    | 'checkpoint_conflict' | 'recovery_required' }

export type ContextExclusionResult = { ok: true; exclusion: ContextExclusion; replayed: boolean }
  | { ok: false; code: 'invalid_input' | 'not_found' | 'source_unavailable' | 'version_conflict' | 'recovery_required' }
