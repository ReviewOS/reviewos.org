/**
 * An approval from a machine account.
 *
 * The rule this pins: **a robot's "yes" does not satisfy a branch rule unless
 * the repository said it may, and a robot's "no" always blocks.** The two
 * directions are deliberately not symmetric, and a change that makes them
 * symmetric in either direction is a change somebody should have to argue for.
 *
 * The failure it exists to prevent is specific: an agent opens a pull request,
 * another agent approves it, the rule that said "two approvals" is satisfied,
 * and nobody looked.
 */

import { describe, expect, it } from 'bun:test'
import { approvalsSatisfied } from '../../app/Actions/Pull/anchoring'
import { mergeBlockers } from '../../app/Actions/Pull/merge'

const head = 'a'.repeat(40)

const review = (over: Partial<{ reviewerId: number, state: string, commitSha: string | null, machine: boolean }> = {}) => ({
  reviewerId: 1,
  state: 'approved',
  commitSha: head,
  machine: false,
  ...over,
})

describe('by default', () => {
  it('does not count a machine approval', () => {
    const result = approvalsSatisfied({
      reviews: [review({ reviewerId: 1, machine: true })],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: false,
    })

    expect(result.approvals).toBe(0)
    expect(result.satisfied).toBe(false)
  })

  it('reports it as uncounted rather than dropping it', () => {
    // So the refusal can say why. "1 more approval is required" on a pull
    // request that visibly has one reads as a bug in the counting.
    const result = approvalsSatisfied({
      reviews: [review({ machine: true })],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: false,
    })

    expect(result.uncounted).toBe(1)
  })

  it('still counts a person alongside one', () => {
    const result = approvalsSatisfied({
      reviews: [review({ reviewerId: 1, machine: true }), review({ reviewerId: 2 })],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: false,
    })

    expect(result.approvals).toBe(1)
    expect(result.uncounted).toBe(1)
    expect(result.satisfied).toBe(true)
  })
})

describe('when the repository opts in', () => {
  it('counts it like anyone else\'s', () => {
    const result = approvalsSatisfied({
      reviews: [review({ machine: true })],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: false,
      countMachineApprovals: true,
    })

    expect(result.approvals).toBe(1)
    expect(result.uncounted).toBe(0)
    expect(result.satisfied).toBe(true)
  })

  it('and staleness still applies to it', () => {
    // Opting in says a machine may approve, not that its approval outlives the
    // commit it was given for.
    const result = approvalsSatisfied({
      reviews: [review({ machine: true, commitSha: 'b'.repeat(40) })],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: true,
      countMachineApprovals: true,
    })

    expect(result.satisfied).toBe(false)
  })
})

describe('an objection', () => {
  it('blocks even when the repository does not count machine approvals', () => {
    /*
     * The asymmetry, asserted directly. Declining to count a robot's approval
     * is cautious; ignoring a robot's objection is the opposite, and a
     * repository that opted out of the first has not asked for the second.
     */
    const result = approvalsSatisfied({
      reviews: [review({ reviewerId: 1, state: 'changes_requested', machine: true }), review({ reviewerId: 2 })],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: false,
      countMachineApprovals: false,
    })

    expect(result.blocking).toBe(1)
    expect(result.satisfied).toBe(false)
  })
})

describe('the refusal a reader sees', () => {
  it('says why the approval on screen did not count', () => {
    const blockers = mergeBlockers(
      { state: 'open', draft: false, mergeable: true, stackParent: null },
      { requiredApprovals: 1, requireThreadsResolved: false, requireLinearHistory: false, allowedStrategies: ['merge'] },
      { approvals: 0, blockingReviews: 0, uncountedApprovals: 1, unresolvedThreads: 0 },
      'merge',
    )

    expect(blockers.join(' ')).toContain('machine account')
  })

  it('and stays a plain sentence when there is no such approval', () => {
    // The explanation is only useful where it explains something. Appending it
    // always would make every ordinary refusal mention robots.
    const blockers = mergeBlockers(
      { state: 'open', draft: false, mergeable: true, stackParent: null },
      { requiredApprovals: 1, requireThreadsResolved: false, requireLinearHistory: false, allowedStrategies: ['merge'] },
      { approvals: 0, blockingReviews: 0, unresolvedThreads: 0 },
      'merge',
    )

    expect(blockers).toContain('1 more approval is required')
  })
})
