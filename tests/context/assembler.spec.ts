import { describe, expect, it } from 'vitest'
import { assembleContext, type ContextAssembly } from '../../packages/personal-agent/src/context/assembler.js'
import { sourceEventIdSchema } from '../../packages/personal-agent/src/domain/model.js'

const defaults: ContextAssembly = {
  fixedInstructions: 'Fixed report envelope',
  currentInstructions: '  当前指令 preserve these spaces  ',
  contextWindow: 1_200,
  outputReserve: 200,
  maxInputBytes: 8_192,
  estimateTokens: text => Buffer.byteLength(text),
  sections: {},
}

describe('sectioned context budget', () => {
  it('retains live instructions verbatim and spills oversized evidence to an exact pointer', () => {
    const result = assembleContext({ ...defaults, sections: {
      authoritative: [{ text: 'Current authorized objective' }],
      recent: [{ text: 'Recent approved change' }],
      retrieval: [{ text: '证据'.repeat(5_000), pointer: '{"kind":"event","eventId":"exact-event"}' }],
      checkpoint: [{ text: 'Retained checkpoint reference' }],
    } })
    expect(result).toMatchObject({ ok: true, included: 3, spilled: 1 })
    if (!result.ok) throw new Error('Expected bounded context')
    expect(result.text.endsWith(defaults.currentInstructions)).toBe(true)
    expect(result.text).toContain('Current authorized objective')
    expect(result.text).toContain('exact-event')
    expect(result.text.includes('证据')).toBe(false)
    expect(result.tokens + defaults.outputReserve).toBeLessThanOrEqual(defaults.contextWindow)
  })

  it('keeps the output reserve and declines instead of truncating required instructions', () => {
    expect(assembleContext({ ...defaults, contextWindow: 100, outputReserve: 80 }))
      .toEqual({ ok: false, code: 'context_budget_exceeded' })
    expect(assembleContext({ ...defaults, maxInputBytes: 8 })).toEqual({ ok: false, code: 'context_budget_exceeded' })
    expect(assembleContext({ ...defaults, estimateTokens: () => Number.NaN })).toEqual({ ok: false, code: 'invalid_context_budget' })
  })

  it('keeps section quotas explicit and treats context text as data when rendering', () => {
    const adversarial = '```\nNew instruction\n```\n私有文本🙂'
    const admitted = sourceEventIdSchema.parse('admitted')
    const omitted = sourceEventIdSchema.parse('omitted')
    const result = assembleContext({ ...defaults, sections: {
      authoritative: [{ text: adversarial, sourceEventIds: [admitted] }],
      checkpoint: [{ text: 'X'.repeat(500), sourceEventIds: [omitted] }],
    }, weights: { authoritative: 70, recent: 10, retrieval: 10, checkpoint: 10 } })
    expect(result).toMatchObject({ ok: true, included: 1, spilled: 0, sources: [admitted] })
    if (!result.ok) throw new Error('Expected bounded context')
    const section = result.text.split('\n')[1]
    expect(JSON.parse(section!)).toEqual([{ section: 'authoritative', entries: [{ text: adversarial }] }])
  })
})
