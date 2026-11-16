import { appendFileSync } from 'node:fs'
import { decodeWorkerReport } from './node_modules/@mosbot-ai/dshpa/lib/runtime/reports.js'

const destination = new URL('./brief-resume-trace.jsonl', import.meta.url)
const cursors = new Set(['package-start', 'brief-answer'])

export function apply(ctx) {
  const current = new WeakMap()
  record('package-start', 'trace-ready')
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      const cursor = event.data.source.kind === 'dshpa-work-input' && event.data.source.cursor
      if (cursors.has(cursor)) {
        current.set(session, cursor)
        record(cursor, 'input-admitted')
      }
      return
    }
    const cursor = current.get(session)
    if (!cursor) return
    if (event.type === 'assistant/message') {
      const { content } = event.data.message
      const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      const report = event.data.interrupted ? undefined : decodeWorkerReport(text)
      record(cursor, report?.cursor === cursor ? 'report-' + report.kind : 'report-unavailable')
    } else if (event.type === 'turn/end') {
      record(cursor, event.data.reason.kind === 'completed' ? 'turn-completed' : 'turn-ended')
      current.delete(session)
    }
  })
}

function record(cursor, phase) {
  try {
    appendFileSync(destination, JSON.stringify({ cursor, phase }) + '\n', { mode: 0o600 })
  } catch {
    // Observation never controls admission or delivery.
  }
}
