/**
 * The shape of a run: what waited on what, and where the time went.
 *
 * A run screen is a list of jobs, and a list cannot answer the two questions
 * people actually have about a slow or stuck pipeline: *what is this waiting
 * for*, and *why did it take forty minutes*. Both are properties of the graph
 * rather than of any job, so both are computed here, as pure functions over
 * rows - the layout of a screen is not the place to work out a longest path.
 *
 * **The critical path is the useful half.** Adding runners does nothing for a
 * run whose length is one chain of dependent jobs, and speeding up the slowest
 * job does nothing if it is not on that chain. Every other CI system leaves
 * this to a person with a stopwatch.
 */

/** One job, in the shape the graph reads. */
export interface GraphNode {
  id: number
  jobKey: string
  name: string
  state: string
  needs: string[]
  /** Milliseconds this job waited for a machine, when it is known. */
  waitMs: number
  /** Milliseconds it ran for, when it is known. */
  runMs: number
}

export interface GraphLayer {
  /** How deep in the dependency order this layer is, counting from zero. */
  depth: number
  nodes: GraphNode[]
}

/**
 * The jobs in dependency order, one layer at a time.
 *
 * A job sits one layer below the deepest thing it needs, which is the order a
 * reader draws it in anyway. Names rather than ids, because `needs:` names a
 * job and a matrix turns one name into several rows - all of which have to be
 * finished before anything downstream is.
 */
export function layersOf(nodes: readonly GraphNode[]): GraphLayer[] {
  const depths = new Map<string, number>()
  const byKey = new Map<string, GraphNode[]>()

  for (const node of nodes)
    byKey.set(node.jobKey, [...(byKey.get(node.jobKey) ?? []), node])

  /*
   * Iterated to a fixed point rather than recursed, and bounded: a `needs:`
   * cycle is refused by the parser, but a graph read out of the database is
   * whatever is in the database, and a recursive walk over a cycle is a stack
   * overflow rather than a wrong answer somebody can see.
   */
  for (let pass = 0; pass < nodes.length + 1; pass++) {
    let moved = false

    for (const [key, group] of byKey) {
      const needs = [...new Set(group.flatMap(one => one.needs))]
      const depth = needs.length === 0
        ? 0
        : Math.max(...needs.map(need => (depths.has(need) ? depths.get(need)! + 1 : 0)))

      if (depths.get(key) !== depth) {
        depths.set(key, depth)
        moved = true
      }
    }

    if (!moved)
      break
  }

  const layers = new Map<number, GraphNode[]>()

  for (const node of nodes) {
    const depth = depths.get(node.jobKey) ?? 0

    layers.set(depth, [...(layers.get(depth) ?? []), node])
  }

  return [...layers.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([depth, group]) => ({ depth, nodes: group }))
}

export interface CriticalPath {
  /** The chain, in order, that decided how long the run took. */
  nodes: GraphNode[]
  /** What that chain cost, in milliseconds. */
  totalMs: number
  /** How much of it was waiting for a machine rather than working. */
  waitMs: number
}

/**
 * The chain that decided how long the run took.
 *
 * Longest path by cost, where a job's cost is its wait plus its run - because
 * an hour spent queueing is an hour of the run either way, and a critical path
 * that ignored the wait would point at the wrong job on a busy fleet.
 *
 * Ties break on the job that started earlier, so two runs of the same pipeline
 * name the same chain: a critical path that moves between reloads is one nobody
 * trusts enough to act on.
 */
export function criticalPath(nodes: readonly GraphNode[]): CriticalPath {
  const byKey = new Map<string, GraphNode[]>()

  for (const node of nodes)
    byKey.set(node.jobKey, [...(byKey.get(node.jobKey) ?? []), node])

  const best = new Map<number, { total: number, chain: GraphNode[] }>()

  /*
   * Costed from the front: the best chain ending at this job is the best chain
   * ending at any of the jobs it needed, plus this one. Computed in layer order
   * so everything a job depends on is already costed.
   */
  for (const layer of layersOf(nodes)) {
    for (const node of layer.nodes) {
      const cost = Math.max(0, node.waitMs) + Math.max(0, node.runMs)

      const upstream = node.needs
        .flatMap(need => byKey.get(need) ?? [])
        .map(one => best.get(one.id))
        .filter((one): one is { total: number, chain: GraphNode[] } => Boolean(one))
        .sort((left, right) => right.total - left.total)[0]

      best.set(node.id, {
        total: (upstream?.total ?? 0) + cost,
        chain: [...(upstream?.chain ?? []), node],
      })
    }
  }

  const winner = [...best.values()].sort((left, right) => right.total - left.total)[0]

  if (!winner)
    return { nodes: [], totalMs: 0, waitMs: 0 }

  return {
    nodes: winner.chain,
    totalMs: winner.total,
    waitMs: winner.chain.reduce((total, node) => total + Math.max(0, node.waitMs), 0),
  }
}

/**
 * What a blocked job is waiting for, by name.
 *
 * Only the dependencies that have not finished - a job waiting on four things
 * where three are done is waiting on one, and listing all four sends somebody
 * to look at jobs that are already green.
 */
export function waitingOn(node: GraphNode, nodes: readonly GraphNode[]): string[] {
  const finished = new Set(
    nodes
      .filter(one => ['succeeded', 'failed', 'cancelled', 'skipped'].includes(one.state))
      .map(one => one.jobKey),
  )

  const unfinished = new Set(
    nodes
      .filter(one => !['succeeded', 'failed', 'cancelled', 'skipped'].includes(one.state))
      .map(one => one.jobKey),
  )

  return node.needs.filter(need => unfinished.has(need) || !finished.has(need))
}
