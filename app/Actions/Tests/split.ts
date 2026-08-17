/**
 * Splitting a suite across parallel jobs, using what the suite has actually
 * been doing.
 *
 * `parallelism: 8` in every other forge means "cut the file list into eight
 * alphabetical pieces and hope". Test files are not uniform - one integration
 * file is worth forty unit files - so the alphabetical cut gives one node
 * eleven minutes of work and another forty seconds, and the job takes eleven
 * minutes. Historical timing is the whole difference, and it is sitting in
 * `test_executions` already.
 *
 * Two rules the partition must keep, and they are not negotiable:
 *
 * 1. **Every item lands on exactly one node.** A test that runs twice wastes a
 *    machine; a test that runs nowhere is a test that silently stopped being
 *    run, which is worse than not splitting at all.
 * 2. **The same input gives the same partition**, on every node, without the
 *    nodes talking to each other. Each node computes the whole split and keeps
 *    its own slice, so anything non-deterministic - a map's insertion order, a
 *    tie broken by chance - hands two nodes overlapping work and leaves a hole.
 */

/** One thing to distribute, with what it has historically cost. */
export interface SplitItem {
  /** The path or identifier the client will hand back to its test runner. */
  name: string
  /** Milliseconds, summed from history. Zero means "never seen". */
  durationMs: number
  /** How many recorded executions that duration came from. */
  samples: number
}

export interface SplitRequest {
  items: readonly SplitItem[]
  /** How many nodes are running. */
  nodes: number
  /** Which node is asking, zero-based. */
  index: number
}

export interface SplitOutcome {
  /** The names this node should run, in the order it should run them. */
  items: string[]
  /** What this node's slice is expected to cost, in milliseconds. */
  estimatedMs: number
  /** How many of this node's items had no history behind them. */
  unknown: number
  /**
   * Said plainly when the split is worse than it looks, so nobody reads an
   * even-looking partition as a well-informed one.
   */
  note: string | null
}

/**
 * Longest-processing-time-first: sort by cost descending, and hand each item to
 * whichever node is currently cheapest.
 *
 * It is the standard greedy answer to multiprocessor scheduling and it is
 * within 4/3 of optimal, which is far more than good enough here - the input is
 * *estimates* of duration, so chasing an optimal partition of numbers that are
 * already approximate buys nothing. What matters is that the big items are
 * placed first: placing them last is exactly how one node ends up eleven
 * minutes long.
 */
export function splitTests(request: SplitRequest): SplitOutcome {
  const nodes = Math.max(1, Math.floor(request.nodes) || 1)
  const index = Math.min(nodes - 1, Math.max(0, Math.floor(request.index) || 0))

  /*
   * An item nobody has timings for is assumed to cost what a typical item
   * costs, not nothing.
   *
   * Zero would be the obvious default and it is wrong in a way that hides:
   * adding zero never changes which node is cheapest, so *every* new file
   * lands on the same node. The one job in a new pull request that added
   * twelve test files would get all twelve.
   */
  const known = request.items.filter(item => item.samples > 0).map(item => item.durationMs).sort((a, b) => a - b)
  const assumed = known.length ? known[Math.floor(known.length / 2)]! : 0

  const costOf = (item: SplitItem): number => (item.samples > 0 ? Math.max(0, item.durationMs) : assumed)

  /*
   * Sorted by cost, then by name. The name is not decoration: two items with
   * the same duration - which is every item with no history at all - must
   * order the same way on every node, and array order is not something the
   * caller can be trusted to have made stable.
   */
  const items = [...request.items].sort((left, right) => {
    if (costOf(right) !== costOf(left))
      return costOf(right) - costOf(left)

    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  })

  const buckets: Array<{ items: string[], cost: number }> = Array.from({ length: nodes }, () => ({ items: [], cost: 0 }))

  for (const item of items) {
    let cheapest = 0

    for (let at = 1; at < nodes; at++) {
      const here = buckets[at]!
      const best = buckets[cheapest]!

      /*
       * Cheapest wins; on equal cost the emptier node wins; on both equal the
       * lower-numbered node wins. Every node runs this same loop over the same
       * input, so a tie broken any other way is how two nodes come to disagree
       * about who owns a test - one running it twice, one not at all.
       *
       * The item-count tie-break is what spreads a suite with no history at
       * all, where every cost is identical.
       */
      if (here.cost < best.cost || (here.cost === best.cost && here.items.length < best.items.length))
        cheapest = at
    }

    buckets[cheapest]!.items.push(item.name)
    buckets[cheapest]!.cost += costOf(item)
  }

  const mine = buckets[index]!
  const unknown = mine.items.filter(name => !(request.items.find(item => item.name === name)?.samples))

  return {
    items: mine.items,
    estimatedMs: Math.round(mine.cost),
    unknown: unknown.length,
    note: noteFor(request.items, unknown.length, nodes),
  }
}

/**
 * What is wrong with this split, when something is.
 *
 * A partition always comes back, because a client that gets an error instead of
 * a list has no way to run the tests at all - which turns a missing-history
 * problem into a broken build. But an even-looking split computed from nothing
 * is a lie by omission, so it says so.
 */
function noteFor(items: readonly SplitItem[], unknownHere: number, nodes: number): string | null {
  if (!items.length)
    return 'Nothing to split.'

  const seen = items.filter(item => item.samples > 0).length

  if (seen === 0) {
    return `No timing history for any of these ${items.length} items, so this is a deterministic split by name and nothing more. `
      + 'Report results for this suite and the next split will be informed by them.'
  }

  if (seen < items.length) {
    return `${items.length - seen} of ${items.length} items have no timing history and were spread evenly; `
      + `${unknownHere} of them landed here. The split gets better as results arrive.`
  }

  if (items.length < nodes)
    return `Only ${items.length} items across ${nodes} nodes, so some nodes have nothing to do.`

  return null
}
