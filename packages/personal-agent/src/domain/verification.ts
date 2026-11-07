import { z } from 'zod'
import type { SealedArtifact } from '../artifacts/store.js'
import type { StoredWorkResult, WorkRef } from '../storage/store.js'
import {
  artifactIdSchema,
  attemptIdSchema,
  deliverySchema,
  generationSchema,
  nonEmptyTextSchema,
  operationIdSchema,
  providerReceiptSchema,
  sha256DigestSchema,
  taskIdSchema,
  utcInstantSchema,
  versionSchema,
  type ArtifactId,
  type Delivery,
  type Effect,
  type OperationId,
  type UtcInstant,
} from './model.js'
import type { WorkState } from './transitions.js'

const MAX_VERIFICATION_BYTES = 1024 * 1024
const MAX_ARTIFACTS = 64
const criterionSchema = z.strictObject({
  criterion: nonEmptyTextSchema,
  satisfied: z.boolean(),
  evidence: nonEmptyTextSchema.max(2_048),
})
const criteriaSchema = z.array(criterionSchema).min(1)
const artifactProofSchema = z.strictObject({
  id: artifactIdSchema,
  version: z.int().positive(),
  digest: sha256DigestSchema,
})
const effectProofSchema = providerReceiptSchema.extend({ operationId: operationIdSchema })

export const verificationRecordSchema = z.strictObject({
  taskId: taskIdSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  version: versionSchema,
  verifiedAt: utcInstantSchema,
  criteria: criteriaSchema.refine(criteria => criteria.every(criterion => criterion.satisfied)),
  artifacts: z.array(artifactProofSchema).max(MAX_ARTIFACTS),
  effectReceipt: effectProofSchema.optional(),
})

const requestSchema = z.strictObject({
  expectedVersion: versionSchema,
  effectOperationId: operationIdSchema.optional(),
  deliveries: z.array(deliverySchema).max(64).optional(),
})

export type VerificationRecord = z.infer<typeof verificationRecordSchema>
type Criteria = VerificationRecord['criteria']
type EffectProof = NonNullable<VerificationRecord['effectReceipt']>

export interface VerificationView {
  readonly state: WorkState
  readonly artifacts: readonly SealedArtifact[]
  readonly effectReceipt?: EffectProof
}

export interface VerificationOptions {
  /** Trusted verifier of the actual bytes and outcome. Return redacted criterion evidence. */
  readonly check: (view: VerificationView) => unknown | Promise<unknown>
  readonly now?: () => UtcInstant
}

export interface VerificationCommit {
  readonly expectedVersion: number
  readonly attemptId: WorkState['attempt']['id']
  readonly generation: number
  readonly at: UtcInstant
  readonly criteria: Criteria
  readonly artifacts: VerificationRecord['artifacts']
  readonly effectReceipt?: EffectProof
  readonly deliveries?: Delivery[]
}

interface VerificationPort {
  readWork(ref: WorkRef): WorkState | undefined
  readArtifact(ref: WorkRef, id: ArtifactId): SealedArtifact | undefined
  readEffect(ref: WorkRef, id: OperationId): Effect | undefined
  commit(ref: WorkRef, evidence: VerificationCommit): StoredWorkResult
}

/** Read exact scoped versions and their validated bytes. The caller supplies the scoped reader. */
export function collectArtifacts(
  state: WorkState,
  ids: readonly ArtifactId[],
  read: (id: ArtifactId) => SealedArtifact | undefined,
): SealedArtifact[] | undefined {
  if (ids.length > MAX_ARTIFACTS || new Set(ids).size !== ids.length
    || (state.task.acceptance.requiresArtifact && ids.length === 0)) return undefined
  const artifacts: SealedArtifact[] = []
  let bytes = 0
  for (const id of ids) {
    const item = read(id)
    if (!item || item.artifact.id !== id || item.artifact.attemptId !== state.attempt.id
      || item.artifact.ownerId !== state.task.ownerId || item.artifact.profileId !== state.task.profileId
      || item.taskId !== state.task.id || item.generation !== state.attempt.generation) return undefined
    bytes += item.bytes.byteLength
    if (bytes > MAX_VERIFICATION_BYTES) return undefined
    artifacts.push(item)
  }
  return artifacts
}

export function artifactProofs(artifacts: readonly SealedArtifact[]): VerificationRecord['artifacts'] {
  return artifacts.map(item => ({ id: item.artifact.id, version: item.version, digest: item.artifact.contentHash }))
}

export function exactEffectReceipt(state: WorkState, effect: Effect | undefined): EffectProof | undefined {
  if (effect?.status !== 'confirmed' || effect.taskId !== state.task.id
    || effect.attemptId !== state.attempt.id || effect.generation !== state.attempt.generation) return undefined
  return { operationId: effect.operationId, ...effect.receipt }
}

export function criteriaSatisfied(state: WorkState, results: Criteria): boolean {
  const expected = state.task.acceptance.criteria
  return expected.length === results.length
    && results.every((result, index) => result.satisfied && result.criterion === expected[index])
}

export function readyToVerify(state: WorkState): boolean {
  return state.task.status === 'verifying'
    && (state.attempt.worker === undefined || state.attempt.worker.releasedAt !== undefined)
}

export function createVerifier(port: VerificationPort, options: VerificationOptions) {
  const { check } = options
  const now = options.now ?? (() => utcInstantSchema.parse(new Date().toISOString()))
  return Object.freeze({
    async verify(ref: WorkRef, input: unknown): Promise<StoredWorkResult> {
      try {
        const serialized = JSON.stringify(input)
        if (serialized === undefined || Buffer.byteLength(serialized) > MAX_VERIFICATION_BYTES) {
          return { ok: false, code: 'invalid_input' }
        }
      } catch {
        return { ok: false, code: 'invalid_input' }
      }
      const decoded = requestSchema.safeParse(input)
      if (!decoded.success) return { ok: false, code: 'invalid_input' }
      const target = { ...ref }
      const request = decoded.data
      const state = port.readWork(target)
      if (!state) return { ok: false, code: 'not_found' }
      if (state.task.version !== request.expectedVersion) return { ok: false, code: 'version_conflict' }
      if (!readyToVerify(state)) return { ok: false, code: 'invalid_transition' }
      const artifacts = collectArtifacts(state, state.attempt.artifactIds, id => port.readArtifact(target, id))
      const effectReceipt = request.effectOperationId === undefined
        ? undefined
        : exactEffectReceipt(state, port.readEffect(target, request.effectOperationId))
      if (!artifacts || ((request.effectOperationId !== undefined || state.task.acceptance.requiresReceipt) && !effectReceipt)) {
        return { ok: false, code: 'acceptance_unsatisfied' }
      }
      const proof = artifactProofs(artifacts)
      let checked: unknown
      try {
        checked = await check(structuredClone({ state, artifacts, effectReceipt }))
      } catch {
        return { ok: false, code: 'acceptance_unsatisfied' }
      }
      const criteria = criteriaSchema.safeParse(checked)
      if (!criteria.success || !criteriaSatisfied(state, criteria.data)) return { ok: false, code: 'acceptance_unsatisfied' }
      return port.commit(target, {
        expectedVersion: request.expectedVersion,
        attemptId: state.attempt.id,
        generation: state.attempt.generation,
        at: now(),
        criteria: criteria.data,
        artifacts: proof,
        effectReceipt,
        deliveries: request.deliveries,
      })
    },
  })
}
