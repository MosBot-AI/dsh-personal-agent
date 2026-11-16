import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import type { InboxRequest, InboxResponse } from '../../../packages/personal-agent/src/inbox/protocol.js'
import { prepareForeground } from './paired-foreground.js'
import type { openPairedModel } from './paired-model.js'

interface Resident {
  rpc<T>(method: string, payload: unknown): Promise<T>
  inbox(request: InboxRequest): Promise<InboxResponse>
  stop(): Promise<void>
}

const template = '## Inventory review {{request}}\n- Decision: {{decision}}\n- Reason: {{reason}}'
const examples = [
  { request: 'IR-21', units: 18, supportingRecord: true, decision: 'Approve', reason: 'Within limit with supporting record' },
  { request: 'IR-26', units: 64, supportingRecord: true, decision: 'Return', reason: 'Exceeds unit limit' },
  { request: 'IR-42', units: 32, supportingRecord: false, decision: 'Return', reason: 'Missing supporting record' },
]
const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

const reviewCases = examples.map(({ request, units, supportingRecord, decision, reason }) => ({
  request,
  cursor: `review-${request}`,
  expected: `## Inventory review ${request}\n- Decision: ${decision}\n- Reason: ${reason}`,
  outcome: [
    'Review this fictional inventory change using the following policy.',
    'The unit limit is 50. Any change above it must be returned with reason Exceeds unit limit.',
    'Within the limit, return a change without a supporting record with reason Missing supporting record.',
    'Otherwise approve it with reason Within limit with supporting record.',
    'Return kind ready with empty artifactIds. The summary string is the final Markdown that the owner will read.',
    'Use exactly these three lines, without a code fence or trailing newline:',
    `## Inventory review ${request}`,
    '- Decision: <Approve or Return>',
    '- Reason: <the matching policy reason>',
    `Change ${request}: ${units} units, supporting record ${supportingRecord ? 'present' : 'absent'}.`,
  ].join('\n'),
}))

export const reviewCount = reviewCases.length
type PairedModel = Awaited<ReturnType<typeof openPairedModel>>

export async function verifyForegroundReviews(first: Resident, restart: () => Promise<Resident>,
  workRoot: string, pairedModel: PairedModel) {
  const prompt = await prepareForeground(first, workRoot, pairedModel.check)
  const results = []
  for (const { request, cursor, outcome, expected } of reviewCases) {
    pairedModel.begin('foreground', outcome)
    const result = await prompt(first, outcome, cursor)
    assert.ok(result.report.kind === 'ready' && result.report.artifactIds.length === 0)
    expect(result.report.summary).toBe(expected)
    results.push({ result, measurement: { request, elapsedMs: result.elapsedMs, ...pairedModel.finish('foreground') } })
  }
  await first.stop()
  const reopened = await restart()
  for (const { result } of results) expect(await result.readback(reopened)).toEqual(result.report)
  return { reopened, measurements: results.map(({ measurement }) => measurement) }
}

export async function verifyLiveReview(first: Resident, restart: () => Promise<Resident>, workRoot: string, pairedModel?: PairedModel) {
  const { sessionId } = await first.rpc<{ sessionId: string }>('session/create', { args: { request: { cwd: workRoot } } })
  const project = await first.inbox({ type: 'create_project', commandId: 'inventory-review-project',
    title: 'Fictional inventory control', purpose: 'Verify three independent inventory change reviews.' })
  assert.ok(project.ok && project.kind === 'updated' && project.projectId)
  const { projectId } = project
  const proofs = []
  const measurements = []
  for (const { request, cursor, outcome, expected } of reviewCases) {
    const created = await first.inbox({ type: 'create_task', commandId: `inventory-task-${request}`, projectId, sessionId, outcome })
    assert.ok(created.ok && created.kind === 'updated' && created.taskId)
    const { taskId } = created
    async function task() {
      const status = await first.inbox({ type: 'snapshot' })
      assert.ok(status.ok && status.kind === 'snapshot')
      const item = status.snapshot.tasks.find(entry => entry.id === taskId)
      assert.ok(item)
      return item
    }
    const queued = await task()
    expect(queued).toMatchObject({ status: 'queued', artifacts: [] })
    pairedModel?.begin('worker', outcome)
    const startedAt = performance.now()
    expect(await first.inbox({ type: 'start', taskId, expectedVersion: queued.version, cursor }))
      .toMatchObject({ ok: true })
    const candidate = await vi.waitFor(async () => {
      const item = await task()
      expect(item.runtime).toBe('inactive')
      expect(item.status).not.toBe('queued')
      return item
    }, { timeout: 35_000 })
    pairedModel?.check()
    expect(candidate).toMatchObject({ status: 'verifying', canAccept: true })
    expect(candidate.artifacts).toHaveLength(1)
    const artifactId = candidate.artifacts[0]!.id
    const read = { type: 'artifact', taskId, artifactId } as const
    const artifact = await first.inbox(read)
    const elapsedMs = Math.round(performance.now() - startedAt)
    expect(artifact).toMatchObject({ kind: 'artifact', artifact: { mediaType: 'text/markdown', text: expected } })
    if (pairedModel) measurements.push({ request, elapsedMs, ...pairedModel.finish('worker') })
    expect(await first.inbox({ type: 'accept_result', taskId, expectedVersion: candidate.version })).toMatchObject({ ok: true })
    expect(await task()).toMatchObject({ status: 'completed', runtime: 'inactive' })
    proofs.push({ source: { taskId, artifactId }, read, artifact, digest: sha256(expected) })
  }
  expect(new Set(proofs.map(proof => proof.source.artifactId)).size).toBe(reviewCount)

  const skill = { projectId, skillId: randomUUID() }
  const heldOut = examples[2]!
  const draft = { name: 'Inventory review format', template, sources: proofs.slice(0, 2).map(proof => proof.source),
    fixtures: [{ source: proofs[2]!.source, inputs: { request: heldOut.request, decision: heldOut.decision, reason: heldOut.reason } }] }
  const propose = { type: 'skill_propose', ...skill, draft, expectedLatest: 0 } as const
  const initial = await first.inbox({ ...propose, draft: { ...draft, template: template.replace('Reason:', 'Finding:') } })
  assert.ok(initial.ok && initial.kind === 'skill_revision', JSON.stringify(initial))
  const invalid = { ...skill, revision: initial.detail.revision, digest: initial.detail.digest }
  expect(await first.inbox({ type: 'skill_evaluate', ...invalid })).toMatchObject({ detail: { evaluation: [false] } })
  expect(await first.inbox({ type: 'skill_activate', ...invalid, expectedSelection: 0 }))
    .toEqual({ ok: false, code: 'skill_evaluation_required' })

  const corrected = await first.inbox({ ...propose, expectedLatest: initial.detail.revision })
  assert.ok(corrected.ok && corrected.kind === 'skill_revision', JSON.stringify(corrected))
  const exact = { ...skill, revision: corrected.detail.revision, digest: corrected.detail.digest }
  expect(exact.revision).toBe(2)
  expect(corrected.detail.spec).toMatchObject({ sources: proofs.slice(0, 2).map(({ source, digest }) => ({ ...source, digest })),
    fixtures: [{ source: { ...proofs[2]!.source, digest: proofs[2]!.digest } }] })
  expect(await first.inbox({ type: 'skill_evaluate', ...exact })).toMatchObject({ detail: { evaluation: [true] } })
  expect(await first.inbox({ type: 'skill_activate', ...exact, expectedSelection: 0 })).toMatchObject({ skill: { active: 2 } })
  const run = { type: 'skill_run', ...exact, runId: randomUUID(),
    inputs: { request: 'IR-60', decision: 'Approve', reason: 'Within limit with supporting record' } } as const
  const output = '## Inventory review IR-60\n- Decision: Approve\n- Reason: Within limit with supporting record'
  expect(await first.inbox(run)).toMatchObject({ kind: 'skill_output', text: output, feedback: null })
  expect(await first.inbox({ type: 'skill_feedback', ...exact, runId: run.runId, feedback: 'accepted' }))
    .toMatchObject({ detail: { accepted: 1 } })
  await first.stop()

  const reopened = await restart()
  expect(await reopened.inbox({ type: 'skill_inspect', ...skill, revision: 2 }))
    .toMatchObject({ skill: { active: 2, selection: 1 }, detail: { digest: exact.digest, accepted: 1, evaluation: [true] } })
  expect(await reopened.inbox(run)).toMatchObject({ kind: 'skill_output', text: output, feedback: 'accepted' })
  expect(await reopened.inbox({ ...run, inputs: { ...run.inputs, request: 'IR-61' } })).toEqual({ ok: false, code: 'version_conflict' })
  for (const proof of proofs) expect(await reopened.inbox(proof.read)).toEqual(proof.artifact)
  return { reopened, taskIds: proofs.map(proof => proof.source.taskId), measurements }
}
