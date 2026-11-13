import { setImmediate } from 'node:timers/promises'
import type { IndexedText } from './search-index.js'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const han = /\p{Script=Han}/u
const hanWord = /^\p{Script=Han}+$/u
const questionStart = /^(?:how|what|when|where|which|who|why|can|could|do|does|is|are|will|would|should)\b/iu
const chineseQuestion = /(?:谁|什么|哪[个天里些一组]|何时|多久|多长时间|多少|怎么|为何|是否|吗$)/u
const filler = new Set((
  'a an and any are be been before both but by can could did do does for from get got had has have how i if in is it its ' +
  'may me my of on only or our please should so some than that the their them then there these they this those to us ' +
  'use was we were what when where which who why will with would you your again after about also during just more need ' +
  'take under without through which once still tell many much long latest current next first last does really ' +
  '的 了 吗 呢 么 地 得 和 或 而 将 在 把 被 给 从 与 由 对 向 为 到 会 要 能 可 可以 应该 需要 ' +
  '怎么 怎样 如何 什么 为什么 哪 哪个 哪些 哪里 哪天 何时 什么时候 谁 多少 多久 多长 时间 这 这个 这次 这些 ' +
  '那 那个 那些 一下 一次 之后 以前 以后 之前 最晚 通常 是否 请 告诉 帮我 有 有没有 一般'
).split(' '))

const genericHanTerms = new Set('账户 记录 设备 系统 客户 员工 数据 进入 查看 工作 计划 时间 标准 文件 团队 问题'.split(' '))

const maxConcepts = 12
const scanBatchBytes = 512 * 1024

type Concept = { term: string; pattern?: RegExp; pairs: string[] }

function latinPattern(word: string): RegExp {
  const stem = word.length >= 5 ? word.replace(/(?:ies|ied)$/, 'y').replace(/(?:ing|ed|s)$/, '') : word
  const endings = word.length >= 4 ? '(?:s|es|e|ed|ing)?' : ''
  return new RegExp('\\b(?:' + word + '|' + stem + endings + ')\\b', 'u')
}

function conceptsOf(question: string): Concept[] {
  const concepts = new Map<string, Concept>()
  const words = [...segmenter.segment(question)]
  for (let index = 0; index < words.length; index++) {
    const { segment: word, isWordLike } = words[index]!
    let segment = word
    // Join contiguous Han characters that the segmenter emitted as single words.
    if (han.test(word) && Array.from(word).length === 1 && !filler.has(word)) {
      while (index + 1 < words.length) {
        const next = words[index + 1]!.segment
        if (!han.test(next) || Array.from(next).length !== 1 || filler.has(next)) break
        segment += next
        index++
      }
    }
    if (!isWordLike || filler.has(segment)) continue
    if (/^[a-z][a-z0-9]{1,31}$/u.test(segment)) {
      concepts.set(segment, { term: segment, pattern: latinPattern(segment), pairs: [] })
    } else if (han.test(segment)) {
      const units = Array.from(segment)
      if (units.length < 2 || units.length > 12 || !hanWord.test(segment)) continue
      const pairs = units.slice(1).map((unit, index) => units[index] + unit)
      concepts.set(segment, { term: segment, pairs: units.length > 2 ? pairs : [] })
    }
    if (concepts.size >= maxConcepts) break
  }
  return [...concepts.values()]
}

function containsTerm(text: string, concept: Concept) {
  return concept.pattern ? concept.pattern.test(text) : text.includes(concept.term)
}

function evidence(body: string, title: string, concept: Concept): number {
  const inTitle = containsTerm(title, concept)
  if (containsTerm(body, concept)) return inTitle ? 1.25 : 1
  if (concept.pairs.some(pair => body.includes(pair))) return 0.4
  return inTitle ? 0.5 : 0
}

export function knowledgeQuestion(input: string) {
  const text = input.normalize('NFKC').toLowerCase().trim()
  if (!(text.endsWith('?') || questionStart.test(text) || chineseQuestion.test(text))) return undefined
  return text
}

const focusPattern = /^(?:which|what) ([a-z][a-z0-9]{2,31})\b/u
const genericFocus = new Set('date day time days version type kind size number amount place person people team group'.split(' '))
const countQuestion = /^(?:how many|how much)\b/u
const number = String.raw`(?:\d+(?:[.,]\d+)?|[零〇一二两三四五六七八九十百千万]+)`
const measurementEvidence = [
  { question: /(?:多少倍|几倍|放大倍率|magnification)/u, answer: new RegExp(number + String.raw`\s*(?:倍|[×x]\b)`, 'u') },
  { question: /(?:哪一年|哪年|what year|which year)/u, answer: /(?:\b\d{4}\b|[零〇一二两三四五六七八九]{4}年)/u },
  { question: /(?:重多少|多少克|多少公斤|多少千克|how (?:much .* weigh|heavy))/u,
    answer: new RegExp(number + String.raw`\s*(?:千克|公斤|克|毫克|吨|(?:kg|mg|g|oz|lbs?|grams?|kilograms?|pounds?)\b)`, 'u') },
]
const quantityEvidence = /(?:\d|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|hundred|thousand|none)\b)/u

/** Rank document candidates for questions after strict lookup finds no hits. */
export async function rankQuestion<T>(
  question: string, rows: readonly T[], documentOf: (row: T) => IndexedText, current: () => boolean,
) {
  const concepts = conceptsOf(question)
  const head = focusPattern.exec(question)?.[1]
  const focus = head && !genericFocus.has(head) && !filler.has(head) ? latinPattern(head) : undefined
  const whoAction = /^who ([a-z][a-z0-9]{2,31})\b/u.exec(question)?.[1]
  const action = whoAction && !filler.has(whoAction) ? latinPattern(whoAction) : undefined
  const measurement = measurementEvidence.find(({ question: pattern }) => pattern.test(question))?.answer
  const quantity = measurement ?? (countQuestion.test(question) ? quantityEvidence : undefined)
  if (concepts.length < 2) return []
  const frequency = concepts.map(() => 0)
  const matches: { row: T; strengths: number[] }[] = []
  let scannedBytes = 0
  for (const row of rows) {
    const { normalized, bodyStart, indexedBytes } = documentOf(row)
    if (scannedBytes && scannedBytes + indexedBytes > scanBatchBytes) {
      await setImmediate()
      if (!current()) return undefined
      scannedBytes = 0
    }
    scannedBytes += indexedBytes
    const body = normalized.slice(bodyStart)
    const title = normalized.slice(0, bodyStart)
    const strengths = concepts.map((concept, index) => {
      const strength = evidence(body, title, concept)
      if (strength >= 0.4) frequency[index]!++
      return strength
    })
    if (strengths.filter(strength => strength >= 0.5).length < 2) continue
    const titleTerms = concepts.filter(concept => containsTerm(title, concept)).length
    const hasPassage = body.split(/(?<=[.!?])\s+|[。！？；]+/u).some(passage => {
      if ((focus && !focus.test(passage)) || (action && !action.test(passage))
        || (quantity && !quantity.test(passage))) return false
      const bodyTerms = concepts.filter(concept => containsTerm(passage, concept)).length
      return bodyTerms >= 2 || (bodyTerms === 1 && titleTerms >= 2)
    })
    if (hasPassage) matches.push({ row, strengths })
  }
  const weights = frequency.map(count => 1 + Math.log((rows.length + 1) / (count + 1)))
  return matches.flatMap(({ row, strengths }) => {
    const hasDistinctBodyTerm = concepts.some((concept, index) => strengths[index]! >= 1 && !genericHanTerms.has(concept.term))
    const terms = concepts.filter((_, index) => strengths[index]! >= 0.5).map(concept => concept.term)
    if (!hasDistinctBodyTerm || terms.length / concepts.length < 1 / 3) return []
    const score = strengths.reduce((sum, strength, index) =>
      sum + strength * weights[index]! * (genericHanTerms.has(concepts[index]!.term) ? 0.4 : 1), 0)
    return [{ row, terms, score }]
  }).sort((a, b) => b.score - a.score)
}
