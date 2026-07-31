// Stacks: ordering, orphan detection, and how much can land at once.
//
// The failure that makes stacks unusable is not the ordering, it is the moment
// part of the chain moves and nothing says so: a parent closed, a parent
// amended, a child left pointing at a branch that is not going anywhere. Those
// cases lead here.

import { describe, expect, test } from 'bun:test'
import type { StackMember } from '../../resources/functions/stack'
import {
  blockedBy,
  buildStack,
  landablePrefix,
  landableThrough,
  orphanMessage,
  orphanReason,
  positionIn,
  stackSummary,
} from '../../resources/functions/stack'

function member(id: number, parent: number | null, extra: Partial<StackMember> = {}): StackMember {
  return {
    id,
    number: id,
    title: `change ${id}`,
    state: 'open',
    headBranch: `feature-${id}`,
    baseBranch: parent === null ? 'main' : `feature-${parent}`,
    stackParentId: parent,
    draft: false,
    ...extra,
  }
}

const chain = [member(1, null), member(2, 1), member(3, 2)]
const ready = chain.map(entry => ({ id: entry.id, blockers: [] as string[] }))

describe('buildStack', () => {
  test('orders a chain bottom first', () => {
    expect(buildStack(chain, 2).map(entry => entry.id)).toEqual([1, 2, 3])
  })

  test('builds the same chain from any member', () => {
    expect(buildStack(chain, 1).map(entry => entry.id)).toEqual([1, 2, 3])
    expect(buildStack(chain, 3).map(entry => entry.id)).toEqual([1, 2, 3])
  })

  test('a lone pull request is a stack of one', () => {
    expect(buildStack([member(9, null)], 9).map(entry => entry.id)).toEqual([9])
  })

  test('an unknown member gives nothing', () => {
    expect(buildStack(chain, 99)).toEqual([])
  })

  test('a missing parent stops the walk rather than throwing', () => {
    const orphan = [member(5, 4)]

    expect(buildStack(orphan, 5).map(entry => entry.id)).toEqual([5])
  })

  test('a cycle does not hang', () => {
    // Two that claim each other as parent. Nothing should ever create this,
    // which is exactly why it must not take the page down when it happens.
    const cyclic = [member(1, 2), member(2, 1)]

    expect(buildStack(cyclic, 1).length).toBeLessThanOrEqual(2)
  })

  test('follows one branch when a parent has several children', () => {
    const tree = [member(1, null), member(2, 1), member(3, 1)]

    expect(buildStack(tree, 1)).toHaveLength(2)
  })
})

describe('positionIn', () => {
  test('counts from one', () => {
    expect(positionIn(chain, 2)).toEqual({ position: 2, total: 3 })
  })

  test('reports the bottom and the top', () => {
    expect(positionIn(chain, 1).position).toBe(1)
    expect(positionIn(chain, 3).position).toBe(3)
  })
})

describe('orphanReason', () => {
  test('a healthy child is not an orphan', () => {
    expect(orphanReason(chain[1]!, chain)).toBeNull()
  })

  test('the bottom of a stack is never an orphan', () => {
    expect(orphanReason(chain[0]!, chain)).toBeNull()
  })

  test('a closed parent orphans its child', () => {
    const all = [member(1, null, { state: 'closed' }), member(2, 1)]

    expect(orphanReason(all[1]!, all)).toBe('parent-closed')
  })

  test('a missing parent orphans its child', () => {
    const all = [member(2, 1)]

    expect(orphanReason(all[0]!, all)).toBe('parent-missing')
  })

  test('a child pointed somewhere else has come apart', () => {
    const all = [member(1, null), member(2, 1, { baseBranch: 'main' })]

    expect(orphanReason(all[1]!, all)).toBe('retargeted')
  })

  test('a merged parent whose child was retargeted is healthy', () => {
    // This is the normal path: the parent landed and the child moved down.
    const all = [member(1, null, { state: 'merged' }), member(2, 1, { baseBranch: 'main' })]

    expect(orphanReason(all[1]!, all)).toBeNull()
  })

  test('a merged parent whose child was not retargeted is flagged', () => {
    const all = [member(1, null, { state: 'merged' }), member(2, 1)]

    expect(orphanReason(all[1]!, all)).toBe('retargeted')
  })

  test('every reason has a sentence, and no reason has none', () => {
    for (const reason of ['parent-closed', 'parent-missing', 'retargeted'] as const)
      expect(orphanMessage(reason)!.length).toBeGreaterThan(0)

    expect(orphanMessage(null)).toBeNull()
  })
})

describe('landablePrefix', () => {
  test('lands the whole stack when everything is ready', () => {
    expect(landablePrefix(chain, ready).map(entry => entry.id)).toEqual([1, 2, 3])
  })

  test('stops at the first one that is not ready', () => {
    const readiness = [
      { id: 1, blockers: [] },
      { id: 2, blockers: ['1 more approval is required'] },
      { id: 3, blockers: [] },
    ]

    expect(landablePrefix(chain, readiness).map(entry => entry.id)).toEqual([1])
  })

  test('the top being ready does not let it jump the queue', () => {
    const readiness = [
      { id: 1, blockers: ['conflicts'] },
      { id: 2, blockers: [] },
      { id: 3, blockers: [] },
    ]

    expect(landablePrefix(chain, readiness)).toEqual([])
  })

  test('skips over parts of the stack that already merged', () => {
    const partly = [member(1, null, { state: 'merged' }), member(2, 1), member(3, 2)]

    expect(landablePrefix(partly, ready).map(entry => entry.id)).toEqual([2, 3])
  })

  test('a draft stops the run', () => {
    const withDraft = [member(1, null), member(2, 1, { draft: true }), member(3, 2)]

    expect(landablePrefix(withDraft, ready).map(entry => entry.id)).toEqual([1])
  })

  test('a closed member stops the run', () => {
    const withClosed = [member(1, null), member(2, 1, { state: 'closed' })]

    expect(landablePrefix(withClosed, ready).map(entry => entry.id)).toEqual([1])
  })

  test('a member with no readiness entry is not assumed ready', () => {
    expect(landablePrefix(chain, [{ id: 1, blockers: [] }]).map(entry => entry.id)).toEqual([1])
  })
})

describe('blockedBy', () => {
  test('names the one below that is holding this up', () => {
    const readiness = [
      { id: 1, blockers: [] },
      { id: 2, blockers: ['1 more approval is required'] },
      { id: 3, blockers: [] },
    ]

    expect(blockedBy(chain, 3, readiness)?.id).toBe(2)
  })

  test('names the lowest blocker, not the nearest', () => {
    // The one to chase is the one at the bottom of the queue.
    const readiness = [
      { id: 1, blockers: ['conflicts'] },
      { id: 2, blockers: ['1 more approval is required'] },
      { id: 3, blockers: [] },
    ]

    expect(blockedBy(chain, 3, readiness)?.id).toBe(1)
  })

  test('nothing blocks the bottom', () => {
    expect(blockedBy(chain, 1, ready)).toBeNull()
  })

  test('nothing blocks when everything below is ready', () => {
    expect(blockedBy(chain, 3, ready)).toBeNull()
  })

  test('a merged member below does not block', () => {
    const partly = [member(1, null, { state: 'merged' }), member(2, 1)]

    expect(blockedBy(partly, 2, [{ id: 2, blockers: [] }])).toBeNull()
  })
})

describe('stackSummary', () => {
  test('says when there is no stack', () => {
    expect(stackSummary([member(1, null)])).toBe('Not part of a stack')
  })

  test('counts the stack', () => {
    expect(stackSummary(chain)).toContain('3 pull requests')
  })

  test('counts what has landed once any has', () => {
    const partly = [member(1, null, { state: 'merged' }), member(2, 1), member(3, 2)]

    expect(stackSummary(partly)).toBe('1 of 3 in this stack have merged')
  })
})

describe('landableThrough', () => {
  test('merging the top lands everything below it too', () => {
    // GitHub's stacked pull requests do the same: merging a layer lands it and
    // every unmerged layer beneath. Refusing would be dishonest, because the
    // merge takes those commits along regardless.
    expect(landableThrough(chain, 3, ready).map(entry => entry.id)).toEqual([1, 2, 3])
  })

  test('merging the bottom lands only the bottom', () => {
    expect(landableThrough(chain, 1, ready).map(entry => entry.id)).toEqual([1])
  })

  test('refuses when anything below is not ready', () => {
    const readiness = [
      { id: 1, blockers: ['1 more approval is required'] },
      { id: 2, blockers: [] },
      { id: 3, blockers: [] },
    ]

    expect(landableThrough(chain, 3, readiness)).toEqual([])
  })

  test('refuses when the member itself is not ready', () => {
    const readiness = [
      { id: 1, blockers: [] },
      { id: 2, blockers: [] },
      { id: 3, blockers: ['conflicts'] },
    ]

    expect(landableThrough(chain, 3, readiness)).toEqual([])
  })

  test('skips members that already merged', () => {
    const partly = [member(1, null, { state: 'merged' }), member(2, 1), member(3, 2)]

    expect(landableThrough(partly, 3, ready).map(entry => entry.id)).toEqual([2, 3])
  })

  test('a draft below stops the whole landing', () => {
    const withDraft = [member(1, null, { draft: true }), member(2, 1)]

    expect(landableThrough(withDraft, 2, ready)).toEqual([])
  })

  test('an unknown member lands nothing', () => {
    expect(landableThrough(chain, 99, ready)).toEqual([])
  })
})
