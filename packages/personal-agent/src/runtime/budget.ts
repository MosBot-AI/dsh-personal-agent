import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import {
  attemptIdSchema, generationSchema, nonEmptyTextSchema, ownerIdSchema, profileIdSchema, taskIdSchema,
  utcInstantSchema, versionSchema, type UtcInstant,
} from '../domain/model.js'
import { StorageError, transaction } from '../storage/schema.js'

// A sum of this many safe-integer rows fits SQLite's signed INTEGER.
const MAX_CALLS = 1_024
const MAX_TOKENS = 16_777_216
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MILLION = 1_000_000n
const scopeSchema = z.strictObject({ ownerId: ownerIdSchema, profileId: profileIdSchema })
const money = z.int().nonnegative()
const tokens = z.int().min(0).max(MAX_TOKENS)
const routeId = nonEmptyTextSchema.max(256)
const currency = z.string().regex(/^[A-Z]{3}$/u).nullable()
const taskFenceSchema = z.strictObject({
  taskId: taskIdSchema, attemptId: attemptIdSchema, generation: generationSchema, expectedVersion: versionSchema,
})
const knownPricing = z.strictObject({
  kind: z.literal('known'),
  inputMicrosPerMillion: money,
  outputMicrosPerMillion: money,
  cacheReadMicrosPerMillion: money,
  cacheWriteMicrosPerMillion: money,
  ceilingMicros: money,
})
const pricingSchema = z.discriminatedUnion('kind', [knownPricing, z.strictObject({ kind: z.literal('unknown') })])
const routeSchema = z.strictObject({ provider: routeId, model: routeId, currency, pricing: pricingSchema })
  .refine(route => route.currency !== null || route.pricing.kind === 'unknown' || [
    route.pricing.inputMicrosPerMillion, route.pricing.outputMicrosPerMillion,
    route.pricing.cacheReadMicrosPerMillion, route.pricing.cacheWriteMicrosPerMillion, route.pricing.ceilingMicros,
  ].every(rate => rate === 0), 'Paid routes require an explicit currency')
const limitSchema = z.strictObject({
  currency, ownerDayMicros: money, taskMicros: money,
  maxCallsPerDay: z.int().min(1).max(MAX_CALLS),
  maxCallsPerTask: z.int().min(1).max(MAX_CALLS),
  maxConcurrent: z.int().min(1).max(32),
}).refine(limit => limit.currency !== null || (limit.ownerDayMicros === 0 && limit.taskMicros === 0))

function key(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

export const budgetConfigSchema = z.strictObject({
  pricingVersion: routeId,
  routes: z.array(routeSchema).max(64),
  limits: z.array(limitSchema).max(16),
}).refine(config => {
  const currencies = new Set(config.limits.map(limit => limit.currency))
  return currencies.size === config.limits.length
    && new Set(config.routes.map(route => key(route.provider, route.model))).size === config.routes.length
    && config.routes.every(route => currencies.has(route.currency))
}, 'Budget configuration requires unique routes and exactly one limit per used currency')

export type BudgetConfig = z.infer<typeof budgetConfigSchema>
export type BudgetOptions = BudgetConfig & { readonly now?: () => UtcInstant }
type Scope = z.infer<typeof scopeSchema>
type Pricing = z.infer<typeof pricingSchema>
type KnownPricing = z.infer<typeof knownPricing>
type Route = z.infer<typeof routeSchema>
type Limit = z.infer<typeof limitSchema>
const requestSchema = scopeSchema.extend({
  provider: routeId,
  model: routeId,
  unattended: z.boolean(),
  task: taskFenceSchema.optional(),
  upperInputTokens: tokens,
  upperOutputTokens: tokens.min(1),
})
export type BudgetRequest = z.infer<typeof requestSchema>

const usageSchema = z.strictObject({
  inputTokens: tokens,
  outputTokens: tokens,
  cacheReadTokens: tokens.optional(),
  cacheWriteTokens: tokens.optional(),
  totalTokens: z.int().min(0).max(4 * MAX_TOKENS).optional(),
  reasoningTokens: tokens.optional(),
}).refine(usage => usage.totalTokens === undefined || usage.totalTokens === (
  usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
), 'Reported total does not match disjoint token counts')
export type BudgetUsage = z.infer<typeof usageSchema>

const reservationRefSchema = z.object({ ...scopeSchema.shape, id: z.uuid() })
export type BudgetReservationRef = z.infer<typeof reservationRefSchema>
const status = z.enum(['reserved', 'claimed', 'settled', 'uncertain', 'released'])
const reservationSchema = requestSchema.extend({
  id: z.uuid(),
  currency,
  pricingVersion: routeId,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
  status,
  estimateMicros: money.nullable(),
  actualMicros: money.nullable(),
  usage: usageSchema.optional(),
})
export type BudgetReservation = z.infer<typeof reservationSchema>

type Failure = {
  ok: false
  code: 'invalid_input' | 'pricing_unavailable' | 'budget_exceeded' | 'capacity'
    | 'stale_attempt' | 'recovery_required' | 'not_found' | 'invalid_transition'
}
type ReservationResult = { ok: true; reservation: BudgetReservation } | Failure
type ClaimParticipant = (db: DatabaseSync, reservation: Readonly<BudgetReservation>) => boolean
const routedClaims = new WeakMap<object, (input: unknown, participant: ClaimParticipant) => ReservationResult>()

/** Internal handoff for a routed claim that shares Core's exact budget transaction. */
export function claimRoutedBudget(budget: BudgetService, input: unknown, participant: ClaimParticipant): ReservationResult {
  return routedClaims.get(budget)?.(input, participant) ?? fail('invalid_transition')
}

type Admission = { ok: true; route: Route; limit: Limit } | Failure
type Access = <T>(fn: (db: DatabaseSync) => T) => T
type Permit = (db: DatabaseSync) => boolean

export interface BudgetCurrencyUsage {
  readonly currency: string | null
  readonly spentMicros: number
  readonly heldMicros: number
  readonly reservedMicros: number
  readonly uncertainMicros: number
  readonly olderHeldMicros: number
  readonly calls: number
  readonly unknownCostCalls: number
  readonly unknownUsageCalls: number
  readonly reservedCalls: number
  readonly claimedCalls: number
  readonly uncertainCalls: number
  readonly olderUnresolvedCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly overflow: boolean
}

export interface BudgetSnapshot {
  readonly day: string
  readonly dayBasis: 'utc'
  readonly currencies: readonly BudgetCurrencyUsage[]
}

function fail(code: Failure['code']): Failure {
  return { ok: false, code }
}

function dayOf(at: UtcInstant): string {
  return at.slice(0, 10)
}

function scalar(db: DatabaseSync, query: string, ...args: SQLInputValue[]): bigint {
  const statement = db.prepare(query)
  statement.setReadBigInts(true)
  const value = statement.get(...args)?.value
  if (typeof value !== 'bigint') throw new StorageError('corrupt', 'Budget aggregate is invalid')
  return value
}

function quote(input: BudgetRequest, price: KnownPricing): bigint {
  const rate = Math.max(price.inputMicrosPerMillion, price.cacheReadMicrosPerMillion, price.cacheWriteMicrosPerMillion)
  const numerator = BigInt(input.upperInputTokens) * BigInt(rate)
    + BigInt(input.upperOutputTokens) * BigInt(price.outputMicrosPerMillion)
  return (numerator + MILLION - 1n) / MILLION
}

function cost(usage: BudgetUsage, price: KnownPricing): bigint {
  const numerator = BigInt(usage.inputTokens) * BigInt(price.inputMicrosPerMillion)
    + BigInt(usage.outputTokens) * BigInt(price.outputMicrosPerMillion)
    + BigInt(usage.cacheReadTokens ?? 0) * BigInt(price.cacheReadMicrosPerMillion)
    + BigInt(usage.cacheWriteTokens ?? 0) * BigInt(price.cacheWriteMicrosPerMillion)
  return (numerator + MILLION - 1n) / MILLION
}

function currentTask(db: DatabaseSync, input: BudgetRequest, preflight: boolean): boolean {
  const task = input.task
  return !task || db.prepare(`
    SELECT 1 FROM tasks t JOIN attempts a ON a.task_id = t.id AND a.id = t.attempt_id
    WHERE t.id = ? AND t.owner_id = ? AND t.profile_id = ? AND t.attempt_id = ?
      AND t.generation = ? AND a.generation = ? AND t.version = ?
      AND (
        ((t.record ->> '$.status') = 'running' AND a.status = 'running')
        OR (? = 1 AND (
          ((t.record ->> '$.status') IN ('queued', 'paused') AND a.status = (t.record ->> '$.status'))
          OR ((t.record ->> '$.status') IN ('waiting_input', 'waiting_event', 'waiting_approval',
            'waiting_environment', 'waiting_resource', 'blocked') AND a.status = 'waiting')
        ))
      )
  `).get(task.taskId, input.ownerId, input.profileId, task.attemptId, task.generation, task.generation,
    task.expectedVersion, Number(preflight)) !== undefined
}

const open = "'reserved', 'claimed', 'uncertain'"

function withinLimits(db: DatabaseSync, input: BudgetRequest, day: string, route: Route, limit: Limit, except: string | null): Admission {
  const { ownerId, task } = input
  if (db.prepare(`
    SELECT 1 FROM budget_reservations WHERE owner_id = ? AND day > ? AND status <> 'released' LIMIT 1
  `).get(ownerId, day)) return fail('budget_exceeded')
  const ownerCalls = scalar(db, `
    SELECT COUNT(*) AS value FROM budget_reservations
    WHERE owner_id = ? AND day = ? AND status <> 'released' AND id IS NOT ?
  `, ownerId, day, except)
  if (ownerCalls >= BigInt(limit.maxCallsPerDay)) return fail('budget_exceeded')
  if (task) {
    const calls = scalar(db, `
      SELECT COUNT(*) AS value FROM budget_reservations WHERE task_id = ? AND status <> 'released' AND id IS NOT ?
    `, task.taskId, except)
    if (calls >= BigInt(limit.maxCallsPerTask)) return fail('budget_exceeded')
  }
  const running = scalar(db, `
    SELECT COUNT(*) AS value FROM budget_reservations
    WHERE owner_id = ? AND status IN ('reserved', 'claimed') AND id IS NOT ?
  `, ownerId, except)
  const outstanding = scalar(db, `
    SELECT COUNT(*) AS value FROM budget_reservations WHERE owner_id = ? AND status IN (${open}) AND id IS NOT ?
  `, ownerId, except)
  if (running >= BigInt(limit.maxConcurrent) || outstanding >= BigInt(MAX_CALLS)) return fail('capacity')
  if (route.pricing.kind === 'unknown') return { ok: true, route, limit }

  const ceiling = BigInt(route.pricing.ceilingMicros)
  if (ceiling > 0n && db.prepare(`
    SELECT 1 FROM budget_reservations
    WHERE owner_id = ? AND (currency IS ? OR currency IS NULL) AND ceiling_micros IS NULL
      AND status <> 'released' AND (day = ? OR status IN (${open}) OR task_id = ?)
    LIMIT 1
  `).get(ownerId, route.currency, day, task?.taskId ?? null)) return fail('budget_exceeded')
  const spent = scalar(db, `
    SELECT COALESCE(SUM(actual_micros), 0) AS value FROM budget_reservations
    WHERE owner_id = ? AND day = ? AND currency IS ? AND status = 'settled' AND status <> 'released'
  `, ownerId, day, route.currency)
  const held = scalar(db, `
    SELECT COALESCE(SUM(ceiling_micros), 0) AS value FROM budget_reservations
    WHERE owner_id = ? AND currency IS ? AND status IN (${open}) AND id IS NOT ?
  `, ownerId, route.currency, except)
  if (spent + held + ceiling > BigInt(limit.ownerDayMicros)) return fail('budget_exceeded')
  if (task) {
    const amount = scalar(db, `
      SELECT COALESCE(SUM(COALESCE(actual_micros, ceiling_micros)), 0) AS value FROM budget_reservations
      WHERE task_id = ? AND currency IS ? AND status <> 'released' AND id IS NOT ?
    `, task.taskId, route.currency, except)
    if (amount + ceiling > BigInt(limit.taskMicros)) return fail('budget_exceeded')
  }
  return { ok: true, route, limit }
}

function readJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 8_192) throw new StorageError('corrupt', 'Invalid budget record encoding')
  try {
    return JSON.parse(value)
  } catch {
    throw new StorageError('corrupt', 'Invalid budget record JSON')
  }
}

function load(db: DatabaseSync, ref: BudgetReservationRef): { reservation: BudgetReservation; pricing: Pricing } | undefined {
  const row = db.prepare(`
    SELECT id, owner_id AS ownerId, profile_id AS profileId, task_id AS taskId, attempt_id AS attemptId,
      generation, task_version AS expectedVersion, provider, model, currency, pricing_version AS pricingVersion,
      day, created_at AS createdAt, updated_at AS updatedAt, pricing, ceiling_micros AS estimateMicros,
      actual_micros AS actualMicros, upper_input_tokens AS upperInputTokens, upper_output_tokens AS upperOutputTokens,
      unattended, status, usage
    FROM budget_reservations WHERE id = ? AND owner_id = ? AND profile_id = ?
  `).get(ref.id, ref.ownerId, ref.profileId)
  if (!row) return undefined
  const { taskId, attemptId, generation, expectedVersion, pricing, usage, unattended, ...fields } = row
  const parsed = reservationSchema.safeParse({
    ...fields,
    task: taskId === null ? undefined : { taskId, attemptId, generation, expectedVersion },
    unattended: unattended === 1,
    usage: usage === null ? undefined : readJson(usage),
  })
  const price = pricingSchema.safeParse(readJson(pricing))
  if (!parsed.success || !price.success || dayOf(parsed.data.createdAt) !== parsed.data.day
    || parsed.data.estimateMicros !== (price.data.kind === 'known' ? price.data.ceilingMicros : null)
    || (unattended !== 0 && unattended !== 1)) throw new StorageError('corrupt', 'Stored budget reservation is invalid')
  return { reservation: parsed.data, pricing: price.data }
}

/** At cold open, only an unclaimed reservation is known never to have reached a provider. */
export function markColdBudgetReservations(db: DatabaseSync): void {
  db.exec(`
    UPDATE budget_reservations SET status = CASE status WHEN 'reserved' THEN 'released' ELSE 'uncertain' END
    WHERE status IN ('reserved', 'claimed')
  `)
}

function usageSnapshot(db: DatabaseSync, scope: Scope, day: string): BudgetSnapshot {
  const statement = db.prepare(`
    WITH scoped AS (
      SELECT *, day = ? AS today FROM budget_reservations
      WHERE owner_id = ? AND profile_id = ? AND status <> 'released'
    )
    SELECT currency,
      COALESCE(SUM(CASE WHEN today AND status = 'settled' THEN actual_micros END), 0) AS spentMicros,
      COALESCE(SUM(CASE WHEN today AND status IN ('reserved', 'claimed') THEN ceiling_micros END), 0) AS reservedMicros,
      COALESCE(SUM(CASE WHEN today AND status = 'uncertain' THEN ceiling_micros END), 0) AS uncertainMicros,
      COALESCE(SUM(CASE WHEN NOT today AND status IN (${open}) THEN ceiling_micros END), 0) AS olderHeldMicros,
      COUNT(CASE WHEN today THEN 1 END) AS calls,
      COUNT(CASE WHEN today AND ceiling_micros IS NULL THEN 1 END) AS unknownCostCalls,
      COUNT(CASE WHEN today AND usage IS NULL THEN 1 END) AS unknownUsageCalls,
      COUNT(CASE WHEN today AND status = 'reserved' THEN 1 END) AS reservedCalls,
      COUNT(CASE WHEN today AND status = 'claimed' THEN 1 END) AS claimedCalls,
      COUNT(CASE WHEN today AND status = 'uncertain' THEN 1 END) AS uncertainCalls,
      COUNT(CASE WHEN NOT today AND status IN (${open}) THEN 1 END) AS olderUnresolvedCalls,
      COALESCE(SUM(CASE WHEN today THEN (usage ->> '$.inputTokens') END), 0) AS inputTokens,
      COALESCE(SUM(CASE WHEN today THEN (usage ->> '$.outputTokens') END), 0) AS outputTokens,
      COALESCE(SUM(CASE WHEN today THEN (usage ->> '$.cacheReadTokens') END), 0) AS cacheReadTokens,
      COALESCE(SUM(CASE WHEN today THEN (usage ->> '$.cacheWriteTokens') END), 0) AS cacheWriteTokens
    FROM scoped WHERE today OR status IN (${open}) GROUP BY currency ORDER BY currency
  `)
  statement.setReadBigInts(true)
  const currencies = statement.all(day, scope.ownerId, scope.profileId).map(row => {
    let overflow = false
    function count(value: unknown): number {
      if (typeof value !== 'bigint' || value < 0n) throw new StorageError('corrupt', 'Budget usage is invalid')
      if (value > MAX_SAFE) overflow = true
      return Number(value > MAX_SAFE ? MAX_SAFE : value)
    }
    if (typeof row.reservedMicros !== 'bigint' || typeof row.uncertainMicros !== 'bigint') {
      throw new StorageError('corrupt', 'Budget holds are invalid')
    }
    const parsed = currency.safeParse(row.currency)
    if (!parsed.success) throw new StorageError('corrupt', 'Budget currency is invalid')
    return {
      currency: parsed.data, spentMicros: count(row.spentMicros), heldMicros: count(row.reservedMicros + row.uncertainMicros),
      reservedMicros: count(row.reservedMicros), uncertainMicros: count(row.uncertainMicros), olderHeldMicros: count(row.olderHeldMicros),
      calls: count(row.calls), unknownCostCalls: count(row.unknownCostCalls), unknownUsageCalls: count(row.unknownUsageCalls),
      reservedCalls: count(row.reservedCalls), claimedCalls: count(row.claimedCalls), uncertainCalls: count(row.uncertainCalls),
      olderUnresolvedCalls: count(row.olderUnresolvedCalls), inputTokens: count(row.inputTokens), outputTokens: count(row.outputTokens),
      cacheReadTokens: count(row.cacheReadTokens), cacheWriteTokens: count(row.cacheWriteTokens), overflow,
    }
  })
  return { day, dayBasis: 'utc', currencies }
}

/** The trusted runtime calls begin immediately before handing a call to the provider. */
export function createBudget(access: Access, options: BudgetOptions, permit: Permit = () => true) {
  const { now: readClock, ...rawConfig } = options
  const config = budgetConfigSchema.parse(rawConfig)
  const routes = new Map(config.routes.map(route => [key(route.provider, route.model), route]))
  const limits = new Map(config.limits.map(limit => [limit.currency, limit]))
  const now = () => utcInstantSchema.parse(readClock?.() ?? new Date().toISOString())

  function admission(db: DatabaseSync, input: BudgetRequest, at: UtcInstant, except: string | null = null, preflight = false): Admission {
    if (!permit(db)) return fail('recovery_required')
    const route = routes.get(key(input.provider, input.model))
    if (!route || (route.pricing.kind === 'unknown' && input.unattended)) return fail('pricing_unavailable')
    const limit = limits.get(route.currency)
    if (!limit) return fail('pricing_unavailable')
    if (!currentTask(db, input, preflight)) return fail('stale_attempt')
    if (route.pricing.kind === 'known' && quote(input, route.pricing) > BigInt(route.pricing.ceilingMicros)) {
      return fail('budget_exceeded')
    }
    return withinLimits(db, input, dayOf(at), route, limit, except)
  }

  function reserve(raw: unknown, next: 'reserved' | 'claimed', participant?: ClaimParticipant): ReservationResult {
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success) return fail('invalid_input')
    const input = parsed.data
    const at = now()
    return access(db => transaction(db, () => {
      const allowed = admission(db, input, at)
      if (!allowed.ok) return allowed
      const { route } = allowed
      const reservation: BudgetReservation = {
        ...input, id: randomUUID(), currency: route.currency, pricingVersion: config.pricingVersion,
        day: dayOf(at), createdAt: at, updatedAt: at, status: next,
        estimateMicros: route.pricing.kind === 'known' ? route.pricing.ceilingMicros : null, actualMicros: null,
      }
      if (participant && !participant(db, reservation)) return fail('invalid_transition')
      db.prepare(`
        INSERT INTO budget_reservations (
          id, owner_id, profile_id, task_id, attempt_id, generation, task_version, provider, model, currency,
          pricing_version, day, created_at, updated_at, pricing, ceiling_micros, upper_input_tokens,
          upper_output_tokens, unattended, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(reservation.id, input.ownerId, input.profileId, input.task?.taskId ?? null, input.task?.attemptId ?? null,
        input.task?.generation ?? null, input.task?.expectedVersion ?? null, input.provider, input.model, route.currency,
        config.pricingVersion, reservation.day, at, at, JSON.stringify(route.pricing), reservation.estimateMicros,
        input.upperInputTokens, input.upperOutputTokens, Number(input.unattended), next)
      return { ok: true, reservation }
    }))
  }

  function claim(raw: unknown): ReservationResult {
    const parsed = reservationRefSchema.safeParse(raw)
    if (!parsed.success) return fail('invalid_input')
    const at = now()
    const ref = parsed.data
    return access(db => transaction(db, () => {
      const stored = load(db, ref)
      if (!stored) return fail('not_found')
      const current = stored.reservation
      if (current.status !== 'reserved' || current.day !== dayOf(at) || at < current.updatedAt
        || current.pricingVersion !== config.pricingVersion) return fail('invalid_transition')
      const allowed = admission(db, current, at, ref.id)
      if (!allowed.ok) return allowed
      if (current.currency !== allowed.route.currency || JSON.stringify(stored.pricing) !== JSON.stringify(allowed.route.pricing)) {
        return fail('pricing_unavailable')
      }
      const updated = db.prepare("UPDATE budget_reservations SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'reserved'")
        .run(at, ref.id)
      if (updated.changes !== 1) return fail('invalid_transition')
      return { ok: true, reservation: { ...current, status: 'claimed', updatedAt: at } }
    }))
  }

  function settle(raw: unknown, input: unknown, expected: 'claimed' | 'uncertain'): boolean {
    const ref = reservationRefSchema.safeParse(raw)
    const usage = usageSchema.safeParse(input)
    if (!ref.success || !usage.success) return false
    const at = now()
    return access(db => transaction(db, () => {
      const stored = load(db, ref.data)
      if (!stored || stored.reservation.status !== expected || at < stored.reservation.updatedAt) return false
      const actual = stored.pricing.kind === 'known' ? cost(usage.data, stored.pricing) : null
      if (actual !== null && actual > MAX_SAFE) return false
      return db.prepare(`
        UPDATE budget_reservations SET status = 'settled', updated_at = ?, usage = ?, actual_micros = ?
        WHERE id = ? AND owner_id = ? AND profile_id = ? AND status = ?
      `).run(at, JSON.stringify(usage.data), actual === null ? null : Number(actual), ref.data.id,
        ref.data.ownerId, ref.data.profileId, expected).changes === 1
    }))
  }

  function mark(raw: unknown, expected: 'reserved' | 'claimed', next: 'released' | 'uncertain'): boolean {
    const ref = reservationRefSchema.safeParse(raw)
    if (!ref.success) return false
    return access(db => db.prepare(`
      UPDATE budget_reservations SET status = ?, updated_at = MAX(updated_at, ?)
      WHERE id = ? AND owner_id = ? AND profile_id = ? AND status = ?
    `).run(next, now(), ref.data.id, ref.data.ownerId, ref.data.profileId, expected).changes === 1)
  }

  const service = Object.freeze({
    canBegin(raw: unknown): boolean {
      const parsed = requestSchema.safeParse(raw)
      return parsed.success && access(db => admission(db, parsed.data, now(), null, true).ok)
    },
    begin: (input: unknown) => reserve(input, 'claimed'),
    reserve: (input: unknown) => reserve(input, 'reserved'),
    claim,
    release: (ref: unknown) => mark(ref, 'reserved', 'released'),
    settle: (ref: unknown, usage: unknown) => settle(ref, usage, 'claimed'),
    uncertain: (ref: unknown) => mark(ref, 'claimed', 'uncertain'),
    reconcile: (ref: unknown, usage: unknown) => settle(ref, usage, 'uncertain'),
    get(raw: unknown): BudgetReservation | undefined {
      const ref = reservationRefSchema.safeParse(raw)
      return ref.success ? access(db => load(db, ref.data)?.reservation) : undefined
    },
    listUncertain({ ownerId, profileId }: Scope, after = '', limit = 64): BudgetReservation[] {
      const scope = scopeSchema.parse({ ownerId, profileId })
      const bound = z.int().min(1).max(128).parse(limit)
      return access(db => db.prepare(`
        SELECT id FROM budget_reservations WHERE owner_id = ? AND profile_id = ? AND status = 'uncertain' AND id > ?
        ORDER BY id LIMIT ?
      `).all(scope.ownerId, scope.profileId, after, bound).map(({ id }) => {
        const ref = reservationRefSchema.safeParse({ ...scope, id })
        const row = ref.success ? load(db, ref.data) : undefined
        if (!row) throw new StorageError('corrupt', 'Missing uncertain budget reservation')
        return row.reservation
      }))
    },
    snapshot: ({ ownerId, profileId }: Scope) => access(db => usageSnapshot(db, scopeSchema.parse({ ownerId, profileId }), dayOf(now()))),
  })
  routedClaims.set(service, (input, participant) => reserve(input, 'claimed', participant))
  return service
}

export type BudgetService = ReturnType<typeof createBudget>
