// Splitting a suite across parallel nodes.
//
// Two properties matter more than the quality of the partition, because both
// are silent when they break: every item lands on exactly one node, and every
// node computes the same partition without talking to any other node. A test
// that runs twice wastes a machine. A test that runs nowhere stopped being run,
// and nothing anywhere will say so.

import { describe, expect, test } from 'bun:test'
import { splitTests } from '../../app/Actions/Tests/split'

/** The whole fleet's view, which is what the properties are about. */
function everyNode(items: Array<{ name: string, durationMs: number, samples: number }>, nodes: number) {
  return Array.from({ length: nodes }, (_, index) => splitTests({ items, nodes, index }))
}

const TIMED = [
  { name: 'e2e/checkout.spec.ts', durationMs: 90_000, samples: 12 },
  { name: 'e2e/login.spec.ts', durationMs: 30_000, samples: 12 },
  { name: 'unit/a.test.ts', durationMs: 400, samples: 12 },
  { name: 'unit/b.test.ts', durationMs: 300, samples: 12 },
  { name: 'unit/c.test.ts', durationMs: 200, samples: 12 },
]

describe('the partition', () => {
  test('every item lands on exactly one node', () => {
    const all = everyNode(TIMED, 3).flatMap(one => one.items)

    expect(all.sort()).toEqual(TIMED.map(one => one.name).sort())
    expect(new Set(all).size).toBe(all.length)
  })

  test('the slow file goes first, and does not share a node with the next slowest', () => {
    /*
     * The alphabetical split every other forge does would put both `e2e` files
     * on node zero and the three fast unit files on node one - two minutes
     * against one second. Placing the big items first is the entire trick.
     */
    const [zero, one] = everyNode(TIMED, 2)

    expect(zero!.items[0]).toBe('e2e/checkout.spec.ts')
    expect(one!.items).toContain('e2e/login.spec.ts')
    expect(zero!.items).not.toContain('e2e/login.spec.ts')
  })

  test('and the estimate says what each node is in for', () => {
    const [zero, one] = everyNode(TIMED, 2)

    expect(zero!.estimatedMs).toBe(90_000)
    expect(one!.estimatedMs).toBe(30_900)
    expect(zero!.note).toBeNull()
  })

  test('the same input gives the same partition, whoever asks and in what order', () => {
    /*
     * Every node computes the whole split and keeps its own slice, so this is
     * not a nicety: if the order of `items` changed the answer, two nodes
     * handed the same files in a different order would overlap and leave a
     * hole.
     */
    const forwards = everyNode(TIMED, 3).map(one => one.items)
    const backwards = everyNode([...TIMED].reverse(), 3).map(one => one.items)

    expect(backwards).toEqual(forwards)
  })
})

describe('with no history to work with', () => {
  const FRESH = ['d.ts', 'a.ts', 'c.ts', 'b.ts'].map(name => ({ name, durationMs: 0, samples: 0 }))

  test('it still answers, deterministically, and says the split came from nothing', () => {
    // A node that gets an error instead of a list cannot run anything, which
    // turns a missing-history problem into a broken build.
    const [zero, one] = everyNode(FRESH, 2)

    expect([...zero!.items, ...one!.items].sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    expect(zero!.note).toContain('No timing history')
    expect(zero!.note).toContain('deterministic split by name')
  })

  test('and identical items are spread rather than piled onto one node', () => {
    /*
     * The bug the tie-break exists for. Every item costs the same, so "give it
     * to whichever node is cheapest" never changes which node is cheapest, and
     * all four land on node zero while the rest of the fleet idles.
     */
    const [zero, one] = everyNode(FRESH, 2)

    expect(zero!.items).toHaveLength(2)
    expect(one!.items).toHaveLength(2)
  })
})

describe('with partial history', () => {
  test('a new file is assumed to cost what a typical one costs, not nothing', () => {
    /*
     * Zero is the obvious default and it hides: adding zero never changes
     * which node is cheapest, so every new file lands on the same node - the
     * pull request that added twelve test files would put all twelve on one.
     */
    const items = [
      { name: 'old-slow.ts', durationMs: 10_000, samples: 5 },
      { name: 'old-fast.ts', durationMs: 1000, samples: 5 },
      { name: 'new-1.ts', durationMs: 0, samples: 0 },
      { name: 'new-2.ts', durationMs: 0, samples: 0 },
      { name: 'new-3.ts', durationMs: 0, samples: 0 },
    ]

    const nodes = everyNode(items, 3)
    const carryingNew = nodes.filter(one => one.items.some(name => name.startsWith('new-')))

    expect(carryingNew.length).toBeGreaterThan(1)
  })

  test('and the note counts what was guessed at, here and overall', () => {
    const items = [
      { name: 'known.ts', durationMs: 5000, samples: 9 },
      { name: 'unknown.ts', durationMs: 0, samples: 0 },
    ]

    const note = String(splitTests({ items, nodes: 2, index: 0 }).note)

    expect(note).toContain('1 of 2 items have no timing history')
    expect(note).toContain('gets better as results arrive')
  })
})

describe('the edges a client will actually hit', () => {
  test('more nodes than items says so rather than pretending', () => {
    // Somebody set parallelism to 10 and the suite has three files. The two
    // idle machines are worth a sentence.
    const outcome = splitTests({ items: TIMED.slice(0, 3), nodes: 10, index: 0 })

    expect(outcome.note).toContain('3 items across 10 nodes')
  })

  test('one node gets everything', () => {
    expect(splitTests({ items: TIMED, nodes: 1, index: 0 }).items).toHaveLength(TIMED.length)
  })

  test('an empty suite is an empty answer, not a crash', () => {
    const outcome = splitTests({ items: [], nodes: 4, index: 2 })

    expect(outcome.items).toEqual([])
    expect(outcome.note).toBe('Nothing to split.')
  })

  test('a node index outside the fleet is clamped rather than throwing', () => {
    /*
     * `index: 4, nodes: 2` is a misconfigured pipeline, and the honest failure
     * would be an error. But the caller is a shell script whose alternative is
     * running nothing, and every item is already on some node - clamping hands
     * back a real slice, which is duplicated work rather than skipped work.
     */
    const outcome = splitTests({ items: TIMED, nodes: 2, index: 4 })

    expect(outcome.items.length).toBeGreaterThan(0)
  })
})
