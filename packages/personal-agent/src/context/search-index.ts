import { createHash } from 'node:crypto'
import { posix } from 'node:path'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const leadingMarkdownTitle = /^(?:\uFEFF)?(?:[ \t]*[\r\n])* {0,3}#{1,6}(?=[ \t]|\r|\n|$)[^\r\n]*/u

export interface IndexedText {
  readonly text: string
  readonly normalized: string
  readonly bodyStart: number
  readonly revision: string
  readonly bytes: number
  readonly indexedBytes: number
}

export function indexText(bytes: Buffer, name: string): IndexedText | undefined {
  try {
    const text = decoder.decode(bytes)
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) return undefined
    const normalized = normalize(text)
    const title = /\.(?:md|markdown)$/iu.test(name) ? leadingMarkdownTitle.exec(text)?.[0] : undefined
    // Keep the title searchable, but avoid giving it the same rank as document text.
    const bodyStart = title ? Math.min(normalized.length, normalize(title).length + 1) : 0
    return { text, normalized, bodyStart, bytes: bytes.length, indexedBytes: bytes.length + Buffer.byteLength(normalized),
      revision: createHash('sha256').update(bytes).digest('hex') }
  } catch { return undefined }
}

interface KeywordQuery {
  readonly text: string
  readonly terms: readonly string[]
}

export function knowledgeQuery(query: string): KeywordQuery | undefined {
  const text = normalize(query)
  const terms = [...new Set(text.split(' ').filter(Boolean))]
  return terms.length > 0 && terms.length <= 16 ? { text, terms } : undefined
}

export function knowledgeTerms(query: string): readonly string[] | undefined {
  return knowledgeQuery(query)?.terms
}

/** Score only eligible matches. Authorization is checked separately. */
export function keywordScore(document: IndexedText, name: string, query: KeywordQuery) {
  const path = normalize(name)
  const exactFile = Number(query.text === path) * 2 + Number(query.text === normalize(posix.basename(name)))
  let bodyTerms = 0
  let bodyMatches = 0
  let legacyScore = 0
  for (const term of query.terms) {
    const inPath = path.includes(term)
    const first = document.normalized.indexOf(term)
    if (!inPath && first < 0) return undefined
    legacyScore += (inPath ? 3 : 0) + (first >= 0 ? 1 : 0)
    if (first < 0) continue
    const body = first >= document.bodyStart ? first : document.normalized.indexOf(term, document.bodyStart)
    if (body < 0) continue
    bodyTerms++
    bodyMatches++
    // Limit the effect of repeating a single term.
    const second = document.normalized.indexOf(term, body + term.length)
    if (second < 0) continue
    bodyMatches++
    if (document.normalized.indexOf(term, second + term.length) >= 0) bodyMatches++
  }
  return { exactFile, bodyTerms, bodyMatches, legacyScore }
}

export function keywordSnippet(document: IndexedText, terms: readonly string[]): string {
  const lines = document.text.split(/\r?\n/u)
  const line = lines.find(value => {
    const normalized = normalize(value)
    return terms.some(term => normalized.includes(term))
  }) ?? lines[0] ?? ''
  const units = Array.from(line.trim())
  const selected = units.slice(0, 180).join('')
  return units.length > 180 ? `${selected}…` : selected
}

/** Offsets are revision-bound UTF-8 byte positions, not text indexes. */
export function textPage(bytes: Buffer, offset: number, maxBytes: number) {
  if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) return undefined
  let end = Math.min(bytes.length, offset + maxBytes)
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return { text: decoder.decode(bytes.subarray(offset, end)), totalBytes: bytes.length,
    ...(end < bytes.length ? { nextOffset: end } : {}) }
}
