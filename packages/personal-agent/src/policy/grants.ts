import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  accountIdSchema,
  attemptIdSchema,
  generationSchema,
  nonEmptyTextSchema,
  operationIdSchema,
  ownerIdSchema,
  profileIdSchema,
  sourceInstanceIdSchema,
  taskIdSchema,
} from '../domain/model.js'

const MAX_ACTION_BYTES = 64 * 1024
const MAX_ACTION_DEPTH = 32
const MAX_ACTION_NODES = 4_096

const actionFieldsSchema = z.strictObject({
  ownerId: ownerIdSchema,
  profileId: profileIdSchema,
  taskId: taskIdSchema,
  attemptId: attemptIdSchema,
  generation: generationSchema,
  operationId: operationIdSchema,
  policyVersion: nonEmptyTextSchema,
  sourceInstanceId: sourceInstanceIdSchema,
  accountId: accountIdSchema,
  kind: nonEmptyTextSchema,
  resourceRef: nonEmptyTextSchema,
  recipient: nonEmptyTextSchema.optional(),
  dataScope: z.array(nonEmptyTextSchema).refine(labels => new Set(labels).size === labels.length),
  limits: z.strictObject({ maxUses: z.literal(1) }),
})

type ActionJson = null | boolean | number | string | readonly ActionJson[] | { readonly [key: string]: ActionJson }
type ActionFields = z.infer<typeof actionFieldsSchema>
export type Action = Readonly<Omit<ActionFields, 'dataScope' | 'limits'>> & {
  readonly dataScope: readonly string[]
  readonly limits: Readonly<ActionFields['limits']>
  readonly payload: ActionJson
}
export type ActionBinding = Pick<Action, 'sourceInstanceId' | 'accountId' | 'kind' | 'resourceRef' | 'recipient' | 'dataScope' | 'limits'>

export interface CanonicalAction {
  readonly action: Action
  readonly canonical: string
  readonly digest: string
}

interface JsonBudget {
  nodes: number
  text: number
}

function chargeText(value: string, budget: JsonBudget): string {
  budget.text -= value.length
  if (budget.text < 0) throw new TypeError('Action text exceeds the size limit')
  return value
}

function dataProperty(object: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(object, key)
  if (!property?.enumerable || !('value' in property)) throw new TypeError('Action must contain plain JSON data')
  return property.value
}

/** Snapshot before validation so serialization cannot invoke an input accessor or toJSON method. */
function snapshotJson(value: unknown, budget: JsonBudget, depth = 0): ActionJson {
  budget.nodes -= 1
  if (budget.nodes < 0 || depth > MAX_ACTION_DEPTH) throw new TypeError('Action structure exceeds the size limit')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return chargeText(value, budget)
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value
  if (typeof value !== 'object') throw new TypeError('Action must contain plain JSON data')

  if (Array.isArray(value)) {
    if (value.length > budget.nodes || Reflect.ownKeys(value).length !== value.length + 1) {
      throw new TypeError('Action must contain bounded dense arrays')
    }
    const items: ActionJson[] = []
    for (let index = 0; index < value.length; index++) {
      items.push(snapshotJson(dataProperty(value, String(index)), budget, depth + 1))
    }
    return Object.freeze(items)
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) throw new TypeError('Action must contain plain JSON objects')
  const keys = Reflect.ownKeys(value)
  if (keys.length > budget.nodes) throw new TypeError('Action structure exceeds the size limit')
  const snapshot: Record<string, ActionJson> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string') throw new TypeError('Action must contain plain JSON keys')
    snapshot[chargeText(key, budget)] = snapshotJson(dataProperty(value, key), budget, depth + 1)
  }
  return Object.freeze(snapshot)
}

function isJsonArray(value: ActionJson): value is readonly ActionJson[] {
  return Array.isArray(value)
}

function canonicalJson(value: ActionJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  // Sort explicitly because JSON.stringify enumerates integer-like keys numerically.
  const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
  return `{${entries.join(',')}}`
}

/** Produce the immutable exact action used at review and at the provider handoff. */
export function canonicalizeAction(raw: unknown): CanonicalAction | undefined {
  try {
    const snapshot = snapshotJson(raw, { nodes: MAX_ACTION_NODES, text: MAX_ACTION_BYTES })
    if (snapshot === null || typeof snapshot !== 'object' || isJsonArray(snapshot)) return undefined
    const { payload, ...fields } = snapshot
    if (payload === undefined) return undefined
    const parsed = actionFieldsSchema.safeParse(fields)
    if (!parsed.success) return undefined
    const action: Action = Object.freeze({
      ...parsed.data,
      dataScope: Object.freeze([...parsed.data.dataScope].sort()),
      limits: Object.freeze(parsed.data.limits),
      payload,
    })
    const canonical = canonicalJson(action)
    if (Buffer.byteLength(canonical) > MAX_ACTION_BYTES) return undefined
    return Object.freeze({ action, canonical, digest: createHash('sha256').update(canonical).digest('hex') })
  } catch {
    return undefined
  }
}

/** Bind the reviewed action to trusted routing and disclosure metadata. */
export function matchesActionBinding(action: Action, binding: ActionBinding): boolean {
  return action.sourceInstanceId === binding.sourceInstanceId
    && action.accountId === binding.accountId
    && action.kind === binding.kind
    && action.resourceRef === binding.resourceRef
    && action.recipient === binding.recipient
    && action.limits.maxUses === binding.limits.maxUses
    && action.dataScope.length === binding.dataScope.length
    && [...binding.dataScope].sort().every((label, index) => action.dataScope[index] === label)
}
