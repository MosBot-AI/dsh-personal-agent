import type { IncomingMessage, ServerResponse } from 'node:http'

export function briefStallProvider(waitsFor: string, ownerAnswer: string, stallAt: 'headers' | 'stream') {
  let calls = 0
  let admittedAnswer = false
  let stalledStreamClosed = false
  let requestFault = false
  return {
    async respond(request: IncomingMessage, response: ServerResponse) {
      try {
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of request) {
          const data = Buffer.from(chunk)
          bytes += data.length
          if (bytes > 32_768) throw Error('Fixture request exceeded its bound')
          chunks.push(data)
        }
        const body = Buffer.concat(chunks).toString('utf8')
        calls += 1
        if (request.method !== 'POST' || request.url !== '/v1/messages' || calls > 2
          || JSON.parse(body).model !== 'deepseek-flash') throw Error('Unexpected fixture request')
        if (calls === 2) {
          admittedAnswer = body.includes(JSON.stringify(ownerAnswer).slice(1, -1))
          if (!admittedAnswer) throw Error('Resumed fixture request omitted the owner answer')
          response.once('close', () => { stalledStreamClosed = true })
          if (stallAt === 'headers') return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, payload: object = {}) => response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
        send('message_start', { message: { type: 'message', id: 'fixture-' + calls, role: 'assistant',
          model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } })
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        if (calls === 2) {
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '{' } })
          return
        }
        const report = { kind: 'waiting', cursor: 'package-start', summary: 'Two facts are missing.', wait: {
          reason: 'input', referenceId: waitsFor, resumeCondition: 'Who is the audience, and when does the pilot open?',
        } }
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: JSON.stringify(report) } })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 80 } })
        send('message_stop')
        response.end()
      } catch {
        requestFault = true
        if (response.headersSent) response.destroy()
        else response.writeHead(500).end()
      }
    },
    snapshot() { return { calls, admittedAnswer, stalledStreamClosed, requestFault } },
  }
}
