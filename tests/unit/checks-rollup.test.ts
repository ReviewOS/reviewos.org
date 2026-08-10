// One answer from every check on a commit.
//
// This is the rule a merge button reads, and it is expensive to get wrong in
// both directions: permissive merges unverified code, strict blocks every pull
// request on a check nobody runs any more. Both happen, so both are pinned.

import { describe, expect, test } from 'bun:test'
import type { Report } from '../../app/Actions/Checks/rollup'
import { fromCheckRun, fromStatus, latestPerName, requiredSatisfied, rollup } from '../../app/Actions/Checks/rollup'

function report(name: string, state: Report['state'], order = 1): Report {
  return { name, state, order, source: 'check_run' }
}

describe('the rule', () => {
  test('a failure wins, however many passed', () => {
    // A commit is not "mostly verified".
    expect(rollup([report('a', 'success'), report('b', 'success'), report('c', 'failure')]).state).toBe('failure')
  })

  test('an unfinished report is pending, and pending beats success', () => {
    // A check still running has not said anything, and treating silence as
    // consent is the whole failure mode.
    expect(rollup([report('a', 'success'), report('b', 'pending')]).state).toBe('pending')
  })

  test('nothing reported is neutral, not success', () => {
    /*
     * The one people get wrong. A commit nothing has looked at is green in most
     * forges, which means a repository whose CI is misconfigured looks exactly
     * like one whose tests all pass - and the difference is noticed after
     * something ships.
     */
    expect(rollup([]).state).toBe('neutral')
  })

  test('and everything passing is success', () => {
    expect(rollup([report('a', 'success'), report('b', 'success')]).state).toBe('success')
  })

  test('a failure still wins over a pending one', () => {
    // Order matters between these two: a build that has already failed is not
    // waiting on anything.
    expect(rollup([report('a', 'pending'), report('b', 'failure')]).state).toBe('failure')
  })
})

describe('the latest report under each name', () => {
  test('a re-run that fixed the build is what counts', () => {
    /*
     * Without this, a failure would win forever: the original attempt is still
     * in the table and a rollup over every row would keep reading it.
     */
    const reports = [report('ci/build', 'failure', 1), report('ci/build', 'success', 2)]

    expect(rollup(reports).state).toBe('success')
    expect(latestPerName(reports).length).toBe(1)
  })

  test('and a re-run that broke it is too', () => {
    expect(rollup([report('ci/build', 'success', 1), report('ci/build', 'failure', 2)]).state).toBe('failure')
  })

  test('a tie resolves the same way twice', () => {
    // Two systems posting in the same millisecond is defensible either way.
    // What is not defensible is picking differently on two page loads.
    const reports = [report('ci/build', 'failure', 5), report('ci/build', 'success', 5)]

    expect(rollup(reports).state).toBe(rollup(reports).state)
  })
})

describe('reading a check run', () => {
  test('an unfinished run is pending whatever its conclusion says', () => {
    /*
     * A conclusion on a run that has not completed is a value nobody should be
     * reading, and treating it as final is how a check that is still running
     * lets a merge through.
     */
    expect(fromCheckRun({ name: 'x', status: 'in_progress', conclusion: 'success' }).state).toBe('pending')
  })

  test('neutral and skipped are successes for a merge', () => {
    // The check ran, looked, and declined to object.
    expect(fromCheckRun({ name: 'x', status: 'completed', conclusion: 'neutral' }).state).toBe('success')
    expect(fromCheckRun({ name: 'x', status: 'completed', conclusion: 'skipped' }).state).toBe('success')
  })

  test('cancelled and timed out are not', () => {
    /*
     * Nothing looked. A cancelled check silently counting as a pass is exactly
     * how a superseded run unblocks a commit nobody verified.
     */
    expect(fromCheckRun({ name: 'x', status: 'completed', conclusion: 'cancelled' }).state).toBe('failure')
    expect(fromCheckRun({ name: 'x', status: 'completed', conclusion: 'timed_out' }).state).toBe('failure')
  })

  test('completed with no conclusion is neutral rather than fine', () => {
    // A reporter bug, and the safe reading is that nothing was concluded.
    expect(fromCheckRun({ name: 'x', status: 'completed' }).state).toBe('neutral')
  })
})

describe('reading a commit status', () => {
  test('error and failure are the same to a merge', () => {
    // They mean opposite things to whoever has to act, and the same thing to
    // whether the code is verified.
    expect(fromStatus({ context: 'x', state: 'error' }).state).toBe('failure')
    expect(fromStatus({ context: 'x', state: 'failure' }).state).toBe('failure')
  })

  test('and pending is pending', () => {
    expect(fromStatus({ context: 'x', state: 'pending' }).state).toBe('pending')
  })
})

describe('required checks', () => {
  test('one that never reported is missing, and missing blocks', () => {
    /*
     * The case a branch rule exists for: somebody adds `security/scan` to the
     * required list before the scanner is wired up, and every pull request
     * waits rather than merging on a check that does not exist yet.
     */
    const answer = requiredSatisfied([report('ci/build', 'success')], ['ci/build', 'security/scan'])

    expect(answer.ok).toBe(false)
    expect(answer.missing).toEqual(['security/scan'])
  })

  test('a required check still running blocks too', () => {
    const answer = requiredSatisfied([report('ci/build', 'pending')], ['ci/build'])

    expect(answer.ok).toBe(false)
    expect(answer.pending).toEqual(['ci/build'])
  })

  test('an unrequired failure does not block', () => {
    // The rollup is red and the merge is allowed, which is the right pair: the
    // rule names what has to pass, and a lint job nobody required is advice.
    const answer = requiredSatisfied([report('ci/build', 'success'), report('lint', 'failure')], ['ci/build'])

    expect(answer.ok).toBe(true)
    expect(rollup([report('ci/build', 'success'), report('lint', 'failure')]).state).toBe('failure')
  })

  test('and requiring nothing is satisfied by nothing', () => {
    expect(requiredSatisfied([], []).ok).toBe(true)
  })
})
