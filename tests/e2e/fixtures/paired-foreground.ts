import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { decodeWorkerReport, workerReportInstructions } from '../../../packages/personal-agent/src/runtime/reports.js'
import { model } from './paired-model.js'

export const foregroundPreset = `- insert:
    - id: paired-foreground-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: paired-text
        plugins:
          - name: ${JSON.stringify(fileURLToPath(new URL('./foreground-text-only.mjs', import.meta.url)))}
`

interface NativeRpc {
  rpc<T>(method: string, payload: unknown, timeout?: number): Promise<T>
}

interface AssistantRecord {
  event: {
    type: string
    seq: number
    data: { interrupted?: boolean; message: { content: { type: string; text?: string }[] } }
  }
}

function decodeReport({ event }: AssistantRecord, cursor: string) {
  expect(event.type).toBe('assistant/message')
  expect(event.data.interrupted).not.toBe(true)
  const contents = event.data.message.content
  expect(contents.every(block => block.type === 'text')).toBe(true)
  const report = decodeWorkerReport(contents.map(block => block.text).join(''))
  assert.ok(report?.cursor === cursor, 'Invalid foreground report')
  return report
}

export async function prepareForeground({ rpc }: NativeRpc, cwd: string, verifyExchange: () => void) {
  const session = await rpc<{ sessionId: string; agentPreset: string }>('session/create', {
    args: { request: { cwd, agentPreset: 'paired-text' } },
  })
  expect(session.agentPreset).toBe('paired-text')
  const { sessionId } = session
  const selected = await rpc('session/selectModel', { args: { request: {
    sessionId, provider: 'deepseek-official', model, reasoningEffort: 'off',
  } } })
  expect(selected).toMatchObject({ selected: { provider: 'deepseek-official', model } })
  return async (host: NativeRpc, outcome: string, cursor: string) => {
    const { cursor: afterSeq } = await host.rpc<{ cursor: number }>('session/state', { args: { request: { sessionId } } })
    const startedAt = performance.now()
    const sent = await host.rpc('session/prompt', { args: { request: { sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: `${workerReportInstructions(cursor)}\n\n${outcome}` }],
    } } })
    expect(sent).toEqual({ accepted: true })
    const result = await host.rpc<{ reason: string; output: { truncated: boolean; records: AssistantRecord[] } }>(
      'session/wait', { args: { request: { sessionId, afterSeq, timeoutMs: 30_000, maxMessages: 2 } } }, 35_000)
    verifyExchange()
    const elapsedMs = Math.round(performance.now() - startedAt)
    expect({ reason: result.reason, truncated: result.output.truncated, messages: result.output.records.length })
      .toEqual({ reason: 'idle', truncated: false, messages: 1 })
    const record = result.output.records[0]!
    const report = decodeReport(record, cursor)
    return {
      report,
      elapsedMs,
      async readback(reopened: NativeRpc) {
        const { seq } = record.event
        const page = await reopened.rpc<{ records: AssistantRecord[] }>('session/page', {
          args: { request: { address: { kind: 'session', sessionId }, throughSeq: seq, maxMessages: 1 } },
        })
        const durable = page.records.find(entry => entry.event.seq === seq)
        assert.ok(durable, 'Missing committed foreground report after restart')
        return decodeReport(durable, cursor)
      },
    }
  }
}
