/** Transitive relationships, with cycle guards for malformed workflow graphs. */
export function graphRelations(edges: readonly { source: number, target: number }[], selected: number) {
  const walk = (reverse: boolean) => {
    const found = new Set<number>()
    const pending = [selected]
    while (pending.length) {
      const id = pending.pop()!
      for (const edge of edges) {
        if ((reverse ? edge.target : edge.source) !== id) continue
        const next = reverse ? edge.source : edge.target
        if (next === selected || found.has(next)) continue
        found.add(next)
        pending.push(next)
      }
    }
    return found
  }
  return { prerequisites: walk(true), dependants: walk(false) }
}
