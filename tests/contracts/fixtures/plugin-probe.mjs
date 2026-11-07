import assert from 'node:assert/strict'
import { definition as memory } from '@mosbot-ai/dshpa-example-memory'
import { definition as media } from '@mosbot-ai/dshpa-example-media-mock'
import { assertMemorySnapshotRoundTrip, assertMockMedia, assertPinnedMediaHandle } from '@mosbot-ai/dshpa-plugin-testkit'
import { capabilityRegistryFor } from './node_modules/@mosbot-ai/dshpa/lib/runtime/capability-registry.js'
import { createPluginConsumers } from './node_modules/@mosbot-ai/dshpa/lib/runtime/plugin-consumers.js'

export const inject = ['appReady', 'appExit', 'loader', 'dshpaPlugins']

const scope = { ownerId: 'fixture-owner', profileId: 'fixture-profile' }
const memoryAccess = { ...scope, scope: { kind: 'project', projectId: 'fixture-project' } }
const mediaAccess = { ...scope, taskId: 'fixture-task', attemptId: 'fixture-attempt', generation: 1 }
const mediaRequest = { access: mediaAccess, operationId: 'fixture-media-operation', workflowId: 'fixture-workflow',
  workflowVersion: '1.0.0', model: 'mock-fixture', spec: { modality: 'image', operation: 'generate', width: 128, height: 128 } }
const unsupported = { ok: false, code: 'provider_unavailable' }

function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.value
}

function pin(definition, instanceId, configRevision = 1) {
  const { kind, pluginId, pluginVersion } = definition.manifest
  return { kind, pluginId, pluginVersion, instanceId, configRevision }
}

function mounted(ctx, id) {
  const entry = [...ctx.loader.entries()].find(row => row.options.id === id)
  assert.ok(entry?.fiber, `The native loader did not mount ${id}`)
  return entry.fiber
}

async function ready(registry, pin) {
  for (let n = 0; n < 100; n++) {
    const health = await registry.health(pin)
    if (health.ok && health.value.status === 'ready') return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`The native provider did not become ready: ${pin.instanceId}`)
}

async function exerciseDisposalDuringStart(registrar) {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const lifecycle = []
  const pending = registrar.register({ ...memory, async start(config, context) {
    entered.resolve(context.signal)
    await release.promise
    const provider = value(await memory.start(config, context))
    return { ok: true, value: { ...provider,
      drain() { lifecycle.push('drain'); provider.drain() },
      stop() { lifecycle.push('stop'); provider.stop() },
    } }
  } }, { instanceId: 'unloaded-during-start', configRevision: 1 }, {})
  const signal = await entered.promise
  let disposed = false
  const disposal = pending.dispose().then(() => { disposed = true })
  try {
    assert.deepEqual(await pending.ready, { ok: false, code: 'cancelled' })
    assert.equal(signal.aborted, true)
    assert.equal(disposed, false)
  } finally {
    release.resolve()
    await disposal
  }
  assert.deepEqual(lifecycle, ['drain', 'stop'])
}

async function exerciseScopedConsumer(registry, pin, template) {
  const token = Object.freeze({})
  let localAllowed = true
  const consumer = createPluginConsumers(registry, {
    authorize(authority, use) {
      const { access, operation, destinations } = use
      return authority === token && operation.startsWith('memory.') && access.ownerId === memoryAccess.ownerId
        && access.profileId === memoryAccess.profileId && access.scope.kind === 'project'
        && access.scope.projectId === memoryAccess.scope.projectId && localAllowed
        && destinations.length === 1 && destinations[0].kind === 'local'
    },
    allowSource: (authority, _access, id) => authority === token && template.sourceEventIds.includes(id),
    isExcluded: () => false, commitExclusion: () => false, allowArtifact: () => false, isRecordedMediaJob: () => false,
    now: () => '2026-06-02T00:00:00.000Z',
  })
  const record = { ...template, id: 'scoped-consumer-fixture' }
  const input = { access: memoryAccess, record, expectedRevision: null }
  const otherAccess = { ...memoryAccess, scope: { kind: 'project', projectId: 'other-project' } }
  const denied = { ok: false, code: 'permission_denied' }
  assert.deepEqual(await consumer.memory.upsert(token, pin, { ...input, access: otherAccess,
    record: { ...record, ...otherAccess } }), denied)
  assert.equal(value(await registry.invoke(pin, (provider, signal) => provider.read({
    access: otherAccess, recordId: record.id,
  }, signal))), null, 'A denied scope reached the installed provider')
  localAllowed = false
  assert.deepEqual(await consumer.memory.upsert(token, pin, input), denied)
  assert.equal(value(await registry.invoke(pin, (provider, signal) => provider.read({
    access: memoryAccess, recordId: record.id,
  }, signal))), null, 'A denied destination reached the installed provider')
  localAllowed = true
  assert.deepEqual(value(await consumer.memory.upsert(token, pin, input)), { id: record.id, revision: 1 })
  assert.deepEqual(value(await consumer.memory.read(token, pin, { access: memoryAccess, recordId: record.id })), record)
}

async function run(ctx) {
  const registry = capabilityRegistryFor(ctx)
  assert.ok(registry)
  const registrar = ctx.get('dshpaPlugins')
  assert.ok(registrar)
  for (const member of ['invoke', 'select', 'inspect']) assert.equal(registrar[member], undefined)

  const memoryFiber = mounted(ctx, 'dshpa-example-memory')
  const mediaFiber = mounted(ctx, 'dshpa-example-media-mock')
  const memoryPin = pin(memory, 'example-memory')
  const mediaPin = pin(media, 'example-media-mock')
  await Promise.all([ready(registry, memoryPin), ready(registry, mediaPin)])

  let started = false
  const incompatible = registrar.register({ ...memory, manifest: { ...memory.manifest, apiVersion: 9 }, start() {
    started = true
    assert.fail('Incompatible plugin ran its start callback')
  } }, { instanceId: 'incompatible-memory', configRevision: 1 }, {})
  assert.deepEqual(await incompatible.ready, { ok: false, code: 'incompatible_version' })
  assert.equal(started, false)
  await incompatible.dispose()
  const absent = await registry.invoke(pin(memory, 'missing-memory'), () => assert.fail('Missing provider was invoked'))
  assert.deepEqual(absent, unsupported)

  const badConfig = registrar.register(memory, { instanceId: 'invalid-memory', configRevision: 1 }, { maxRecords: -1 })
  assert.deepEqual(await badConfig.ready, { ok: false, code: 'invalid_config' })
  await badConfig.dispose()
  await exerciseDisposalDuringStart(registrar)

  const target = registrar.register(memory, { instanceId: 'memory-copy', configRevision: 2 }, {})
  const secondMedia = registrar.register(media, { instanceId: 'media-copy', configRevision: 2 }, {})
  try {
    const targetPin = value(await target.ready)
    const newMediaPin = value(await secondMedia.ready)
    const validFrom = '2026-06-01T00:00:00.000Z'
    const record = { ...memoryAccess, state: 'active', revision: 1, sourceEventIds: ['fixture-source-a', 'fixture-source-b'],
      validFrom, origin: 'explicit', confidence: 1 }
    const active = { ...record, id: 'fixture-active', value: { kind: 'fact', text: 'fixture violet' } }
    const forgotten = { ...record, id: 'fixture-forgotten', value: { kind: 'fact', text: 'fixture amber' },
      origin: 'inferred', confidence: 0.75, validUntil: '2026-12-01T00:00:00.000Z' }
    const imported = value(await registry.invoke(memoryPin, (source, signal) => registry.invoke(targetPin, async (destination, childSignal) => ({
      ok: true,
      value: await assertMemorySnapshotRoundTrip(source, destination, { access: memoryAccess, active, forget: forgotten,
        activeQuery: 'violet', forgottenQuery: 'amber', forgottenAt: '2026-06-02T00:00:00.000Z' }, childSignal),
    }), signal)))
    assert.deepEqual(imported.records.map(item => item.id).sort(), ['fixture-active', 'fixture-forgotten'])
    const crossScope = { ...memoryAccess, scope: { kind: 'project', projectId: 'other-project' } }
    assert.equal(value(await registry.invoke(targetPin, (provider, signal) => provider.read({ access: crossScope, recordId: active.id }, signal))), null)
    const stale = await registry.invoke(targetPin, (provider, signal) => provider.upsert({ access: memoryAccess,
      record: forgotten, expectedRevision: null }, signal))
    assert.deepEqual(stale, { ok: false, code: 'conflict' })
    const successor = { ...active, id: 'fixture-successor', sourceEventIds: ['fixture-correction'], validFrom: '2026-06-03T00:00:00.000Z' }
    const superseded = value(await registry.invoke(targetPin, (provider, signal) => provider.supersede({ access: memoryAccess,
      recordId: active.id, expectedRevision: 1, replacement: successor }, signal)))
    assert.deepEqual(superseded, { ...active, state: 'superseded', revision: 2, validUntil: successor.validFrom, supersededBy: successor.id })
    await exerciseScopedConsumer(registry, targetPin, active)
    await memoryFiber.dispose()
    assert.deepEqual(await registry.health(memoryPin), unsupported)
    assert.equal(value(await registry.health(targetPin)).status, 'ready')

    assert.deepEqual(registry.selected('media'), { ok: false, code: 'not_found' })
    assert.deepEqual(value(registry.select(mediaPin)), mediaPin)
    assert.deepEqual(value(registry.selected('media')), mediaPin)
    const handle = assertPinnedMediaHandle(value(await registry.invoke(mediaPin, (provider, signal) => {
      assertMockMedia(provider)
      return provider.submit(mediaRequest, signal)
    })), mediaPin)
    assert.match(handle.handleId, /^mock-job-/u)
    assert.deepEqual(value(await registry.invoke(mediaPin, (provider, signal) => provider.submit(mediaRequest, signal))), handle)
    assert.deepEqual(value(registry.select(newMediaPin)), newMediaPin)
    assert.deepEqual(value(registry.selected('media')), newMediaPin)
    const job = { access: mediaAccess, handle }
    const wrongProvider = await registry.invoke(newMediaPin, (provider, signal) => provider.inspect(job, signal))
    assert.deepEqual(wrongProvider, { ok: false, code: 'not_found' })
    assert.deepEqual(await registry.invoke(mediaPin, (provider, signal) => provider.inspect({
      ...job, access: { ...mediaAccess, generation: 2 },
    }, signal)), { ok: false, code: 'not_found' })
    assert.equal(value(await registry.invoke(mediaPin, (provider, signal) => provider.inspect(job, signal))).state, 'succeeded')
    const assets = value(await registry.invoke(mediaPin, (provider, signal) => provider.collect(job, signal)))
    assert.equal(assets.length, 1)
    assert.match(assets[0].assetId, /^mock-asset-/u)
    const pending = value(await registry.invoke(newMediaPin, (provider, signal) => provider.submit({
      ...mediaRequest, operationId: 'fixture-cancelled-media',
    }, signal)))
    const cancelled = { access: mediaAccess, handle: pending }
    assert.deepEqual(value(await registry.invoke(newMediaPin, (provider, signal) => provider.cancel(cancelled, signal))), { state: 'cancelled' })
    assert.deepEqual(await registry.invoke(newMediaPin, (provider, signal) => provider.collect(cancelled, signal)), { ok: false, code: 'conflict' })

    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const activeCall = registry.invoke(mediaPin, async (provider, signal) => {
      entered.resolve(signal)
      await release.promise
      return { ok: true, value: await provider.health(signal) }
    })
    const signal = await entered.promise
    let disposed = false
    const disposal = mediaFiber.dispose().then(() => { disposed = true })
    try {
      for (let n = 0; n < 100 && (await registry.health(mediaPin)).ok; n++) await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(signal.aborted, false)
      assert.equal(disposed, false, 'The native fiber stopped before in-flight work drained')
      assert.deepEqual(await registry.invoke(mediaPin, () => assert.fail('Unloading provider admitted new work')), unsupported)
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      release.resolve()
      await disposal
    }
    assert.deepEqual(value(await activeCall), { status: 'unavailable' })
    assert.deepEqual(await registry.health(mediaPin), unsupported)
    assert.equal(value(await registry.health(newMediaPin)).status, 'ready')
  } finally {
    await Promise.all([target.dispose(), secondMedia.dispose()])
  }
  process.stdout.write('DSHPA_PLUGIN_CONTRACTS_PASSED\n')
}

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    void run(ctx).then(() => ctx.appExit(0), error => {
      console.error(error)
      ctx.appExit(1)
    })
  }))
}
