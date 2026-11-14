import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { InboxRequest, InboxResponse } from '../../../packages/personal-agent/src/inbox/protocol.js'

type Inbox = (request: InboxRequest) => Promise<InboxResponse>
const rootId = 'research-fixture'
const harbor = {
  query: 'harbor pilot reservation', path: 'harbor-room.md',
  current: '# Harbor pilot reservation\n\nHarbor Room confirmed capacity: 46 seats. Confirmed fee: $275.\n',
  previous: '# Harbor pilot reservation\n\nHarbor Room preliminary capacity: 34 seats. Estimated fee: $125.\n',
}
const orchard = {
  query: 'orchard pilot reservation', path: 'orchard-room.md',
  current: '# Orchard pilot reservation\n\nOrchard Room confirmed capacity: 28 seats. Confirmed fee: $240.\n',
}
const revision = (text: string) => createHash('sha256').update(text).digest('hex')
const citation = (source: typeof orchard) => `${source.path}@${revision(source.current).slice(0, 12)}`

export function prepareResearchSources(directory: string) {
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, harbor.path), harbor.previous, { mode: 0o600 })
  writeFileSync(join(directory, orchard.path), orchard.current, { mode: 0o600 })
  writeFileSync(join(directory, 'transport.md'), '# Shuttle schedule\n\nThe last shuttle departs at 21:00.\n', { mode: 0o600 })
  return `      knowledge:
        roots:
          - id: ${rootId}
            directory: ${JSON.stringify(directory)}
            include: ["**/*.md"]\n`
}

export async function readResearchOutcome(inbox: Inbox, directory: string) {
  async function exactSource(source: typeof orchard, expected: string) {
    const search = await inbox({ type: 'knowledge_search', rootId, query: source.query, limit: 3 })
    assert.ok(search.ok && search.kind === 'knowledge_search', JSON.stringify(search))
    expect(search.roots).toEqual([{ id: rootId, status: 'available', files: 3 }])
    expect(search.hits.map(hit => hit.path)).toEqual([source.path])
    const hit = search.hits[0]!
    expect(hit.revision).toBe(revision(expected))
    const read = { type: 'knowledge_read', ref: hit.ref, revision: hit.revision } as const
    const page = await inbox(read)
    assert.ok(page.ok && page.kind === 'knowledge_page', JSON.stringify(page))
    expect(page.source).toEqual({ path: source.path, ref: hit.ref, revision: hit.revision })
    expect(page.text).toBe(expected)
    expect(page.totalBytes).toBe(Buffer.byteLength(expected))
    expect(page.nextOffset).toBeUndefined()
    return { read, text: page.text }
  }

  const earlier = await exactSource(harbor, harbor.previous)
  writeFileSync(join(directory, harbor.path), harbor.current)
  expect(await inbox(earlier.read)).toEqual({ ok: false, code: 'stale_source' })
  const updated = await exactSource(harbor, harbor.current)
  expect(updated.read.ref).toEqual(earlier.read.ref)
  const comparison = await exactSource(orchard, orchard.current)
  return [
    'Recommend a room for a fictional pilot requiring at least 40 seats and a fee at most $300.',
    'Compare capacity and price for each room using only these two owner-reviewed sources.',
    'Write the actual research brief in the JSON summary field, including its evidence. The summary is the deliverable the owner will read.',
    'In summary, include one line per room with its name, seat count as "N seats", dollar fee and exact path@revision citation.',
    'Add a Recommendation line naming the selected room and explaining the choice. Return kind ready with an empty artifactIds array.',
    `Source ${citation(harbor)} (SHA-256 ${updated.read.revision})\n${updated.text}`,
    `Source ${citation(orchard)} (SHA-256 ${comparison.read.revision})\n${comparison.text}`,
  ].join('\n')
}

export function verifyResearchBrief(text: string) {
  const lines = text.split('\n')
  const harborLine = lines.find(line => line.includes(citation(harbor)))
  const orchardLine = lines.find(line => line.includes(citation(orchard)))
  assert.ok(harborLine && orchardLine, `Expected both exact source citations in the synthetic brief:\n${text}`)
  expect(harborLine).toMatch(/Harbor Room/i)
  expect(harborLine).toMatch(/\b46 seats\b/)
  expect(harborLine).toMatch(/\$275\b/)
  expect(orchardLine).toMatch(/Orchard Room/i)
  expect(orchardLine).toMatch(/\b28 seats\b/)
  expect(orchardLine).toMatch(/\$240\b/)
  const recommendation = lines.find(line => /recommendation/i.test(line) && /Harbor Room/i.test(line))
  assert.ok(recommendation, `Expected a recommendation for Harbor Room:\n${text}`)
  expect(recommendation).toMatch(/\b(?:40|capacity|seat|both|requirements)\b/i)
  expect(text).not.toMatch(/\b34 seats\b|\$125\b|transport\.md|21:00/)
}
