// Merge rules, merge messages, and what happens to a stack when its base merges.
//
// Merging is irreversible from the contributor's side, so these tests care most
// about the refusals: a draft, a conflict, a missing approval, an unresolved
// thread, and a stacked pull request whose parent has not landed.

import { describe, expect, test } from 'bun:test'
import {
  isMergeStrategy,
  mayDeleteHeadBranch,
  mergeBlockers,
  mergeCommitMessage,
  MERGE_STRATEGIES,
  retargetStack,
} from '../../app/Actions/Pull/merge'

const ready = {
  state: 'open' as const,
  draft: false,
  mergeable: true,
  stackParent: null,
}

const permissive = {
  requiredApprovals: 0,
  requireThreadsResolved: false,
  requireLinearHistory: false,
  allowedStrategies: MERGE_STRATEGIES,
}

const clean = { approvals: 0, blockingReviews: 0, unresolvedThreads: 0 }

describe('mergeBlockers', () => {
  test('a ready pull request has nothing blocking it', () => {
    expect(mergeBlockers(ready, permissive, clean, 'merge')).toEqual([])
  })

  test('an already merged pull request cannot merge again', () => {
    const blockers = mergeBlockers({ ...ready, state: 'merged' }, permissive, clean, 'merge')

    expect(blockers).toHaveLength(1)
    expect(blockers[0]).toContain('already been merged')
  })

  test('a closed pull request must be reopened first', () => {
    expect(mergeBlockers({ ...ready, state: 'closed' }, permissive, clean, 'merge').join()).toContain('Reopen')
  })

  test('a draft blocks', () => {
    expect(mergeBlockers({ ...ready, draft: true }, permissive, clean, 'merge').join()).toContain('ready for review')
  })

  test('a conflict blocks', () => {
    expect(mergeBlockers({ ...ready, mergeable: false }, permissive, clean, 'merge').join()).toContain('conflicts')
  })

  test('an unknown mergeability blocks, rather than being assumed clean', () => {
    expect(mergeBlockers({ ...ready, mergeable: null }, permissive, clean, 'merge')).toHaveLength(1)
  })

  test('an unknown mergeability says so rather than claiming a conflict', () => {
    // Telling somebody their branch conflicts when nothing has been checked
    // sends them off to rebase a branch that was fine.
    const blockers = mergeBlockers({ ...ready, mergeable: null }, permissive, clean, 'merge').join()

    expect(blockers).toContain('not been checked')
    expect(blockers).not.toContain('conflicts')
  })

  test('missing approvals block, and say how many are missing', () => {
    const blockers = mergeBlockers(ready, { ...permissive, requiredApprovals: 2 }, { ...clean, approvals: 1 }, 'merge')

    expect(blockers.join()).toContain('1 more approval is required')
  })

  test('the plural reads correctly for more than one', () => {
    const blockers = mergeBlockers(ready, { ...permissive, requiredApprovals: 3 }, clean, 'merge')

    expect(blockers.join()).toContain('3 more approvals are required')
  })

  test('a changes-requested review blocks regardless of approvals', () => {
    const blockers = mergeBlockers(ready, permissive, { ...clean, blockingReviews: 1, approvals: 5 }, 'merge')

    expect(blockers.join()).toContain('Changes requested')
  })

  test('unresolved threads block only when the rule asks for it', () => {
    const readiness = { ...clean, unresolvedThreads: 2 }

    expect(mergeBlockers(ready, permissive, readiness, 'merge')).toEqual([])
    expect(mergeBlockers(ready, { ...permissive, requireThreadsResolved: true }, readiness, 'merge').join())
      .toContain('2 review threads must be resolved')
  })

  test('a disallowed strategy blocks', () => {
    const rules = { ...permissive, allowedStrategies: ['squash'] as const }

    expect(mergeBlockers(ready, rules, clean, 'merge').join()).toContain('not allowed')
    expect(mergeBlockers(ready, rules, clean, 'squash')).toEqual([])
  })

  test('a linear history forbids a merge commit but allows squash and rebase', () => {
    const rules = { ...permissive, requireLinearHistory: true }

    expect(mergeBlockers(ready, rules, clean, 'merge').join()).toContain('linear history')
    expect(mergeBlockers(ready, rules, clean, 'squash')).toEqual([])
    expect(mergeBlockers(ready, rules, clean, 'rebase')).toEqual([])
  })

  test('a stacked pull request waits for its parent', () => {
    const stacked = { ...ready, stackParent: { state: 'open' as const } }

    expect(mergeBlockers(stacked, permissive, clean, 'merge').join()).toContain('stacked on must be merged')
  })

  test('a stacked pull request may merge once its parent has', () => {
    const stacked = { ...ready, stackParent: { state: 'merged' as const } }

    expect(mergeBlockers(stacked, permissive, clean, 'merge')).toEqual([])
  })

  test('a failing required check blocks', () => {
    const blockers = mergeBlockers(ready, permissive, {
      ...clean,
      checks: { failing: ['build'], pending: [], missing: [] },
    }, 'merge')

    expect(blockers.join()).toContain('build')
  })

  test('a required check still running blocks', () => {
    const blockers = mergeBlockers(ready, permissive, {
      ...clean,
      checks: { failing: [], pending: ['test'], missing: [] },
    }, 'merge')

    expect(blockers.join()).toContain('Waiting for test')
  })

  test('a required check that never reported says so distinctly', () => {
    // Pending resolves itself; missing means the workflow is not wired up, and
    // the person waiting needs to know which they are looking at.
    const blockers = mergeBlockers(ready, permissive, {
      ...clean,
      checks: { failing: [], pending: [], missing: ['deploy'] },
    }, 'merge')

    expect(blockers.join()).toContain('first time')
  })

  test('satisfied checks block nothing', () => {
    const blockers = mergeBlockers(ready, permissive, {
      ...clean,
      checks: { failing: [], pending: [], missing: [] },
    }, 'merge')

    expect(blockers).toEqual([])
  })

  test('a pull request with no check information merges', () => {
    // Checks are optional; a repository that reports none is not blocked.
    expect(mergeBlockers(ready, permissive, clean, 'merge')).toEqual([])
  })

  test('every reason is reported at once, not one per attempt', () => {
    const blockers = mergeBlockers(
      { ...ready, draft: true, mergeable: false },
      { ...permissive, requiredApprovals: 1 },
      clean,
      'merge',
    )

    expect(blockers.length).toBeGreaterThanOrEqual(3)
  })
})

describe('isMergeStrategy', () => {
  test('accepts the three strategies', () => {
    expect(isMergeStrategy('merge')).toBe(true)
    expect(isMergeStrategy('squash')).toBe(true)
    expect(isMergeStrategy('rebase')).toBe(true)
  })

  test('rejects anything else', () => {
    expect(isMergeStrategy('fast-forward')).toBe(false)
    expect(isMergeStrategy('')).toBe(false)
  })
})

describe('mergeCommitMessage', () => {
  const input = {
    number: 42,
    title: 'Add the review panel',
    body: 'Long description.',
    headBranch: 'review-panel',
    baseBranch: 'main',
    commits: ['wip', 'fix the test'],
  }

  test('a merge commit names the pull request and the branch', () => {
    const message = mergeCommitMessage('merge', input)

    expect(message.subject).toBe('Merge pull request #42 from review-panel')
    expect(message.body).toBe('Add the review panel')
  })

  test('a squash uses the title and keeps the commit subjects as notes', () => {
    const message = mergeCommitMessage('squash', input)

    expect(message.subject).toBe('Add the review panel (#42)')
    expect(message.body).toContain('Long description.')
    expect(message.body).toContain('* wip')
    expect(message.body).toContain('* fix the test')
  })

  test('a squash with no description still lists the commits', () => {
    const message = mergeCommitMessage('squash', { ...input, body: '' })

    expect(message.body).toBe('* wip\n* fix the test')
  })

  test('a rebase writes no message, since it creates no commit', () => {
    expect(mergeCommitMessage('rebase', input)).toEqual({ subject: '', body: '' })
  })
})

describe('retargetStack', () => {
  const parent = { id: 1, headBranch: 'feature-a', baseBranch: 'main', stackParentId: null }

  test('a child based on the merged branch moves down to its base', () => {
    const moves = retargetStack(parent, [{ id: 2, baseBranch: 'feature-a', stackParentId: 1 }])

    expect(moves).toEqual([{ id: 2, baseBranch: 'main', stackParentId: null }])
  })

  test('a three-deep stack moves the middle one and keeps the link below it', () => {
    const middle = { id: 2, headBranch: 'feature-b', baseBranch: 'feature-a', stackParentId: 1 }
    const moves = retargetStack(middle, [{ id: 3, baseBranch: 'feature-b', stackParentId: 2 }])

    expect(moves).toEqual([{ id: 3, baseBranch: 'feature-a', stackParentId: 1 }])
  })

  test('a pull request that is not part of this stack is left alone', () => {
    expect(retargetStack(parent, [{ id: 9, baseBranch: 'main', stackParentId: null }])).toEqual([])
  })

  test('a child retargeted by hand keeps its base but loses the stale stack link', () => {
    const moves = retargetStack(parent, [{ id: 2, baseBranch: 'main', stackParentId: 1 }])

    expect(moves).toEqual([{ id: 2, baseBranch: 'main', stackParentId: null }])
  })

  test('several children all move', () => {
    const moves = retargetStack(parent, [
      { id: 2, baseBranch: 'feature-a', stackParentId: 1 },
      { id: 3, baseBranch: 'feature-a', stackParentId: 1 },
    ])

    expect(moves).toHaveLength(2)
    expect(moves.every(move => move.baseBranch === 'main')).toBe(true)
  })
})

describe('mayDeleteHeadBranch', () => {
  const base = {
    deleteOnMerge: true,
    headIsDefaultBranch: false,
    headIsFork: false,
    openPullRequestsOnHead: 0,
  }

  test('deletes when asked and nothing depends on the branch', () => {
    expect(mayDeleteHeadBranch(base)).toBe(true)
  })

  test('never deletes when the setting is off', () => {
    expect(mayDeleteHeadBranch({ ...base, deleteOnMerge: false })).toBe(false)
  })

  test('never deletes the default branch', () => {
    expect(mayDeleteHeadBranch({ ...base, headIsDefaultBranch: true })).toBe(false)
  })

  test('never deletes a branch in somebody else\'s fork', () => {
    expect(mayDeleteHeadBranch({ ...base, headIsFork: true })).toBe(false)
  })

  test('keeps a branch another open pull request is built on', () => {
    expect(mayDeleteHeadBranch({ ...base, openPullRequestsOnHead: 1 })).toBe(false)
  })
})
