import { readFileSync } from 'node:fs'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { OwnerId, ProfileId } from '../domain/model.js'
import { computeLimitsSchema, meteredStream, type WorkerComputeOptions } from './compute.js'
import type { RoutingAssessor } from './router.js'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'dshpa-routing': true
  }
}

const activeAssessments = new WeakSet<Pick<LlmRuntime, 'stream'>>()

export interface RoutingComputeOptions extends WorkerComputeOptions {
  readonly ownerId: OwnerId
  readonly profileId: ProfileId
}

/** Submit a single bounded DSH request with no tools or native Session. */
export function createDshRoutingAssessor(
  llm: Pick<LlmRuntime, 'stream'>,
  route: { provider: string; model: string },
  compute?: RoutingComputeOptions,
): RoutingAssessor {
  const document = readFileSync(new URL('../../prompts/router.md', import.meta.url), 'utf8')
  const system = /\n## Instructions\n\n([\s\S]+)$/u.exec(document)?.[1]?.trim()
  if (!system) throw new Error('The dshpa Router instructions are missing')
  const { provider, model } = route
  const limits = compute && computeLimitsSchema.parse(compute.limits ?? {})
  return async (batch, signal) => {
    if (activeAssessments.has(llm)) throw new Error('The DSH routing assessor is still in flight')
    activeAssessments.add(llm)
    try {
      let text = ''
      const requestSignal = limits ? AbortSignal.any([signal, AbortSignal.timeout(limits.maxWallTimeMs)]) : signal
      const request: GenerateOptions = {
        provider, model, system, signal: requestSignal, purpose: 'dshpa-routing', maxTokens: limits?.maxOutputTokens ?? 1_536,
        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(batch) }] }],
      }
      const stream = compute && limits ? meteredStream({
        budget: compute.budget, request: Object.freeze(request), limits,
        scope: { ownerId: compute.ownerId, profileId: compute.profileId, unattended: true },
        next: () => llm.stream(request), onIssue: () => {},
      }) : llm.stream(request)
      for await (const chunk of stream) {
        requestSignal.throwIfAborted()
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
