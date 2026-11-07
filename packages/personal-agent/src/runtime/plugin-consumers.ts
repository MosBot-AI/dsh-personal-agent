import { createHash } from 'node:crypto'
import type { z } from 'zod'
import {
  capabilityInstantSchema, mediaHandleSchema, mediaInputArtifactSchema, mediaJobRequestSchema, mediaJobStatusSchema,
  mediaOutputsSchema, mediaSubmitRequestSchema, memoryActiveRecordSchema, memoryExportRequestSchema, memoryForgetRequestSchema,
  memoryImportRequestSchema, memoryImportResultSchema, memoryReadRequestSchema, memoryRecordSchema, memorySearchRequestSchema,
  memorySearchResultsSchema, memorySnapshotSchema, memorySupersedeRequestSchema, memorySupersededRecordSchema,
  matchesWorkflowFields, memoryTombstoneSchema, memoryUpsertRequestSchema, providerPinSchema, providerResultSchema,
  sameMemoryAccess, sameProviderPin,
  workflowJsonValueSchema, workflowMediaRequestSchema, workflowRequestSchema, workflowResultSchema, workflowToolRequestSchema,
  type CapabilityDestination, type CapabilityKind, type MediaAccess, type MediaHandle, type MediaInputArtifact, type MediaJobRequest,
  type MediaSubmitRequest,
  type MemoryAccess, type MemoryActiveRecord, type MemoryForgetRequest, type MemoryHit, type MemoryRecord,
  type ProviderByKind, type ProviderFailureCode, type ProviderPin, type ProviderResult, type WorkflowField, type WorkflowJsonObject,
  type WorkflowResult, type WorkflowServices, type WorkflowToolRequest,
} from '@mosbot-ai/dshpa-plugin-api'
import type { createCapabilityRegistry } from './capability-registry.js'

type Registry = ReturnType<typeof createCapabilityRegistry>
type Access = MemoryAccess | MediaAccess
type ScopedRequest = { readonly access: Access }
type Capabilities<K extends CapabilityKind> = ProviderByKind[K]['capabilities']
type Operation = 'memory.read' | 'memory.search' | 'memory.upsert' | 'memory.supersede' | 'memory.forget'
  | 'memory.export' | 'memory.import' | 'media.submit' | 'media.inspect' | 'media.cancel' | 'media.collect'
  | 'workflow.run' | 'workflow.tool'

export interface PluginUse {
  readonly operation: Operation
  readonly pin: ProviderPin
  readonly access: Access
  readonly destinations: readonly CapabilityDestination[]
  readonly mock: boolean
  readonly capabilities: Capabilities<CapabilityKind>
  readonly request: ScopedRequest
}

/** Trusted core callbacks. Providers receive only validated capability DTOs. */
export interface PluginConsumerPolicy {
  authorize(authority: unknown, use: PluginUse): boolean
  allowSource(authority: unknown, access: MemoryAccess, sourceEventId: string): boolean
  isExcluded(access: MemoryAccess, recordId: string): boolean
  /** Authorize and persist the core exclusion before contacting a provider. */
  commitExclusion(authority: unknown, request: MemoryForgetRequest): boolean
  allowArtifact(authority: unknown, access: MediaAccess, artifact: MediaInputArtifact): boolean
  isRecordedMediaJob(authority: unknown, request: MediaJobRequest): boolean
  /** Persist a scoped child intent before a workflow can hand it to a provider. */
  recordMediaIntent?: (authority: unknown, request: MediaSubmitRequest, pin: ProviderPin<'media'>) => boolean | Promise<boolean>
  /** Persist the exact accepted child handle for reconciliation even after caller revocation. */
  recordMediaHandle?: (authority: unknown, request: MediaSubmitRequest, handle: MediaHandle) => boolean | Promise<boolean>
  runTool?: (authority: unknown, access: MediaAccess, request: WorkflowToolRequest, signal: AbortSignal) =>
    ProviderResult<unknown> | Promise<ProviderResult<unknown>>
  now?: () => string
}

function fail(code: ProviderFailureCode) { return { ok: false, code } as const }
function ok<T>(value: T): ProviderResult<T> { return { ok: true, value } }

function checkedResult<S extends z.ZodType>(result: unknown, schema: S): ProviderResult<z.output<S>> {
  const parsed = providerResultSchema(schema).safeParse(result)
  return parsed.success ? parsed.data as ProviderResult<z.output<S>> : fail('invalid_result')
}

function passes(check: () => boolean): boolean {
  try { return check() === true } catch { return false }
}

function parsePin<K extends CapabilityKind>(input: unknown, ...kinds: K[]): ProviderPin<K> | undefined {
  const parsed = providerPinSchema.safeParse(input)
  return parsed.success && kinds.some(kind => kind === parsed.data.kind) ? parsed.data as ProviderPin<K> : undefined
}

function sameSources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id))
}

export function createPluginConsumers(registry: Registry, policy: PluginConsumerPolicy) {
  function permitted(authority: unknown, pin: ProviderPin, operation: Operation, request: ScopedRequest,
    capabilities: Capabilities<CapabilityKind>): boolean {
    return passes(() => policy.authorize(authority, structuredClone({
      pin, operation, access: request.access, request, capabilities, destinations: capabilities.destinations, mock: capabilities.mock,
    })))
  }

  async function dispatch<K extends CapabilityKind, T>(
    authority: unknown, pin: ProviderPin<K>, operation: Operation, request: ScopedRequest,
    use: (provider: ProviderByKind[K], signal: AbortSignal, current: () => boolean, capabilities: Capabilities<K>) =>
      ProviderResult<T> | Promise<ProviderResult<T>>,
    signal?: AbortSignal,
  ): Promise<ProviderResult<T>> {
    const metadata = registry.inspect(pin)
    if (!metadata.ok) return metadata
    const { capabilities } = metadata.value
    const current = () => permitted(authority, pin, operation, request, capabilities)
    if (!current()) return fail('permission_denied')
    return registry.invoke(pin, (provider, callSignal) => current()
      ? use(provider, callSignal, current, capabilities) : fail('permission_denied'), signal)
  }

  function sourcesAllowed(authority: unknown, access: MemoryAccess, ids: readonly string[]): boolean {
    return ids.every(id => passes(() => policy.allowSource(authority, structuredClone(access), id)))
  }

  function excluded(access: MemoryAccess, id: string): boolean {
    return !passes(() => policy.isExcluded(structuredClone(access), id) === false)
  }

  function snapshotAllowed(authority: unknown, access: MemoryAccess, records: readonly MemoryRecord[]): boolean {
    return records.every(record => sourcesAllowed(authority, access, record.sourceEventIds)
      && (record.state === 'forgotten' || !excluded(access, record.id)))
  }

  async function read(authority: unknown, rawPin: unknown, input: unknown, signal?: AbortSignal): Promise<ProviderResult<MemoryActiveRecord | null>> {
    const pin = parsePin(rawPin, 'memory')
    const parsed = memoryReadRequestSchema.safeParse(input)
    if (!pin || !parsed.success) return fail('invalid_input')
    const request = parsed.data
    return dispatch(authority, pin, 'memory.read', request, async (provider, callSignal, current) => {
      if (excluded(request.access, request.recordId)) return ok(null)
      const result = checkedResult(await provider.read(structuredClone(request), callSignal), memoryRecordSchema.nullable())
      if (callSignal.aborted) return fail('cancelled')
      if (!result.ok) return result
      const record = result.value
      if (record && (record.id !== request.recordId || !sameMemoryAccess(record, request.access))) return fail('invalid_result')
      if (!current()) return fail('permission_denied')
      if (record?.state !== 'active' || excluded(request.access, record.id)
        || !sourcesAllowed(authority, request.access, record.sourceEventIds)) return ok(null)
      const at = capabilityInstantSchema.safeParse(policy.now?.() ?? new Date().toISOString())
      if (!at.success) return fail('internal')
      return ok(record.validFrom <= at.data && (record.validUntil === undefined || at.data < record.validUntil) ? record : null)
    }, signal)
  }

  const memory = Object.freeze({
    read,
    async search(authority: unknown, rawPin: unknown, input: unknown, signal?: AbortSignal): Promise<ProviderResult<MemoryHit[]>> {
      const pin = parsePin(rawPin, 'memory', 'memory-retrieval')
      const parsed = memorySearchRequestSchema.safeParse(input)
      if (!pin || !parsed.success) return fail('invalid_input')
      const canonical = parsePin(rawPin, 'memory')
      const memoryProvider = canonical ? ok(canonical) : registry.selected('memory')
      if (!memoryProvider.ok) return fail('provider_unavailable')
      const request = parsed.data
      return dispatch(authority, pin, 'memory.search', request, async (provider, callSignal, current) => {
        const result = checkedResult(await provider.search(structuredClone(request), callSignal), memorySearchResultsSchema)
        if (callSignal.aborted) return fail('cancelled')
        if (!result.ok) return result
        if (result.value.length > request.limit) return fail('invalid_result')
        const allowed: MemoryHit[] = []
        for (const hit of result.value) {
          if (callSignal.aborted) return fail('cancelled')
          if (!current()) return fail('permission_denied')
          if (excluded(request.access, hit.recordId) || !sourcesAllowed(authority, request.access, hit.sourceEventIds)) continue
          const record = await read(authority, memoryProvider.value, { access: request.access, recordId: hit.recordId }, callSignal)
          if (!record.ok) {
            if (record.code === 'not_found' || record.code === 'permission_denied' || record.code === 'invalid_result') continue
            return record
          }
          if (record.value?.revision === hit.revision && sameSources(record.value.sourceEventIds, hit.sourceEventIds)) allowed.push(hit)
        }
        if (callSignal.aborted) return fail('cancelled')
        if (!current()) return fail('permission_denied')
        const canonical = registry.inspect(memoryProvider.value)
        if (!canonical.ok) return canonical
        return ok(allowed.filter(hit => {
          const readRequest = { access: request.access, recordId: hit.recordId }
          return !excluded(request.access, hit.recordId) && sourcesAllowed(authority, request.access, hit.sourceEventIds)
            && permitted(authority, memoryProvider.value, 'memory.read', readRequest, canonical.value.capabilities)
        }))
      }, signal)
    },
    async upsert(authority: unknown, rawPin: unknown, input: unknown, signal?: AbortSignal) {
      const pin = parsePin(rawPin, 'memory')
      const parsed = memoryUpsertRequestSchema.safeParse(input)
      if (!pin || !parsed.success) return fail('invalid_input')
      const request = parsed.data
      return dispatch(authority, pin, 'memory.upsert', request, async (provider, callSignal) => {
        if (excluded(request.access, request.record.id) || !sourcesAllowed(authority, request.access, request.record.sourceEventIds)) {
          return fail('permission_denied')
        }
        const result = checkedResult(await provider.upsert(structuredClone(request), callSignal), memoryActiveRecordSchema)
        if (!result.ok) return result
        if (JSON.stringify(result.value) !== JSON.stringify(request.record)) return fail('invalid_result')
        return ok({ id: result.value.id, revision: result.value.revision })
      }, signal)
    },
    async supersede(authority: unknown, rawPin: unknown, input: unknown, signal?: AbortSignal) {
      const pin = parsePin(rawPin, 'memory')
      const parsed = memorySupersedeRequestSchema.safeParse(input)
      if (!pin || !parsed.success) return fail('invalid_input')
      const request = parsed.data
      return dispatch(authority, pin, 'memory.supersede', request, async (provider, callSignal) => {
        if (excluded(request.access, request.recordId) || excluded(request.access, request.replacement.id)
          || !sourcesAllowed(authority, request.access, request.replacement.sourceEventIds)) return fail('permission_denied')
        const result = checkedResult(await provider.supersede(structuredClone(request), callSignal), memorySupersededRecordSchema)
        if (!result.ok) return result
        const record = result.value
        if (!sameMemoryAccess(request.access, record) || record.id !== request.recordId
          || record.revision !== request.expectedRevision + 1 || record.supersededBy !== request.replacement.id) return fail('invalid_result')
        return ok({ id: record.id, revision: record.revision, replacementId: request.replacement.id })
      }, signal)
    },
    async forget(authority: unknown, rawPin: unknown, input: unknown, signal?: AbortSignal) {
      const pin = parsePin(rawPin, 'memory')
      const parsed = memoryForgetRequestSchema.safeParse(input)
      if (!pin || !parsed.success) return fail('invalid_input')
      if (signal?.aborted) return fail('cancelled')
      const request = parsed.data
      if (!passes(() => policy.commitExclusion(authority, structuredClone(request)))) return fail('permission_denied')
      const result = await dispatch(authority, pin, 'memory.forget', request, async (provider, callSignal) => {
        const response = checkedResult(await provider.forget(structuredClone(request), callSignal), memoryTombstoneSchema)
        if (!response.ok) return response
        const tombstone = response.value
        return sameMemoryAccess(tombstone, request.access) && tombstone.id === request.recordId
          && tombstone.revision === request.expectedRevision + 1 && tombstone.forgottenAt === request.forgottenAt
          ? ok(null) : fail('invalid_result')
      }, signal)
      return ok({ state: result.ok ? 'completed' as const : 'pending' as const })
    },
    async exportSnapshot(authority: unknown, rawPin: unknown, input: unknown, signal?: AbortSignal) {
      const pin = parsePin(rawPin, 'memory')
      const parsed = memoryExportRequestSchema.safeParse(input)
      if (!pin || !parsed.success) return fail('invalid_input')
      const request = parsed.data
      return dispatch(authority, pin, 'memory.export', request, async (provider, callSignal, current) => {
        const result = checkedResult(await provider.exportSnapshot(structuredClone(request), callSignal), memorySnapshotSchema)
        if (callSignal.aborted) return fail('cancelled')
        if (!result.ok) return result
        if (!sameMemoryAccess(result.value.access, request.access)) return fail('invalid_result')
        return current() && snapshotAllowed(authority, request.access, result.value.records) ? result : fail('permission_denied')
      }, signal)
    },
    async importSnapshot(authority: unknown, rawPin: unknown, input: unknown, signal?: AbortSignal) {
      const pin = parsePin(rawPin, 'memory')
      const parsed = memoryImportRequestSchema.safeParse(input)
      if (!pin || !parsed.success) return fail('invalid_input')
      const request = parsed.data
      return dispatch(authority, pin, 'memory.import', request, async (provider, callSignal) => {
        if (!snapshotAllowed(authority, request.access, request.snapshot.records)
          || request.snapshot.records.some(record => record.state === 'forgotten'
            && !passes(() => policy.isExcluded(structuredClone(request.access), record.id) === true))) {
          return fail('permission_denied')
        }
        const result = checkedResult(await provider.importSnapshot(structuredClone(request), callSignal), memoryImportResultSchema)
        if (!result.ok) return result
        return result.value.count === request.snapshot.records.length ? result : fail('invalid_result')
      }, signal)
    },
  })

  function artifactsAllowed(authority: unknown, access: MediaAccess, artifacts: readonly MediaInputArtifact[]): boolean {
    return artifacts.every(artifact => passes(() => policy.allowArtifact(authority, structuredClone(access), structuredClone(artifact))))
  }

  async function submit(authority: unknown, rawPin: unknown, input: unknown, signal?: AbortSignal,
    beforeHandoff?: (request: MediaSubmitRequest, pin: ProviderPin<'media'>) => Promise<ProviderResult<null>>): Promise<ProviderResult<MediaHandle>> {
    const pin = parsePin(rawPin, 'media')
    const parsed = mediaSubmitRequestSchema.safeParse(input)
    if (!pin || !parsed.success) return fail('invalid_input')
    const request = parsed.data
    return dispatch(authority, pin, 'media.submit', request, async (provider, callSignal, current, capabilities) => {
      const { spec } = request
      const format = capabilities.formats.find(item => item.modality === spec.modality)
      if (!format || !format.operations.includes(spec.operation) || spec.width > format.maxWidth || spec.height > format.maxHeight
        || (spec.modality === 'video' && (format.modality !== 'video' || spec.durationMs > format.maxDurationMs))) {
        return fail('unsupported_capability')
      }
      if (!artifactsAllowed(authority, request.access, request.inputArtifacts ?? [])) return fail('permission_denied')
      if (beforeHandoff) {
        const prepared = await beforeHandoff(request, pin)
        if (!prepared.ok) return prepared
      }
      if (callSignal.aborted) return fail('cancelled')
      if (!current()) return fail('permission_denied')
      if (!registry.inspect(pin).ok) return fail('provider_unavailable')
      const result = checkedResult(await provider.submit(structuredClone(request), callSignal), mediaHandleSchema)
      if (!result.ok) return result
      if (!sameProviderPin(result.value.provider, pin) || result.value.operationId !== request.operationId) {
        return fail('invalid_result')
      }
      // Retain a known handle for trusted reconciliation even when authority
      // changes after the provider accepted the already authorized submission.
      return result
    }, signal)
  }

  async function mediaJob<T>(authority: unknown, method: 'inspect' | 'cancel' | 'collect', input: unknown,
    schema: z.ZodType<T>, signal?: AbortSignal): Promise<ProviderResult<T>> {
    const parsed = mediaJobRequestSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_input')
    const request = parsed.data
    const recorded = () => passes(() => policy.isRecordedMediaJob(authority, structuredClone(request)))
    if (!recorded()) return fail('permission_denied')
    return dispatch(authority, request.handle.provider, `media.${method}`, request, async (provider, callSignal, current, capabilities) => {
      if (!recorded()) return fail('permission_denied')
      if (method === 'cancel' && capabilities.cancellation === 'none') return fail('unsupported_capability')
      const result = checkedResult(await provider[method](structuredClone(request), callSignal), schema)
      if (method !== 'cancel' && callSignal.aborted) return fail('cancelled')
      if (!result.ok) return result
      return method === 'cancel' || (current() && recorded()) ? result : fail('permission_denied')
    }, signal)
  }

  const media = Object.freeze({
    submit: (authority: unknown, pin: unknown, input: unknown, signal?: AbortSignal) => submit(authority, pin, input, signal),
    inspect: (authority: unknown, input: unknown, signal?: AbortSignal) => mediaJob(authority, 'inspect', input, mediaJobStatusSchema, signal),
    cancel: (authority: unknown, input: unknown, signal?: AbortSignal) => mediaJob(authority, 'cancel', input, mediaJobStatusSchema, signal),
    collect: (authority: unknown, input: unknown, signal?: AbortSignal) => mediaJob(authority, 'collect', input, mediaOutputsSchema, signal),
  })

  function workflowFieldsAllowed(authority: unknown, access: MediaAccess, fields: readonly WorkflowField[], value: WorkflowJsonObject) {
    if (!matchesWorkflowFields(fields, value)) return false
    return fields.filter(field => field.type === 'artifact' && Object.hasOwn(value, field.name)).every(field => {
      const artifact = mediaInputArtifactSchema.safeParse(value[field.name])
      return artifact.success && artifactsAllowed(authority, access, [artifact.data])
    })
  }

  async function runWorkflow(authority: unknown, rawPin: unknown, input: unknown, signal?: AbortSignal): Promise<ProviderResult<WorkflowResult>> {
    const pin = parsePin(rawPin, 'creation-workflow')
    const parsed = workflowRequestSchema.safeParse(input)
    if (!pin || !parsed.success) return fail('invalid_input')
    const request = parsed.data
    return dispatch<'creation-workflow', WorkflowResult>(authority, pin, 'workflow.run', request, async (provider, callSignal, current, capabilities) => {
      const validCheckpoint = (stepId: string) => capabilities.steps.some(step => step.id === stepId && step.checkpoint)
      if (request.workflowVersion !== capabilities.workflowVersion || (request.checkpoint && !validCheckpoint(request.checkpoint.stepId))
        || !matchesWorkflowFields(capabilities.inputs, request.input)) return fail('invalid_input')
      if (!workflowFieldsAllowed(authority, request.access, capabilities.inputs, request.input)) return fail('permission_denied')
      const selected = registry.selected('media')
      const tool = policy.runTool
      const recordIntent = policy.recordMediaIntent
      const recordHandle = policy.recordMediaHandle
      if (capabilities.requires.some(requirement => requirement.kind === 'media'
        ? !selected.ok || !recordIntent || !recordHandle : tool === undefined)) {
        return fail('provider_unavailable')
      }
      let active = true
      let calls = 0
      let receiptUncertain = false
      const outstanding = new Set<Promise<unknown>>()
      const useService = <T>(child: AbortSignal, invoke: (merged: AbortSignal, ordinal: number) => Promise<ProviderResult<T>>) => {
        if (!(child instanceof AbortSignal)) return Promise.resolve(fail('invalid_input'))
        if (!active || callSignal.aborted || child.aborted) return Promise.resolve(fail('cancelled'))
        if (!current()) return Promise.resolve(fail('permission_denied'))
        if (calls >= 64) return Promise.resolve(fail('busy'))
        const ordinal = ++calls
        const merged = AbortSignal.any([callSignal, child])
        const pending = Promise.resolve().then(() => {
          if (!active || merged.aborted) return fail('cancelled')
          if (receiptUncertain) return fail('uncertain')
          if (!current()) return fail('permission_denied')
          if (!registry.inspect(pin).ok) return fail('provider_unavailable')
          return invoke(merged, ordinal)
        }).catch(() => fail('uncertain'))
        outstanding.add(pending)
        void pending.then(() => outstanding.delete(pending))
        return pending
      }
      const services = Object.freeze<WorkflowServices>({
        requestMedia(input, child) {
          const decoded = workflowMediaRequestSchema.safeParse(input)
          if (!decoded.success) return fail('invalid_input')
          const { spec } = decoded.data
          if (!capabilities.requires.some(requirement => requirement.kind === 'media'
            && requirement.modality === spec.modality && requirement.operation === spec.operation)) return fail('unsupported_capability')
          if (!selected.ok || !recordIntent || !recordHandle) return fail('provider_unavailable')
          return useService(child, async (merged, ordinal) => {
            const key = [request.access, request.operationId, request.workflowVersion, request.checkpoint?.stepId, ordinal]
            const operationId = `workflow-media-${createHash('sha256').update(JSON.stringify(key)).digest('hex')}`
            const mediaRequest = { ...decoded.data, access: request.access, operationId }
            const result = await submit(authority, selected.value, mediaRequest, merged, async (intent, providerPin) => {
              if (await recordIntent(authority, structuredClone(intent), structuredClone(providerPin)) !== true) return fail('permission_denied')
              if (!active || merged.aborted) return fail('cancelled')
              if (!current()) return fail('permission_denied')
              return registry.inspect(pin).ok ? ok(null) : fail('provider_unavailable')
            })
            if (!result.ok) {
              if (result.code === 'uncertain' || result.code === 'invalid_result') receiptUncertain = true
              return result
            }
            try {
              if (await recordHandle(authority, structuredClone(mediaRequest), structuredClone(result.value)) !== true) receiptUncertain = true
            } catch { receiptUncertain = true }
            if (receiptUncertain) return fail('uncertain')
            if (merged.aborted) return fail('cancelled')
            return current() ? result : fail('permission_denied')
          })
        },
        requestTool(input, child) {
          const decoded = workflowToolRequestSchema.safeParse(input)
          if (!decoded.success) return fail('invalid_input')
          if (!capabilities.requires.some(requirement => requirement.kind === 'tool' && requirement.toolId === decoded.data.toolId)) {
            return fail('unsupported_capability')
          }
          if (!tool) return fail('provider_unavailable')
          return useService(child, async merged => {
            const toolRequest = { ...decoded.data, access: request.access }
            const allowed = () => permitted(authority, pin, 'workflow.tool', toolRequest, capabilities)
            if (!allowed()) return fail('permission_denied')
            const result = checkedResult(await tool(authority, structuredClone(request.access), decoded.data, merged), workflowJsonValueSchema)
            if (merged.aborted) return fail('cancelled')
            if (!result.ok) return result
            return current() && allowed() ? result : fail('permission_denied')
          })
        },
      })
      let result: unknown
      try {
        const outcome = provider.run(structuredClone(request), services, callSignal)
        result = outcome instanceof Promise ? await outcome : outcome
      }
      finally { active = false; await Promise.allSettled([...outstanding]) }
      if (receiptUncertain) return fail('uncertain')
      if (callSignal.aborted) return fail('cancelled')
      const decoded = checkedResult(result, workflowResultSchema)
      if (!decoded.ok) return decoded
      if (!current()) return fail('permission_denied')
      const outcome = decoded.value
      if (outcome.kind === 'checkpoint') return validCheckpoint(outcome.checkpoint.stepId) ? ok(outcome) : fail('invalid_result')
      if (!matchesWorkflowFields(capabilities.outputs, outcome.output)) return fail('invalid_result')
      return workflowFieldsAllowed(authority, request.access, capabilities.outputs, outcome.output) ? ok(outcome) : fail('permission_denied')
    }, signal)
  }

  return Object.freeze({ memory, media, workflow: Object.freeze({ run: runWorkflow }) })
}
