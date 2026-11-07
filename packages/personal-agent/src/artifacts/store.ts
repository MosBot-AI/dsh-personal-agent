import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  artifactIdSchema,
  artifactSchema,
  attemptIdSchema,
  generationSchema,
  sourceEventIdSchema,
  taskIdSchema,
  versionSchema,
  type ArtifactId,
} from '../domain/model.js'
import { StorageError, transaction } from '../storage/schema.js'
import type { WorkRef } from '../storage/store.js'

const MAX_ARTIFACT_BYTES = 256 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const mediaTypeSchema = z.enum(['text/plain', 'text/markdown', 'application/json'])
type MediaType = z.infer<typeof mediaTypeSchema>

const sealSchema = z.strictObject({
  id: artifactIdSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  expectedVersion: versionSchema,
  mediaType: mediaTypeSchema,
  sourceEventIds: z.array(sourceEventIdSchema).max(64).refine(ids => new Set(ids).size === ids.length),
  visibility: artifactSchema.shape.visibility,
  previousId: artifactIdSchema.optional(),
  bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= MAX_ARTIFACT_BYTES),
})

const artifactRecordSchema = z.strictObject({
  artifact: artifactSchema,
  taskId: taskIdSchema,
  generation: generationSchema,
  version: versionSchema.min(1),
  previousId: artifactIdSchema.optional(),
})

export type SealedArtifact = z.infer<typeof artifactRecordSchema> & { bytes: Uint8Array }
type DatabaseAccess = <T>(fn: (db: DatabaseSync) => T) => T

export interface ArtifactStore {
  seal(ref: WorkRef, input: unknown): SealedArtifact
  preparePrivate(ref: WorkRef, input: unknown): SealedArtifact
  read(ref: WorkRef, artifactId: ArtifactId): SealedArtifact | undefined
}

function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function storageRef(id: ArtifactId): string {
  return `sqlite:artifact:${id}`
}

function validContent(bytes: Uint8Array, mediaType: MediaType): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) return false
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (!text.trim() || text.includes('\0')) return false
    if (mediaType === 'application/json') JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function corrupt(): never {
  throw new StorageError('corrupt', 'Stored artifact failed integrity validation')
}

function readRecord(value: unknown): z.infer<typeof artifactRecordSchema> {
  if (typeof value !== 'string' || value.length > MAX_RECORD_BYTES || Buffer.byteLength(value) > MAX_RECORD_BYTES) return corrupt()
  try {
    return artifactRecordSchema.parse(JSON.parse(value))
  } catch {
    return corrupt()
  }
}

/** Read only from the authenticated work scope and verify the persisted bytes. */
export function readScopedArtifact(db: DatabaseSync, ref: WorkRef, artifactId: ArtifactId): SealedArtifact | undefined {
  const row = db.prepare(`
    SELECT a.record, a.content, a.attempt_id, a.generation, a.version, a.previous_id,
           p.version AS previous_version
    FROM artifacts a LEFT JOIN artifacts p ON p.id = a.previous_id
      AND p.owner_id = a.owner_id AND p.profile_id = a.profile_id AND p.task_id = a.task_id
    WHERE a.id = ? AND a.owner_id = ? AND a.profile_id = ? AND a.task_id = ?
  `).get(artifactId, ref.ownerId, ref.profileId, ref.taskId)
  if (!row) return undefined

  const record = readRecord(row.record)
  const { artifact, taskId, generation, version, previousId } = record
  if (taskId !== ref.taskId || artifact.ownerId !== ref.ownerId || artifact.profileId !== ref.profileId
    || artifact.id !== artifactId || artifact.attemptId !== row.attempt_id || generation !== row.generation
    || version !== row.version || (previousId ?? null) !== row.previous_id
    || artifact.storageRef !== storageRef(artifact.id)
    || (previousId === undefined ? version !== 1 : typeof row.previous_version !== 'number' || version !== row.previous_version + 1)) {
    return corrupt()
  }

  const mediaType = mediaTypeSchema.safeParse(artifact.mediaType)
  const content = row.content
  if (!mediaType.success || !(content instanceof Uint8Array)
    || !validContent(content, mediaType.data) || contentHash(content) !== artifact.contentHash) return corrupt()
  return { ...record, bytes: new Uint8Array(content) }
}

export function createArtifactStore(access: DatabaseAccess): ArtifactStore {
  function seal(ref: WorkRef, input: unknown, privatePreparation = false): SealedArtifact {
    const parsed = sealSchema.safeParse(input)
    if (!parsed.success) throw new StorageError('invalid_input', 'Invalid artifact input')
    const { id, attemptId, generation, expectedVersion, mediaType, sourceEventIds, visibility, previousId } = parsed.data
    if (privatePreparation && visibility !== 'private') throw new StorageError('invalid_input', 'Preparation must remain private')
    const bytes = new Uint8Array(parsed.data.bytes)
    if (!validContent(bytes, mediaType)) throw new StorageError('invalid_input', 'Invalid artifact content for its media type')
    const artifact = artifactSchema.parse({
      id,
      ownerId: ref.ownerId,
      profileId: ref.profileId,
      attemptId,
      contentHash: contentHash(bytes),
      storageRef: storageRef(id),
      mediaType,
      provenance: { sourceEventIds },
      visibility,
    })
    const metadata = {
      artifact, taskId: ref.taskId, generation,
      ...(previousId === undefined ? {} : { previousId }),
    }
    if (Buffer.byteLength(JSON.stringify({ ...metadata, version: Number.MAX_SAFE_INTEGER })) > MAX_RECORD_BYTES) {
      throw new StorageError('invalid_input', 'Artifact metadata exceeds the size limit')
    }

    return access(db => transaction(db, () => {
      const state = db.prepare(`
        SELECT t.version, t.generation, t.attempt_id, a.generation AS attempt_generation,
               t.record ->> '$.status' AS task_status, a.status AS attempt_status
        FROM tasks t JOIN attempts a ON a.id = t.attempt_id AND a.task_id = t.id
        WHERE t.id = ? AND t.owner_id = ? AND t.profile_id = ?
      `).get(ref.taskId, ref.ownerId, ref.profileId)
      if (!state || state.attempt_id !== attemptId || state.generation !== generation || state.attempt_generation !== generation
        || (state.task_status !== 'running' && state.task_status !== 'verifying'
          && !(privatePreparation && state.task_status === 'queued')) || state.task_status !== state.attempt_status) {
        throw new StorageError('stale_attempt', 'Artifact producer does not match the current attempt')
      }
      if (state.version !== expectedVersion) throw new StorageError('version_conflict', 'Task version changed before sealing the artifact')

      const source = db.prepare('SELECT 1 FROM source_events WHERE id = ? AND owner_id = ? AND profile_id = ?')
      if (sourceEventIds.some(sourceId => source.get(sourceId, ref.ownerId, ref.profileId) === undefined)) {
        throw new StorageError('invalid_input', 'Artifact provenance is unavailable in this scope')
      }
      const previous = previousId === undefined ? undefined : readScopedArtifact(db, ref, previousId)
      if (previousId !== undefined && previous === undefined) {
        throw new StorageError('invalid_input', 'The previous artifact version is unavailable in this scope')
      }
      const version = (previous?.version ?? 0) + 1
      if (!Number.isSafeInteger(version)) throw new StorageError('conflict', 'Artifact version limit reached')
      const record = { ...metadata, version }
      db.prepare(`
        INSERT INTO artifacts (id, owner_id, profile_id, task_id, attempt_id, generation, previous_id, version, record, content)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, ref.ownerId, ref.profileId, ref.taskId, attemptId, generation, previousId ?? null, version, JSON.stringify(record), bytes)
      return { ...record, bytes }
    }))
  }

  return Object.freeze<ArtifactStore>({
    seal: (ref, input) => seal(ref, input),
    preparePrivate: (ref, input) => seal(ref, input, true),
    read(ref, artifactId) {
      return access(db => readScopedArtifact(db, ref, artifactId))
    },
  })
}
