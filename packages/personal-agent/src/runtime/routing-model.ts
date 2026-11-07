import { readFileSync } from 'node:fs'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { RoutingAssessor } from './router.js'

declare module '@deepseek-ai/dsh-llm' {
  interface LlmRequestPurposeMap {
    'dshpa-routing': true
  }
}

const activeAssessments = new WeakSet<Pick<LlmRuntime, 'stream'>>()

/** Submit a single bounded DSH request with no tools or native Session. */
export function createDshRoutingAssessor(
  llm: Pick<LlmRuntime, 'stream'>,
  route: { provider: string; model: string },
): RoutingAssessor {
  const document = readFileSync(new URL('../../prompts/router.md', import.meta.url), 'utf8')
  const system = /\n## Instructions\n\n([\s\S]+)$/u.exec(document)?.[1]?.trim()
  if (!system) throw new Error('The dshpa Router instructions are missing')
  const { provider, model } = route
  return async (batch, signal) => {
    if (activeAssessments.has(llm)) throw new Error('The DSH routing assessor is still in flight')
    activeAssessments.add(llm)
    try {
      let text = ''
      for await (const chunk of llm.stream({
        provider, model, system, signal, purpose: 'dshpa-routing', maxTokens: 1_536,
        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(batch) }] }],
      })) {
        signal.throwIfAborted()
        if (chunk.type === 'text-delta') {
          text += chunk.text
          if (Buffer.byteLength(text) > 32_768) throw new Error('Routing assessment output is too large')
        }
        if (chunk.type === 'finish') {
          if (chunk.reason.kind !== 'stop') throw new Error('Routing assessment did not finish')
          return JSON.parse(text) as unknown
        }
      }
      throw new Error('Routing assessment ended without a result')
    } finally {
      activeAssessments.delete(llm)
    }
  }
}
