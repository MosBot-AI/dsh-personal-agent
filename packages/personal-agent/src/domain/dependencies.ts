/** Return whether adding all candidate prerequisites can reach their own task. */
export function wouldCycle<T>(task: T, prerequisites: readonly T[], edges: ReadonlyMap<T, readonly T[]>): boolean {
  const pending = [...prerequisites]
  const seen = new Set<T>()
  while (pending.length) {
    const next = pending.pop()!
    if (next === task) return true
    if (seen.has(next)) continue
    seen.add(next)
    pending.push(...edges.get(next) ?? [])
  }
  return false
}
