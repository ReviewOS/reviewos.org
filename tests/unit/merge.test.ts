// Merge rules, merge messages, and what happens to a stack when its base merges.
//
// Merging is irreversible from the contributor's side, so these tests care most
// about the refusals: a draft, a conflict, a missing approval, an unresolved
// thread, and a stacked pull request whose parent has not landed.

import { describe, expect, test } from 'bun:test'
import {
  allowedStrategies,
  defaultStrategy,
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

/**
 * Which ways a repository lets a pull request land.
 *
 * A column per strategy rather than a parsed list, so there is nothing to
 * misparse - which matters because the failure mode of a misparsed merge
 * setting is a branch rule that quietly stops applying.
 */
describe('allowedStrategies', () => {
  test('all three, when the repository says nothing against any of them', () => {
    expect(allowedStrategies({
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    })).toEqual(['merge', 'squash', 'rebase'])
  })

  test('a repository that only squashes says so', () => {
    expect(allowedStrategies({
      allow_merge_commit: false,
      allow_squash_merge: true,
      allow_rebase_merge: false,
    })).toEqual(['squash'])
  })

  /**
   * A row written before these columns existed has nulls in them. Reading a
   * null as "not allowed" would stop every merge in every repository on the day
   * the migration ran, which is the worst possible time for a new setting to be
   * strict.
   */
  test('a row from before the setting existed allows everything', () => {
    expect(allowedStrategies({})).toEqual(['merge', 'squash', 'rebase'])
    expect(allowedStrategies(null)).toEqual(['merge', 'squash', 'rebase'])
    expect(allowedStrategies({ allow_merge_commit: null })).toContain('merge')
  })

  test('reads the shapes a driver hands back for false', () => {
    expect(allowedStrategies({ allow_merge_commit: 0, allow_squash_merge: 'false', allow_rebase_merge: '0' }))
      .toEqual([])
  })

  test('allowing nothing is allowed, and means nothing merges from here', () => {
    expect(allowedStrategies({
      allow_merge_commit: false,
      allow_squash_merge: false,
      allow_rebase_merge: false,
    })).toEqual([])
  })
})

describe('defaultStrategy', () => {
  test('the configured one', () => {
    expect(defaultStrategy({ default_merge_strategy: 'squash' })).toBe('squash')
  })

  test('a merge commit when nothing is configured, or the value is not one', () => {
    expect(defaultStrategy({})).toBe('merge')
    expect(defaultStrategy(null)).toBe('merge')
    expect(defaultStrategy({ default_merge_strategy: 'cherry-pick' })).toBe('merge')
  })

  /**
   * Deliberately not narrowed to what is allowed. A default that is not allowed
   * is a misconfiguration, and quietly substituting a different strategy is how
   * somebody squashes a branch they meant to rebase - so the merge refuses it
   * with a sentence instead, through `mergeBlockers`.
   */
  test('does not quietly substitute when the default is not allowed', () => {
    const settings = { default_merge_strategy: 'rebase', allow_rebase_merge: false }

    expect(defaultStrategy(settings)).toBe('rebase')
    expect(allowedStrategies(settings)).not.toContain('rebase')
    expect(mergeBlockers(ready, { ...permissive, allowedStrategies: allowedStrategies(settings) }, clean, 'rebase'))
      .toContain('The rebase strategy is not allowed on this branch')
  })
})

/**
 * The base branch must already be in the head.
 *
 * GitHub calls this `required_status_checks.strict`, and it is the rule that
 * makes the required checks worth anything: a green tick earned on a head that
 * never contained the current tip of the base is a tick for code that is about
 * to stop existing.
 */
describe('mergeBlockers: up to date with the base', () => {
  const strict = { ...permissive, requireUpToDate: true }

  test('a branch that already contains the base tip merges', () => {
    expect(mergeBlockers(ready, strict, { ...clean, behindBase: false }, 'merge')).toEqual([])
  })

  test('a branch behind its base is refused, and told what to do', () => {
    expect(mergeBlockers(ready, strict, { ...clean, behindBase: true }, 'merge').join())
      .toContain('out of date with its base')
  })

  /**
   * The unknown answer blocks, exactly as an unchecked mergeability does. A
   * rule whose whole purpose is to stop untested combinations landing would be
   * a strange one to skip the moment git failed to answer - and `isBehindBase`
   * returns null rather than guessing precisely so this decision can be made
   * here.
   */
  test('an unchecked answer blocks rather than being assumed current', () => {
    expect(mergeBlockers(ready, strict, { ...clean, behindBase: null }, 'merge').join())
      .toContain('has not been checked yet')

    expect(mergeBlockers(ready, strict, clean, 'merge').join())
      .toContain('has not been checked yet')
  })

  test('the rule off means the answer is never consulted', () => {
    expect(mergeBlockers(ready, permissive, { ...clean, behindBase: true }, 'merge')).toEqual([])
  })
})

/**
 * Who may land on the branch, which a merge decides as much as a push does.
 *
 * Enforced here and at the receive hook from one predicate, because a
 * restriction enforced on only one of the two doors has a button beside it.
 */
describe('mergeBlockers: restricted branches', () => {
  const restricted = { ...permissive, restrictedTo: { users: ['ada'], teams: ['platform'] } }
  const ada = { handle: 'ada', isAdmin: false, teams: [] as string[] }

  test('a named user may merge', () => {
    expect(mergeBlockers(ready, restricted, { ...clean, actor: ada }, 'merge')).toEqual([])
  })

  test('a member of a named team may merge', () => {
    const actor = { handle: 'grace', isAdmin: false, teams: ['platform'] }

    expect(mergeBlockers(ready, restricted, { ...clean, actor }, 'merge')).toEqual([])
  })

  test('anybody else is refused, by name so they know it is them', () => {
    const actor = { handle: 'mallory', isAdmin: false, teams: ['design'] }
    const blockers = mergeBlockers(ready, restricted, { ...clean, actor }, 'merge')

    expect(blockers.join()).toContain('mallory')
    expect(blockers.join()).toContain('only from named users and teams')
  })

  /** Fails closed. An unidentified merger is not "anybody". */
  test('an unidentified caller is refused', () => {
    expect(mergeBlockers(ready, restricted, clean, 'merge').join())
      .toContain('only from named users and teams')
  })

  test('no restriction means anybody with push access', () => {
    const actor = { handle: 'mallory', isAdmin: false, teams: [] as string[] }

    expect(mergeBlockers(ready, permissive, { ...clean, actor }, 'merge')).toEqual([])
  })
})

/**
 * Whether the rules bind the people who could delete them.
 *
 * Only the branch's own rules are ever waived. A conflict, a draft and an
 * unmerged stack parent are not protections somebody is being held to - they
 * are reasons the merge would not mean what it says.
 */
describe('mergeBlockers: enforce_admins', () => {
  const strict = {
    ...permissive,
    requiredApprovals: 2,
    requireThreadsResolved: true,
    requireLinearHistory: true,
    requiredChecks: ['ci'],
  }

  const short = {
    approvals: 0,
    blockingReviews: 1,
    unresolvedThreads: 3,
    checks: { failing: ['ci'], pending: [], missing: [] },
  }

  const admin = { handle: 'ada', isAdmin: true, teams: [] as string[] }

  test('an admin is held to the rules by default', () => {
    expect(mergeBlockers(ready, strict, { ...short, actor: admin }, 'merge').length).toBeGreaterThan(0)
  })

  /**
   * Absent reads as bound, never as exempt. A row written before the column
   * existed has null here, and reading that as an exemption would hand every
   * administrator on the instance a silent one the day the migration ran.
   */
  test('an unset flag is the same as enforcing it', () => {
    const blockers = mergeBlockers(ready, { ...strict, enforceAdmins: undefined }, { ...short, actor: admin }, 'merge')

    expect(blockers.length).toBeGreaterThan(0)
  })

  test('turning it off lets an admin past the branch rules', () => {
    const waived = { ...strict, enforceAdmins: false }

    expect(mergeBlockers(ready, waived, { ...short, actor: admin }, 'merge')).toEqual([])
  })

  test('and past a restriction they are not named in', () => {
    const waived = { ...permissive, enforceAdmins: false, restrictedTo: { users: ['grace'], teams: [] } }

    expect(mergeBlockers(ready, waived, { ...clean, actor: admin }, 'merge')).toEqual([])
  })

  test('the exemption is for admins, not for everybody', () => {
    const waived = { ...strict, enforceAdmins: false }
    const author = { handle: 'mallory', isAdmin: false, teams: [] as string[] }

    expect(mergeBlockers(ready, waived, { ...short, actor: author }, 'merge').length).toBeGreaterThan(0)
  })

  /** A conflict is not a protection, so there is nothing to be exempt from. */
  test('a conflict still blocks an exempt admin', () => {
    const waived = { ...strict, enforceAdmins: false }
    const blockers = mergeBlockers({ ...ready, mergeable: false }, waived, { ...short, actor: admin }, 'merge')

    expect(blockers.join()).toContain('conflicts')
  })

  test('so does a draft, and a parent that has not landed', () => {
    const waived = { ...strict, enforceAdmins: false }
    const stacked = { ...ready, draft: true, stackParent: { state: 'open' as const } }
    const blockers = mergeBlockers(stacked, waived, { ...short, actor: admin }, 'merge')

    expect(blockers.join()).toContain('ready for review')
    expect(blockers.join()).toContain('stacked on must be merged first')
  })

  /**
   * The repository's merge settings are not branch protection either. A
   * repository that only allows squashes is describing what its history looks
   * like, not holding anybody to account.
   */
  test('a strategy the repository does not allow still refuses', () => {
    const waived = { ...permissive, enforceAdmins: false, allowedStrategies: ['squash'] as const }

    expect(mergeBlockers(ready, waived, { ...clean, actor: admin }, 'merge').join())
      .toContain('not allowed on this branch')
  })
})
