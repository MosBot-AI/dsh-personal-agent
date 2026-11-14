import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { InboxRequest, InboxResponse } from '../../../packages/personal-agent/src/inbox/protocol.js'

type Inbox = (request: InboxRequest) => Promise<InboxResponse>

const rootId = 'inventory-records'
const documents = [
  { path: 'opening-register.md', text: '# Opening register\n\nDate: 2026-11-12\nA17: 8, EAST\nB22: 12, WEST\n' },
  { path: 'shelf-count.md', text: '# Shelf count\n\nDate: 2026-11-13\nA17: 8, EAST\nC03: 4, location not recorded\n' },
  { path: 'stock-correction.md', text: '# Stock correction\n\nDate: 2026-11-14\nB22: 15, WEST\n' },
]
const header = 'item,quantity,location,source'
const expectedRows = ['A17,8,EAST,shelf-count.md', 'B22,15,WEST,stock-correction.md', 'C03,4,UNKNOWN,shelf-count.md']
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function prepareOrganizationSources(directory: string) {
  mkdirSync(directory, { mode: 0o700 })
  for (const { path, text } of documents) writeFileSync(join(directory, path), text, { mode: 0o600 })
  return `      knowledge:
        roots:
          - id: ${rootId}
            directory: ${JSON.stringify(directory)}
            include: ["**/*.md"]\n`
}

export async function readOrganizationOutcome(inbox: Inbox) {
  const sources = []
  const ids = new Set<string>()
  for (const { path, text } of documents) {
    const search = await inbox({ type: 'knowledge_search', rootId, query: path, limit: 1 })
    assert.ok(search.ok && search.kind === 'knowledge_search', JSON.stringify(search))
    expect(search.roots).toEqual([{ id: rootId, status: 'available', files: documents.length }])
    expect(search.hits).toHaveLength(1)
    const hit = search.hits[0]!
    expect(hit).toMatchObject({ path, ref: { rootId }, revision: sha256(text) })
    ids.add(hit.ref.id)
    const page = await inbox({ type: 'knowledge_read', ref: hit.ref, revision: hit.revision })
    assert.ok(page.ok && page.kind === 'knowledge_page', JSON.stringify(page))
    expect(page.source).toEqual({ path, ref: hit.ref, revision: hit.revision })
    expect(page.text).toBe(text)
    expect(page.totalBytes).toBe(Buffer.byteLength(text))
    expect(page.nextOffset).toBeUndefined()
    sources.push(`${path} (SHA-256 ${page.source.revision})\n${page.text}`)
  }
  expect(ids.size).toBe(documents.length)
  return [
    'Organize these fictional inventory documents into an importable CSV.',
    'Use the newest dated record for each item. An older quantity is replaced, not added, and repeated rows are not summed.',
    'Use UNKNOWN when the winning record gives no location. The source column must give the filename of the winning record.',
    `Use unquoted CSV with the exact header ${header}. Sort by item ID. Include one row per item and no surrounding prose.`,
    'Return kind ready with empty artifactIds. Put the CSV itself in the JSON summary field.',
    ...sources,
  ].join('\n')
}

export function verifyOrganizationExport(summary: string, directory: string, destination: string) {
  const text = summary.trim().replace(/\r\n/gu, '\n')
  const csv = text.replace(/^```(?:csv)?\n([\s\S]+)\n```$/u, '$1') + '\n'
  writeFileSync(destination, csv, { mode: 0o600, flag: 'wx' })
  const exported = readFileSync(destination, 'utf8')
  const [actualHeader, ...rows] = exported.trimEnd().split('\n')
  expect(actualHeader).toBe(header)
  expect(rows.map(row => row.split(','))).toEqual(expectedRows.map(row => row.split(',')))
  for (const source of documents) expect(readFileSync(join(directory, source.path), 'utf8')).toBe(source.text)
  return sha256(exported)
}
