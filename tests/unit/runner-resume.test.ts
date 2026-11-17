// Whether a restart-from-step may keep the steps it was told it could keep.
//
// The rule is in `resume.ts` and it is a few lines of logic with a page of
// reasoning behind it, so this pins the reasoning rather than the lines: what
// a restart does on each kind of runner, and which way it is wrong when it is
// wrong.

import { describe, expect, test } from 'bun:test'
import { keepResumedSteps } from '../../app/Actions/Runner/resume'

describe('a restart that was told it may skip steps', () => {
  /*
   * The bug this was written for. A deploy job restarted from its verify step
   * landed on a temporary-workspace runner, which journals a new directory per
   * attempt, and was told five steps had already run. They had - on a machine,
   * in a directory, this attempt has no path to.
   */
  test('runs them anyway when this attempt got a workspace of its own', () => {
    expect(keepResumedSteps({ kept: 5, fresh: true, entries: 0 }).keep).toBe(false)
  })

  /*
   * The reason the test is not "is the workspace empty". A runner that checks
   * the repository out before the first step has a workspace full of source
   * and none of the installing the skipped steps were supposed to have done,
   * and counting entries alone would read that as an inherited workspace.
   */
  test('and still runs them when a fresh workspace already has something in it', () => {
    expect(keepResumedSteps({ kept: 5, fresh: true, entries: 400 }).keep).toBe(false)
  })

  test('saying so in words somebody watching the job can act on', () => {
    const decision = keepResumedSteps({ kept: 5, fresh: true, entries: 0 })

    // Named contents rather than "state could not be restored": the person
    // reading this pressed a button and is owed the reason the button did
    // less than it offered.
    expect(decision.reason).toContain('5 steps')
    expect(decision.reason).toContain('dependencies')
    expect(decision.reason).toContain('not in this one')
  })

  test('and counting one step as a step', () => {
    // Prose that says "1 steps" reads as a bug in the thing reporting the bug.
    const one = keepResumedSteps({ kept: 1, fresh: true, entries: 0 }).reason

    expect(one).toContain('after 1 step,')
    expect(one).toContain('it left on disk')
    expect(one).not.toContain('1 steps')
  })

  /*
   * The case that must keep working: a runner with a configured workspace root
   * uses `job-<id>` on every attempt, so the earlier attempt's files really
   * are still there and the skip really is sound. This is where from-step
   * restart has always worked, and it is why the bug survived.
   */
  test('keeps them when the workspace carried over and has the attempt in it', () => {
    expect(keepResumedSteps({ kept: 5, fresh: false, entries: 12 })).toEqual({ keep: true, reason: '' })
  })

  test('but not when that carried-over workspace was cleaned between attempts', () => {
    const decision = keepResumedSteps({ kept: 5, fresh: false, entries: 0 })

    expect(decision.keep).toBe(false)
    expect(decision.reason).toContain('empty')
  })

  test('and has nothing to say about an ordinary attempt either way', () => {
    // An attempt that skips nothing asks no question. An empty workspace is
    // then just a description of the checkout about to happen.
    expect(keepResumedSteps({ kept: 0, fresh: true, entries: 0 })).toEqual({ keep: true, reason: '' })
    expect(keepResumedSteps({ kept: 0, fresh: false, entries: 40 })).toEqual({ keep: true, reason: '' })
  })

  /*
   * The direction of the mistake, which is the part worth being explicit
   * about. Running steps that could have been skipped costs minutes. Skipping
   * steps that needed running is how a deploy reports success having deployed
   * nothing, and that is the failure this file exists to make impossible.
   */
  test('is never wrong in the direction that skips real work', () => {
    for (const kept of [1, 2, 7, 40]) {
      expect(keepResumedSteps({ kept, fresh: true, entries: 0 }).keep).toBe(false)
      expect(keepResumedSteps({ kept, fresh: true, entries: 999 }).keep).toBe(false)
      expect(keepResumedSteps({ kept, fresh: false, entries: 0 }).keep).toBe(false)
    }
  })
})
