import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { readScopedArtifact, type SealedArtifact } from '../artifacts/store.js'
import {
  accountIdSchema,
  attemptIdSchema,
  conversationSchema,
  deliveryDestinationSchema,
  deliveryIdSchema,
  deliverySchema,
  generationSchema,
  nonEmptyTextSchema,
  utcInstantSchema,
  type AccountId,
  type Artifact,
  type ArtifactId,
  type Delivery,
  type DeliveryId,
  type UtcInstant,
} from '../domain/model.js'
import { workStateSchema, type WorkState } from '../domain/transitions.js'
import { verificationRecordSchema } from '../domain/verification.js'
import { recoveryMode } from '../storage/recovery-state.js'
import { StorageError, transaction } from '../storage/schema.js'
import type { WorkRef } from '../storage/store.js'

type DatabaseAccess = <T>(operation: (db: DatabaseSync) => T) => T
type Destination = Delivery['destination']
type Scope = Readonly<Pick<Delivery, 'ownerId' | 'profileId' | 'destination'>>
type Mode = 'send' | 'lookup'

interface ProviderRequest {
  readonly routeId: string
  readonly accountId: AccountId
  readonly deliveryId: DeliveryId
  readonly dedupeKey: string
  readonly destination: Readonly<Destination>
}

export interface OutboxAttachment {
  readonly id: ArtifactId
  readonly mediaType: string
  readonly bytes: Uint8Array
}

export interface OutboxSendRequest extends ProviderRequest {
  readonly payload: Readonly<{ text?: string; artifactIds: readonly ArtifactId[] }>
  readonly attachments: readonly OutboxAttachment[]
}

export interface OutboxLookupRequest extends ProviderRequest {
  readonly receiptId?: string
}

export interface OutboxRoute extends Scope {
  /** Stable route identity. Changing accounts requires a distinct binding. */
  readonly id: string
  readonly accountId: AccountId
  readonly provider: {
    /** Return correlated `accepted`, definitive `not_sent`, or `unknown`. */
    send(request: OutboxSendRequest): Promise<unknown>
    /**
     * Read back the exact account and delivery identity. A retryable
     * `not_sent` must rule out later acceptance of the original request.
     * An absent query result alone leaves the outcome uncertain.
     */
    lookup?(request: OutboxLookupRequest): Promise<unknown>
  }
}

export interface OutboxDisclosureRequest {
  readonly mode: Mode
  readonly ref: WorkRef
  readonly routeId: string
  readonly accountId: AccountId
  readonly delivery: Readonly<Delivery>
  readonly artifacts: readonly Readonly<Artifact>[]
}

export interface OutboxOptions {
  /** Trusted, synchronous policy callbacks. No network calls or store writes. */
  readonly resolveRoute: (scope: Scope) => OutboxRoute | undefined
  readonly allowDisclosure: (request: OutboxDisclosureRequest) => boolean
  readonly allowPrivateArtifacts?: (request: OutboxDisclosureRequest) => boolean
  readonly now?: () => UtcInstant
  readonly maxRetries?: number
  readonly retryDelayMs?: number
}

type FailureCode = 'not_found' | 'permission_denied' | 'stale_attempt' | 'busy' | 'blocked' | 'not_due'
  | 'reconciliation_required' | 'recovery_required' | 'readback_unavailable' | 'outcome_uncertain' | 'conflict'
type Failure = { ok: false; code: FailureCode }
export type OutboxResult = { ok: true; delivery: Delivery } | Failure

const responseIdentity = {
  deliveryId: deliveryIdSchema,
  dedupeKey: nonEmptyTextSchema,
  destination: deliveryDestinationSchema,
}
const responseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...responseIdentity, kind: z.enum(['accepted', 'delivered', 'read']), receiptId: nonEmptyTextSchema.max(256) }),
  z.strictObject({ ...responseIdentity, kind: z.literal('not_sent'), retryable: z.boolean() }),
  z.strictObject({ ...responseIdentity, kind: z.literal('absent') }),
  z.strictObject({ kind: z.literal('unknown') }),
])
type ProviderResponse = z.infer<typeof responseSchema>
type Positive = Extract<ProviderResponse, { receiptId: string }>
const positiveOrder = { accepted: 1, delivered: 2, read: 3 }
const MAX_ATTACHMENT_BYTES = 1024 * 1024
const routeIdSchema = nonEmptyTextSchema.max(256)

interface Row {
  readonly delivery: Delivery
  readonly record: string
  readonly position: number
  readonly attemptId: WorkState['attempt']['id']
  readonly generation: number
  readonly state: WorkState
  readonly originalDestination?: Destination
  readonly routeId?: string
  readonly accountId?: AccountId
}

interface Plan {
  readonly row: Row
  readonly routeId: string
  readonly accountId: AccountId
  readonly identity: ProviderRequest
  invoke(): Promise<unknown>
}

function deny(code: FailureCode): Failure {
  return { ok: false, code }
}

function decodeJson(record: unknown): unknown {
  if (typeof record !== 'string' || Buffer.byteLength(record) > 1024 * 1024) {
    throw new StorageError('corrupt', 'Invalid stored outbox record')
  }
  try {
    return JSON.parse(record)
  } catch {
    throw new StorageError('corrupt', 'Invalid stored outbox JSON')
  }
}

function loadRow(db: DatabaseSync, ref: WorkRef, id: DeliveryId): Row | undefined {
  const row = db.prepare(`
    SELECT o.record, o.rowid AS position, o.attempt_id, o.generation,
           t.record AS task, a.record AS attempt, c.record AS conversation, b.route_id, b.account_id
    FROM outbox o JOIN tasks t ON t.id = o.task_id
    LEFT JOIN attempts a ON a.task_id = t.id AND a.id = t.attempt_id
    LEFT JOIN conversations c ON c.id = t.conversation_id
      AND c.owner_id = t.owner_id AND c.profile_id = t.profile_id
    LEFT JOIN outbox_bindings b ON b.delivery_id = o.id
    WHERE o.id = ? AND o.task_id = ? AND o.owner_id = ? AND o.profile_id = ?
  `).get(id, ref.taskId, ref.ownerId, ref.profileId)
  if (!row) return undefined
  const delivery = deliverySchema.safeParse(decodeJson(row.record))
  const state = workStateSchema.safeParse({ task: decodeJson(row.task), attempt: decodeJson(row.attempt) })
  const conversation = row.conversation === null ? undefined : conversationSchema.safeParse(decodeJson(row.conversation))
  const attemptId = attemptIdSchema.safeParse(row.attempt_id)
  const generation = generationSchema.safeParse(row.generation)
  const routeId = row.route_id === null ? undefined : routeIdSchema.safeParse(row.route_id)
  const accountId = row.account_id === null ? undefined : accountIdSchema.safeParse(row.account_id)
  if (!delivery.success || !state.success || !attemptId.success || !generation.success
    || (conversation && !conversation.success) || (routeId && !routeId.success) || (accountId && !accountId.success)
    || Boolean(routeId) !== Boolean(accountId) || typeof row.position !== 'number'
    || !Number.isSafeInteger(row.position) || typeof row.record !== 'string') {
    throw new StorageError('corrupt', 'Stored outbox scope failed validation')
  }
  return {
    delivery: delivery.data,
    record: row.record,
    position: row.position,
    attemptId: attemptId.data,
    generation: generation.data,
    state: state.data,
    originalDestination: conversation?.data.originalDestination,
    routeId: routeId?.data,
    accountId: accountId?.data,
  }
}

function sameDestination(left: Destination, right: Destination | undefined): boolean {
  return left.sourceInstanceId === right?.sourceInstanceId
    && left.externalDestinationId === right.externalDestinationId
}

function canRetry(row: Row): boolean {
  const { task, attempt } = row.state
  return row.attemptId === attempt.id && row.generation === task.generation && row.generation === attempt.generation
    && !['cancelling', 'cancelled', 'reconciliation_required', 'failed'].includes(task.status)
}

function canSend(row: Row): boolean {
  return row.state.task.status !== 'paused' && canRetry(row)
}

function blocksEarlier(db: DatabaseSync, ref: WorkRef, row: Row): boolean {
  const { destination } = row.delivery
  return db.prepare(`
    SELECT 1 FROM outbox
    WHERE task_id = ? AND rowid < ?
      AND (record ->> '$.destination.sourceInstanceId') = ?
      AND (record ->> '$.destination.externalDestinationId') = ?
      AND (
        coalesce(record ->> '$.status', '') NOT IN ('pending', 'accepted', 'delivered', 'read', 'failed')
        OR ((record ->> '$.status') = 'pending' AND attempt_id = ? AND generation = ?)
      )
    LIMIT 1
  `).get(ref.taskId, row.position, destination.sourceInstanceId, destination.externalDestinationId,
    row.attemptId, row.generation) !== undefined
}

function attachmentsFor(db: DatabaseSync, ref: WorkRef, row: Row, mode: Mode): SealedArtifact[] | undefined {
  const { artifactIds } = row.delivery.payload
  if (artifactIds.length > 64 || artifactIds.length !== new Set(artifactIds).size) return undefined
  if (artifactIds.length === 0) return []
  const { task, attempt } = row.state
  const verificationRow = db.prepare(`
    SELECT record FROM work_verifications WHERE task_id = ? AND attempt_id = ? AND generation = ?
    ORDER BY version DESC LIMIT 1
  `).get(ref.taskId, row.attemptId, row.generation)
  if (!verificationRow) return undefined
  const verification = verificationRecordSchema.safeParse(decodeJson(verificationRow.record))
  if (!verification.success || verification.data.taskId !== ref.taskId
    || verification.data.attemptId !== row.attemptId || verification.data.generation !== row.generation) {
    throw new StorageError('corrupt', 'Stored delivery verification failed validation')
  }
  if (mode === 'send' && (task.status !== 'completed' || verification.data.version !== task.version)) return undefined
  const proofs = new Map(verification.data.artifacts.map(proof => [proof.id, proof]))
  const attachments: SealedArtifact[] = []
  let size = 0
  for (const id of artifactIds) {
    if (mode === 'send' && !attempt.artifactIds.includes(id)) return undefined
    const proof = proofs.get(id)
    const artifact = readScopedArtifact(db, ref, id)
    if (!artifact || artifact.artifact.attemptId !== row.attemptId || artifact.generation !== row.generation) return undefined
    if (proof?.version !== artifact.version || proof.digest !== artifact.artifact.contentHash) return undefined
    size += artifact.bytes.byteLength
    if (size > MAX_ATTACHMENT_BYTES) return undefined
    attachments.push(artifact)
  }
  return attachments
}

function baseDelivery(delivery: Delivery) {
  const { id, ownerId, profileId, destination, payload, dedupeKey, retries } = delivery
  return { id, ownerId, profileId, destination, payload, dedupeKey, retries }
}

function writeDelivery(db: DatabaseSync, row: Row, delivery: Delivery): OutboxResult {
  const record = JSON.stringify(delivery)
  const update = db.prepare('UPDATE outbox SET record = ? WHERE id = ? AND record = ?')
    .run(record, row.delivery.id, row.record)
  if (update.changes !== 1) return deny('conflict')
  return { ok: true, delivery }
}

function bindResponse(raw: unknown, identity: ProviderRequest): ProviderResponse | undefined {
  const parsed = responseSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const response = parsed.data
  if (response.kind === 'unknown') return response
  return response.deliveryId === identity.deliveryId && response.dedupeKey === identity.dedupeKey
    && sameDestination(response.destination, identity.destination) ? response : undefined
}

/** Same-writer delivery controller. The caller authenticates the supplied WorkRef. */
export function createOutbox(access: DatabaseAccess, options: OutboxOptions, permit = (_db: DatabaseSync) => true) {
  const active = new Set<DeliveryId>()
  const maxRetries = z.int().min(0).max(8).parse(options.maxRetries ?? 3)
  const retryDelayMs = z.int().min(1).max(300_000).parse(options.retryDelayMs ?? 5_000)
  const now = () => utcInstantSchema.parse(options.now?.() ?? new Date().toISOString())

  function authorize(db: DatabaseSync, ref: WorkRef, row: Row, mode: Mode) {
    const { ownerId, profileId, destination } = row.delivery
    if (!sameDestination(destination, row.originalDestination)) return undefined
    const attachments = attachmentsFor(db, ref, row, mode)
    if (!attachments) return undefined
    try {
      const route = options.resolveRoute({ ownerId, profileId, destination: Object.freeze({ ...destination }) })
      if (!route || route.ownerId !== ownerId || route.profileId !== profileId
        || !routeIdSchema.safeParse(route.id).success || !accountIdSchema.safeParse(route.accountId).success
        || !sameDestination(destination, route.destination)
        || (row.routeId !== undefined && (row.routeId !== route.id || row.accountId !== route.accountId))) return undefined
      const bound = {
        id: route.id,
        accountId: route.accountId,
        send: route.provider.send.bind(route.provider),
        lookup: route.provider.lookup?.bind(route.provider),
      }
      const request: OutboxDisclosureRequest = {
        mode,
        ref: { ...ref },
        routeId: bound.id,
        accountId: bound.accountId,
        delivery: structuredClone(row.delivery),
        artifacts: attachments.map(({ artifact }) => structuredClone(artifact)),
      }
      if (options.allowDisclosure(request) !== true || (attachments.some(({ artifact }) => artifact.visibility === 'private')
        && options.allowPrivateArtifacts?.(request) !== true)) return undefined
      return { route: bound, attachments }
    } catch {
      return undefined
    }
  }

  function plan(db: DatabaseSync, ref: WorkRef, id: DeliveryId, mode: Mode): Plan | OutboxResult {
    const row = loadRow(db, ref, id)
    if (!row) return deny('not_found')
    if (active.has(id)) return deny('busy')
    const delivery = row.delivery
    if (mode === 'send') {
      if (delivery.status === 'dispatching' || delivery.status === 'uncertain') return deny('reconciliation_required')
      if (delivery.status !== 'pending') return { ok: true, delivery }
      if (!permit(db)) return deny('recovery_required')
      if (!canSend(row)) return deny('stale_attempt')
      if (delivery.nextAttemptAt !== undefined && delivery.nextAttemptAt > now()) return deny('not_due')
      if (blocksEarlier(db, ref, row)) return deny('blocked')
    } else {
      if (delivery.status === 'pending' || delivery.status === 'failed' || delivery.status === 'read') return { ok: true, delivery }
      if (row.routeId === undefined) return deny('reconciliation_required')
    }
    const permitted = authorize(db, ref, row, mode)
    if (!permitted) return deny('permission_denied')
    const { route, attachments } = permitted
    const identity = Object.freeze({
      routeId: route.id,
      accountId: route.accountId,
      deliveryId: id,
      dedupeKey: delivery.dedupeKey,
      destination: Object.freeze({ ...delivery.destination }),
    })
    if (mode === 'lookup') {
      const { lookup } = route
      let lookupRow = row
      if (delivery.status === 'dispatching') {
        const uncertain = {
          ...baseDelivery(delivery),
          status: 'uncertain',
          reconciliation: { reason: 'The prior dispatch has no local provider receipt.' },
        } satisfies Delivery
        if (!writeDelivery(db, row, uncertain).ok) throw new StorageError('conflict', 'Outbox claim changed before readback')
        lookupRow = { ...row, delivery: uncertain, record: JSON.stringify(uncertain) }
      }
      if (!lookup) return deny('readback_unavailable')
      const request: OutboxLookupRequest = Object.freeze({
        ...identity, ...('receipt' in delivery ? { receiptId: delivery.receipt.providerReceiptId } : {}),
      })
      return { row: lookupRow, identity, routeId: route.id, accountId: route.accountId, invoke: () => lookup(request) }
    }

    if (row.routeId === undefined) {
      db.prepare('INSERT INTO outbox_bindings (delivery_id, route_id, account_id) VALUES (?, ?, ?)')
        .run(id, route.id, route.accountId)
    }
    const dispatching = { ...baseDelivery(delivery), status: 'dispatching' } satisfies Delivery
    const written = writeDelivery(db, row, dispatching)
    if (!written.ok) throw new StorageError('conflict', 'Outbox claim changed before commit')
    const request: OutboxSendRequest = Object.freeze({
      ...identity,
      payload: Object.freeze({ ...delivery.payload, artifactIds: Object.freeze([...delivery.payload.artifactIds]) }),
      attachments: Object.freeze(attachments.map(({ artifact, bytes }) => Object.freeze({
        id: artifact.id, mediaType: artifact.mediaType, bytes,
      }))),
    })
    const { send } = route
    return {
      row: { ...row, delivery: dispatching, record: JSON.stringify(dispatching) },
      identity,
      routeId: route.id,
      accountId: route.accountId,
      invoke: () => send(request),
    }
  }

  function retry(row: Row, retryable: boolean): Delivery {
    const base = baseDelivery(row.delivery)
    if (!retryable || !canRetry(row) || base.retries >= maxRetries) {
      return { ...base, status: 'failed', failureReason: 'The provider confirmed that the delivery was not sent.' }
    }
    const delay = Math.min(retryDelayMs * 2 ** base.retries, 300_000)
    const nextAttemptAt = utcInstantSchema.parse(new Date(Date.parse(now()) + delay).toISOString())
    return { ...base, status: 'pending', retries: base.retries + 1, nextAttemptAt }
  }

  function accept(db: DatabaseSync, row: Row, response: Positive): OutboxResult {
    const previous = row.delivery
    if ('receipt' in previous) {
      if (previous.receipt.providerReceiptId !== response.receiptId) return deny('outcome_uncertain')
      if (positiveOrder[previous.status] >= positiveOrder[response.kind]) return { ok: true, delivery: previous }
    }
    return writeDelivery(db, row, {
      ...baseDelivery(previous),
      status: response.kind,
      receipt: { providerReceiptId: response.receiptId, recordedAt: now() },
    })
  }

  async function run(ref: WorkRef, id: DeliveryId, mode: Mode): Promise<OutboxResult> {
    const planned = access(db => transaction(db, () => plan(db, ref, id, mode)))
    if ('ok' in planned) return planned
    active.add(id)
    try {
      let response: ProviderResponse | undefined
      try {
        // Invoke synchronously after the durable claim, outside the writer transaction.
        response = bindResponse(await planned.invoke(), planned.identity)
      } catch {
        response = undefined
      }
      return access(db => transaction(db, () => {
        const row = loadRow(db, ref, id)
        if (!row || row.record !== planned.row.record || row.routeId !== planned.routeId
          || row.accountId !== planned.accountId) return deny('conflict')
        if (response && 'receiptId' in response && (mode === 'lookup' || response.kind === 'accepted')) {
          return accept(db, row, response)
        }
        if (response?.kind === 'not_sent' && !('receipt' in row.delivery)) {
          return writeDelivery(db, row, retry(row, response.retryable && recoveryMode(db) !== 'restore'))
        }
        if ('receipt' in row.delivery) return deny('outcome_uncertain')
        return writeDelivery(db, row, {
          ...baseDelivery(row.delivery),
          status: 'uncertain',
          reconciliation: {
            reason: 'Provider outcome could not be confirmed.',
            ...(mode === 'lookup' ? { checkedAt: now() } : {}),
          },
        })
      }))
    } finally {
      active.delete(id)
    }
  }

  return Object.freeze({
    isActive: () => active.size > 0,
    deliver: (ref: WorkRef, id: DeliveryId) => run(ref, id, 'send'),
    refresh: (ref: WorkRef, id: DeliveryId) => run(ref, id, 'lookup'),
    reconcile: (ref: WorkRef, id: DeliveryId) => run(ref, id, 'lookup'),
  })
}
