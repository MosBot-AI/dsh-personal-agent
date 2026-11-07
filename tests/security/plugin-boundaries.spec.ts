import { z } from 'zod'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  CAPABILITY_API_VERSION, sameMediaAccess, sameMemoryAccess, sameProviderPin,
  type CapabilityKind, type CreationWorkflowProvider, type MediaAccess, type MediaJobRequest,
  type MediaProvider, type MediaSubmitRequest, type MemoryAccess, type MemoryActiveRecord, type MemoryProvider,
  type MemoryRecord, type ProviderByKind, type ProviderFailureCode, type ProviderPin, type ProviderResult, type WorkflowServices,
} from '@mosbot-ai/dshpa-plugin-api'
import { createCapabilityRegistry } from '../../packages/personal-agent/src/runtime/capability-registry.js'
import { createPluginConsumers, type PluginConsumerPolicy } from '../../packages/personal-agent/src/runtime/plugin-consumers.js'

const account = { ownerId: 'fixture-owner', profileId: 'fixture-profile' }
const memoryAccess: MemoryAccess = { ...account, scope: { kind: 'project', projectId: 'project-one' } }
const foreignMemory: MemoryAccess = { ...account, scope: { kind: 'project', projectId: 'project-two' } }
const mediaAccess: MediaAccess = { ...account, taskId: 'task-one', attemptId: 'attempt-one', generation: 1 }
const inputArtifact = { artifactId: 'sealed-image', contentHash: 'a'.repeat(64), mediaType: 'image/png' }
const at = '2026-11-07T08:00:00.000Z'
const local = { mock: false, destinations: [{ kind: 'local' as const }] }

function success<T>(value: T): ProviderResult<T> { return { ok: true, value } }
function failure(code: ProviderFailureCode) { return { ok: false, code } as const }
function accepted<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new Error(`Fixture call failed with ${result.code}`)
  return result.value
}
const unavailable = () => failure('unsupported_capability')
const lifecycle = { health: () => ({ status: 'ready' as const }), drain() {}, stop() {} }

function record(id: string, overrides: Partial<MemoryActiveRecord> = {}): MemoryActiveRecord {
  return { ...memoryAccess, id, revision: 1, sourceEventIds: ['source-one'], validFrom: at, origin: 'explicit',
    confidence: 1, state: 'active', value: { kind: 'fact', text: `Fixture fact ${id}` }, ...overrides }
}

function memoryProvider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return { ...lifecycle, capabilities: { ...local, snapshotVersion: 1 }, read: () => success(null), search: () => success([]),
    upsert: unavailable, supersede: unavailable, forget: unavailable, exportSnapshot: unavailable, importSnapshot: unavailable, ...overrides }
}

function mockMedia(pin: ProviderPin<'media'>, overrides: Partial<MediaProvider> = {}): MediaProvider {
  return { ...lifecycle, capabilities: { ...local, mock: true,
    formats: [{ modality: 'image', operations: ['generate'], maxWidth: 1024, maxHeight: 1024 }],
    cancellation: 'per-job', resources: { compute: 'cpu', exclusive: false }, pricing: { kind: 'free' } },
  submit: request => success({ provider: pin, operationId: request.operationId, handleId: `handle-${request.operationId}` }),
  inspect: () => success({ state: 'running' }), cancel: () => success({ state: 'cancelled' }), collect: unavailable, ...overrides }
}

function fixture(overrides: Partial<PluginConsumerPolicy> = {}) {
  const registry = createCapabilityRegistry()
  const token = Object.freeze({})
  const exclusions = new Set<string>()
  const jobs = new Map<string, MediaJobRequest>()
  const registrations = new Map<string, { dispose(): Promise<void> }>()
  const state = { current: true }
  onTestFinished(async () => { await registry.close() })
  const policy: PluginConsumerPolicy = {
    authorize(authority, use) {
      return authority === token && state.current && use.destinations.every(destination => destination.kind === 'local')
        && ('scope' in use.access ? sameMemoryAccess(use.access, memoryAccess) : sameMediaAccess(use.access, mediaAccess))
    },
    allowSource: (authority, access, id) => authority === token && sameMemoryAccess(access, memoryAccess) && id === 'source-one',
    isExcluded: (access, id) => sameMemoryAccess(access, memoryAccess) && exclusions.has(id),
    commitExclusion(authority, request) {
      if (authority !== token || !state.current || !sameMemoryAccess(request.access, memoryAccess)) return false
      exclusions.add(request.recordId)
      return true
    },
    allowArtifact: (authority, access, artifact) => authority === token && sameMediaAccess(access, mediaAccess)
      && artifact.artifactId === inputArtifact.artifactId && artifact.contentHash === inputArtifact.contentHash,
    isRecordedMediaJob(authority, request) {
      const job = jobs.get(request.handle.operationId)
      return authority === token && job !== undefined && sameMediaAccess(job.access, request.access)
        && sameProviderPin(job.handle.provider, request.handle.provider) && job.handle.handleId === request.handle.handleId
    },
    now: () => at,
    ...overrides,
  }
  async function register<K extends CapabilityKind>(kind: K, instanceId: string, create: (pin: ProviderPin<K>) => ProviderByKind[K]) {
    const registration = registry.registrar.register({
      manifest: { kind, pluginId: 'fixture-plugin', pluginVersion: '0.1.0', apiVersion: CAPABILITY_API_VERSION },
      configSchema: z.strictObject({}), start: (_config, context) => success(create(context.pin)),
    }, { instanceId, configRevision: 1 }, {})
    registrations.set(instanceId, registration)
    return accepted(await registration.ready)
  }
  return { registry, token, exclusions, jobs, state, register,
    dispose: (pin: ProviderPin) => registrations.get(pin.instanceId)!.dispose(), consumers: createPluginConsumers(registry, policy) }
}

const mediaInput: MediaSubmitRequest = { access: mediaAccess, operationId: 'image-operation', model: 'mock-model',
  workflowId: 'fixture', workflowVersion: '1', spec: { modality: 'image', operation: 'generate', width: 256, height: 256 } }

describe('core capability policy boundaries', () => {
  it('checks the trusted scope and declared destination before forwarding private input', async () => {
    const f = fixture()
    const read = vi.fn<MemoryProvider['read']>(() => success(record('fact')))
    const localPin = await f.register('memory', 'local', () => memoryProvider({ read }))
    const remotePin = await f.register('memory', 'remote', () => memoryProvider({ read,
      capabilities: { snapshotVersion: 1, mock: false, destinations: [{ kind: 'network', origin: 'https://other.example' }] } }))
    const input = { access: memoryAccess, recordId: 'fact' }
    expect(await f.consumers.memory.read({}, localPin, input)).toEqual(failure('permission_denied'))
    expect(await f.consumers.memory.read(f.token, localPin, { ...input, access: foreignMemory })).toEqual(failure('permission_denied'))
    expect(await f.consumers.memory.read(f.token, remotePin, input)).toEqual(failure('permission_denied'))
    expect(read).not.toHaveBeenCalled()
    expect(await f.consumers.memory.read(f.token, localPin, input)).toMatchObject({ ok: true, value: { id: 'fact' } })
    expect(read).toHaveBeenCalledOnce()
  })

  it('rejects cross-scope and malformed record replies and checks live disclosure after an awaited read', async () => {
    const f = fixture()
    const held = Promise.withResolvers<ProviderResult<MemoryRecord | null>>()
    const entered = Promise.withResolvers<void>()
    const read = vi.fn<MemoryProvider['read']>()
      .mockReturnValueOnce(success(record('fact', foreignMemory)))
      .mockReturnValueOnce({ ok: true, value: record('fact'), privateDetail: 'credential-bearing payload' } as ProviderResult<MemoryRecord>)
      .mockReturnValueOnce(success(record('fact', { sourceEventIds: ['hidden-source'] })))
      .mockImplementation(() => { entered.resolve(); return held.promise })
    const pin = await f.register('memory', 'scope-read', () => memoryProvider({ read }))
    const request = { access: memoryAccess, recordId: 'fact' }
    expect(await f.consumers.memory.read(f.token, pin, request)).toEqual(failure('invalid_result'))
    expect(await f.consumers.memory.read(f.token, pin, request)).toEqual(failure('invalid_result'))
    expect(await f.consumers.memory.read(f.token, pin, request)).toEqual(success(null))
    const pending = f.consumers.memory.read(f.token, pin, request)
    await entered.promise
    f.state.current = false
    held.resolve(success(record('fact')))
    expect(await pending).toEqual(failure('permission_denied'))

    f.state.current = true
    const abort = new AbortController()
    const ignoredAbort = Promise.withResolvers<ProviderResult<MemoryRecord | null>>()
    read.mockReturnValueOnce(ignoredAbort.promise)
    const cancelled = f.consumers.memory.read(f.token, pin, request, abort.signal)
    abort.abort()
    ignoredAbort.resolve(success(record('fact')))
    expect(await cancelled).toEqual(failure('cancelled'))
  })

  it('treats retrieval hits as candidates and returns only verified current record revisions', async () => {
    const f = fixture()
    const records = new Map([
      ['valid', record('valid')], ['foreign', record('foreign', foreignMemory)],
      ['stale', record('stale', { revision: 2 })], ['hidden', record('hidden', { sourceEventIds: ['private-source'] })],
    ])
    const read = vi.fn<MemoryProvider['read']>(request => success(records.get(request.recordId) ?? null))
    const memory = await f.register('memory', 'canonical', () => memoryProvider({ read }))
    const hits = ['valid', 'foreign', 'stale', 'hidden', 'forgotten'].map(recordId => ({
      recordId, revision: 1, score: 1, sourceEventIds: recordId === 'hidden' ? ['private-source'] : ['source-one'],
    }))
    const retrieve = await f.register('memory-retrieval', 'retrieval', () => ({ ...lifecycle, capabilities: local, search: () => success(hits) }))
    const request = { access: memoryAccess, query: 'fixture', limit: 5 }
    expect(await f.consumers.memory.search(f.token, retrieve, request)).toEqual(failure('provider_unavailable'))
    accepted(f.registry.select(memory))
    f.exclusions.add('forgotten')
    expect(await f.consumers.memory.search(f.token, retrieve, request)).toEqual(success([hits[0]]))
    expect(read.mock.calls.map(([input]) => input.recordId)).toEqual(['valid', 'foreign', 'stale'])
  })

  it('records forgetting before provider deletion and fences a stale snapshot on import or recall', async () => {
    const f = fixture()
    const forget = vi.fn<MemoryProvider['forget']>(request => {
      expect(f.exclusions.has(request.recordId)).toBe(true)
      return failure('provider_unavailable')
    })
    const read = vi.fn<MemoryProvider['read']>(() => success(record('forgotten')))
    const importSnapshot = vi.fn<MemoryProvider['importSnapshot']>(request => success({ count: request.snapshot.records.length }))
    const pin = await f.register('memory', 'forget', () => memoryProvider({ read, forget, importSnapshot }))
    const request = { access: memoryAccess, recordId: 'forgotten', expectedRevision: 1, forgottenAt: at }
    expect(await f.consumers.memory.forget({}, pin, request)).toEqual(failure('permission_denied'))
    expect(f.exclusions.size).toBe(0)
    expect(await f.consumers.memory.forget(f.token, pin, request)).toEqual(success({ state: 'pending' }))
    expect(await f.consumers.memory.read(f.token, pin, { access: memoryAccess, recordId: 'forgotten' })).toEqual(success(null))
    expect(read).not.toHaveBeenCalled()
    const stale = { version: 1, access: memoryAccess, records: [record('forgotten')] }
    expect(await f.consumers.memory.importSnapshot(f.token, pin, { access: memoryAccess, snapshot: stale })).toEqual(failure('permission_denied'))
    expect(importSnapshot).not.toHaveBeenCalled()
    const { value: _discarded, ...prior } = record('forgotten')
    const snapshot = { ...stale, records: [{ ...prior, state: 'forgotten', revision: 2, forgottenAt: at }] }
    expect(await f.consumers.memory.importSnapshot(f.token, pin, { access: memoryAccess, snapshot })).toEqual(success({ count: 1 }))
    expect(importSnapshot.mock.calls[0]?.[0].snapshot).toEqual(snapshot)
  })

  it('rechecks an earlier hit when canonical read authority changes during a later lookup', async () => {
    let token: unknown
    let canonicalRead = true
    const f = fixture({ authorize(authority, use) {
      return authority === token && (use.operation !== 'memory.read' || canonicalRead)
    } })
    token = f.token
    const later = Promise.withResolvers<ProviderResult<MemoryRecord | null>>()
    const entered = Promise.withResolvers<void>()
    const memory = await f.register('memory', 'canonical-revoke', () => memoryProvider({ read(request) {
      if (request.recordId === 'first') return success(record('first'))
      entered.resolve()
      return later.promise
    } }))
    accepted(f.registry.select(memory))
    const retrieval = await f.register('memory-retrieval', 'retrieval-revoke', () => ({
      ...lifecycle, capabilities: local, search: () => success(['first', 'second'].map(recordId => ({
        recordId, revision: 1, score: 1, sourceEventIds: ['source-one'],
      }))),
    }))
    const pending = f.consumers.memory.search(f.token, retrieval, { access: memoryAccess, query: 'test', limit: 2 })
    await entered.promise
    canonicalRead = false
    later.resolve(success(record('second')))
    expect(await pending).toEqual(success([]))
  })

  it('requires an explicit core exclusion for imported tombstones when the exclusion store is unavailable', async () => {
    const f = fixture({ isExcluded() { throw new Error('Core ledger unavailable') } })
    const importSnapshot = vi.fn<MemoryProvider['importSnapshot']>(() => success({ count: 1 }))
    const pin = await f.register('memory', 'import-fence', () => memoryProvider({ importSnapshot }))
    const { value: _discarded, ...previous } = record('forgotten')
    const snapshot = { version: 1, access: memoryAccess, records: [{ ...previous, revision: 2, state: 'forgotten', forgottenAt: at }] }
    expect(await f.consumers.memory.importSnapshot(f.token, pin, { access: memoryAccess, snapshot })).toEqual(failure('permission_denied'))
    expect(importSnapshot).not.toHaveBeenCalled()
  })

  it('requires approved input artifacts and reads back only a recorded job on its original provider pin', async () => {
    const f = fixture()
    const inspectA = vi.fn<MediaProvider['inspect']>(() => success({ state: 'running' }))
    const inspectB = vi.fn<MediaProvider['inspect']>(() => success({ state: 'queued' }))
    const submitA = vi.fn<MediaProvider['submit']>()
    const a = await f.register('media', 'origin', pin => mockMedia(pin, { inspect: inspectA,
      submit: submitA.mockImplementation(request => success({ provider: pin, operationId: request.operationId, handleId: 'owned-handle' })) }))
    const b = await f.register('media', 'new-default', pin => mockMedia(pin, { inspect: inspectB }))
    expect(await f.consumers.media.submit(f.token, a, { ...mediaInput, inputArtifacts: [{ ...inputArtifact, artifactId: '../../private' }] }))
      .toEqual(failure('permission_denied'))
    expect(submitA).not.toHaveBeenCalled()
    const handle = accepted(await f.consumers.media.submit(f.token, a, { ...mediaInput, inputArtifacts: [inputArtifact] }))
    const job = { access: mediaAccess, handle }
    f.jobs.set(handle.operationId, job)
    accepted(f.registry.select(b))
    expect(await f.consumers.media.inspect(f.token, { ...job, access: { ...mediaAccess, generation: 2 } })).toEqual(failure('permission_denied'))
    expect(await f.consumers.media.inspect(f.token, { ...job, handle: { ...handle, provider: b } })).toEqual(failure('permission_denied'))
    expect(await f.consumers.media.inspect(f.token, job)).toEqual(success({ state: 'running' }))
    expect(inspectA).toHaveBeenCalledOnce()
    expect(inspectB).not.toHaveBeenCalled()
  })

  it('keeps workflow child calls in the parent scope and revokes retained callbacks on return', async () => {
    let granted: unknown
    const runTool = vi.fn<NonNullable<PluginConsumerPolicy['runTool']>>(() => success('allowed result'))
    const intents = new Set<string>()
    const receipts: MediaJobRequest[] = []
    const f = fixture({ runTool, recordMediaIntent(_authority, request) { intents.add(request.operationId); return true },
    recordMediaHandle(_authority, request, handle) {
      receipts.push({ access: request.access, handle })
      return true
    }, authorize(authority, use) {
      return authority === granted && use.operation !== 'workflow.tool' && !('scope' in use.access)
        && sameMediaAccess(use.access, mediaAccess) && use.destinations.every(destination => destination.kind === 'local')
    } })
    granted = f.token
    const mediaSubmit = vi.fn<MediaProvider['submit']>()
    const media = await f.register('media', 'workflow-media', pin => mockMedia(pin, { submit: mediaSubmit.mockImplementation(request => {
      expect(intents.has(request.operationId)).toBe(true)
      return success({ provider: pin, operationId: request.operationId, handleId: 'workflow-handle' })
    }) }))
    accepted(f.registry.select(media))
    let retained: WorkflowServices | undefined
    const { access: _access, operationId: _operationId, ...mediaRequest } = mediaInput
    const workflow = await f.register('creation-workflow', 'workflow', () => ({ ...lifecycle,
      capabilities: { ...local, workflowVersion: '1', inputs: [], outputs: [{ name: 'status', type: 'text', required: true }],
        steps: [{ id: 'render', checkpoint: true }], requires: [{ kind: 'media', modality: 'image', operation: 'generate' },
          { kind: 'tool', toolId: 'publish' }] },
      async run(request, services, signal) {
        retained = services
        expect(await services.requestTool({ toolId: 'shell', args: {} }, signal)).toEqual(failure('unsupported_capability'))
        expect(await services.requestTool({ toolId: 'publish', args: { file: '../../secret' } }, signal)).toEqual(failure('permission_denied'))
        const forged = { ...mediaRequest, access: { ...mediaAccess, ownerId: 'foreign' } }
        expect(await services.requestMedia(forged, signal)).toEqual(failure('invalid_input'))
        accepted(await services.requestMedia(mediaRequest, signal))
        const output: Record<string, string> = { status: 'rendered' }
        if (request.operationId === 'workflow-invalid') output.extra = 'undeclared'
        return success({ kind: 'completed', output })
      },
    } satisfies CreationWorkflowProvider))
    const request = { access: mediaAccess, operationId: 'workflow-one', workflowVersion: '1', input: {} }
    expect(await f.consumers.workflow.run(f.token, workflow, request)).toEqual(success({ kind: 'completed', output: { status: 'rendered' } }))
    expect(mediaSubmit).toHaveBeenCalledOnce()
    expect(mediaSubmit.mock.calls[0]?.[0]).toMatchObject({ access: mediaAccess, operationId: expect.stringMatching(/^workflow-media-/u) })
    expect(runTool).not.toHaveBeenCalled()
    expect(await retained!.requestMedia(mediaRequest, new AbortController().signal)).toEqual(failure('cancelled'))
    expect(mediaSubmit).toHaveBeenCalledOnce()
    expect(receipts).toHaveLength(1)
    expect(await f.consumers.workflow.run(f.token, workflow, { ...request, operationId: 'workflow-invalid' })).toEqual(failure('invalid_result'))
    expect(receipts).toHaveLength(2)
    expect(receipts[1]).toMatchObject({ access: mediaAccess, handle: { provider: media, handleId: 'workflow-handle' } })
  })

  it.each([false, true])('denies tool dispatch queued after a workflow returns (async %s)', async asyncResult => {
    const runTool = vi.fn<NonNullable<PluginConsumerPolicy['runTool']>>(() => success('unexpected'))
    const f = fixture({ runTool })
    const observed = Promise.withResolvers<unknown>()
    const pin = await f.register('creation-workflow', 'return-fence', () => ({ ...lifecycle,
      capabilities: { ...local, workflowVersion: '1', inputs: [], outputs: [], steps: [{ id: 'step', checkpoint: false }],
        requires: [{ kind: 'tool', toolId: 'publish' }] },
      run(_request, services, signal) {
        queueMicrotask(() => { void Promise.resolve(services.requestTool({ toolId: 'publish', args: {} }, signal)).then(observed.resolve) })
        const result = success({ kind: 'completed' as const, output: {} })
        return asyncResult ? Promise.resolve(result) : result
      },
    }))
    const request = { access: mediaAccess, operationId: 'return-one', workflowVersion: '1', input: {} }
    expect(await f.consumers.workflow.run(f.token, pin, request)).toEqual(success({ kind: 'completed', output: {} }))
    expect(await observed.promise).toEqual(failure('cancelled'))
    expect(runTool).not.toHaveBeenCalled()
  })

  it('denies new workflow child calls while the exact provider is draining', async () => {
    const runTool = vi.fn<NonNullable<PluginConsumerPolicy['runTool']>>(() => success('unexpected'))
    const f = fixture({ runTool })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pin = await f.register('creation-workflow', 'drain-fence', () => ({ ...lifecycle,
      capabilities: { ...local, workflowVersion: '1', inputs: [], outputs: [], steps: [{ id: 'step', checkpoint: false }],
        requires: [{ kind: 'tool', toolId: 'publish' }] },
      async run(_request, services, signal) {
        entered.resolve()
        await release.promise
        expect(await services.requestTool({ toolId: 'publish', args: {} }, signal)).toEqual(failure('provider_unavailable'))
        return success({ kind: 'completed', output: {} })
      },
    }))
    const pending = f.consumers.workflow.run(f.token, pin, { access: mediaAccess, operationId: 'draining', workflowVersion: '1', input: {} })
    await entered.promise
    const disposing = f.dispose(pin)
    release.resolve()
    expect(await pending).toEqual(success({ kind: 'completed', output: {} }))
    await disposing
    expect(runTool).not.toHaveBeenCalled()
  })
})
