import { createHash } from 'node:crypto'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()

export interface IndexedText {
  readonly text: string
  readonly normalized: string
  readonly revision: string
  readonly bytes: number
  readonly indexedBytes: number
}

export function indexText(bytes: Buffer): IndexedText | undefined {
  try {
    const text = decoder.decode(bytes)
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) return undefined
    const normalized = normalize(text)
    return { text, normalized, bytes: bytes.length, indexedBytes: bytes.length + Buffer.byteLength(normalized),
      revision: createHash('sha256').update(bytes).digest('hex') }
  } catch { return undefined }
}

export function knowledgeTerms(query: string): readonly string[] | undefined {
  const terms = [...new Set(normalize(query).split(' ').filter(Boolean))]
  return terms.length > 0 && terms.length <= 16 ? terms : undefined
}

/** Text and filenames participate in ranking, but never in authorization. */
export function keywordScore(document: IndexedText, name: string, terms: readonly string[]): number {
  const title = normalize(name)
  let score = 0
  for (const term of terms) {
    const inTitle = title.includes(term)
    const inText = document.normalized.includes(term)
    if (!inTitle && !inText) return 0
    score += (inTitle ? 3 : 0) + (inText ? 1 : 0)
  }
  return score
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
