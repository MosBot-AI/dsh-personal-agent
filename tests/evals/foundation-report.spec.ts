import { expect, it } from 'vitest'
import { journeys, plan } from '../../evals/cases/foundation.js'
import { summarize } from '../../evals/runner.js'

function sample() {
  return plan.map(item => ({ ...item, exitCode: 0, outputs: journeys[item.journey].outputs, elapsedMs: 1, artifactSha256: 'digest' }))
}

function ratings(decision: 'pending' | 'accepted') {
  return { reviewer: 'Test reviewer', cases: plan.map(({ id }) => ({ id, decision, reason: '', note: '' })) }
}

it('withholds an acceptance rate for a fully executed but unscored batch', () => {
  expect(summarize(sample(), ratings('pending'))).toMatchObject({
    planned: 30, executed: 30, pending: 30, accepted: 0, acceptanceRate: null, targetMet: null,
  })
})

it('counts execution and quality failures in the fully reviewed denominator', () => {
  const runs = sample()
  runs[0]!.exitCode = 1
  const reviews: Parameters<typeof summarize>[1] = ratings('accepted')
  expect(() => summarize(runs, reviews)).toThrow('Failed fixture brief-1 cannot be accepted')
  reviews.cases[0] = { id: 'brief-1', decision: 'rejected', reason: 'execution', note: 'Fixture failed' }
  for (const rating of reviews.cases.slice(1, 7)) {
    Object.assign(rating, { decision: 'rejected', reason: 'accuracy', note: 'Evidence did not meet the rubric' })
  }
  expect(summarize(runs, reviews)).toMatchObject({
    accepted: 23, pending: 0, acceptanceRate: 23 / 30, targetMet: false,
    rejections: { execution: 1, accuracy: 6 },
  })
})

it('rejects scores for unexecuted cases and a ledger that skips a planned case', () => {
  const runs = sample()
  expect(() => summarize(runs.slice(0, 29), ratings('accepted'))).toThrow('execution')
  expect(() => summarize(runs.slice(1), ratings('pending'))).toThrow('fixed plan')
})
