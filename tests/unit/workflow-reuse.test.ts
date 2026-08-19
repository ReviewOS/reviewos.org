// Which recorded results a restart keeps.
//
// Restart-from-step is only worth having if it skips work and only safe if the
// work it skips would have produced the same answer. Every test here is a case
// where those two pull against each other.

import { describe, expect, test } from 'bun:test'
import { AFTER_CHANGE, CHANGED, NO_RESULT, NOT_SUCCEEDED, reusePlan, signatureOf, skipThrough } from '../../app/Actions/Workflow/reuse'

function ran(position: number, signature: string, state = 'succeeded', outputs: Record<string, string> | null = {}) {
  return { position, signature, state, outputs }
}

function defined(position: number, signature: string) {
  return { position, signature, state: 'pending', outputs: null }
}

describe('a workflow nobody touched', () => {
  test('keeps every result, so a restart skips the lot', () => {
    const before = [ran(0, 'checkout'), ran(1, 'install'), ran(2, 'test')]
    const now = [defined(0, 'checkout'), defined(1, 'install'), defined(2, 'test')]

    expect(reusePlan(before, now).every(one => one.reuse)).toBe(true)
    expect(skipThrough(reusePlan(before, now))).toBe(3)
  })
})

describe('a step that changed', () => {
  test('is run again', () => {
    const before = [ran(0, 'checkout'), ran(1, 'install')]
    const now = [defined(0, 'checkout'), defined(1, 'install --frozen')]

    const plan = reusePlan(before, now)

    expect(plan[0]?.reuse).toBe(true)
    expect(plan[1]?.reuse).toBe(false)
    expect(plan[1]?.reason).toBe(CHANGED)
  })

  /**
   * The rule that gets forgotten, and the one that makes this safe. A step
   * reads the workspace its predecessors left behind, so reusing step 3's
   * output after step 1 was edited hands a later job a value produced from a
   * world that no longer exists.
   */
  test('and takes everything after it with it, however unchanged those are', () => {
    const before = [ran(0, 'checkout'), ran(1, 'install'), ran(2, 'test'), ran(3, 'package')]
    const now = [defined(0, 'checkout'), defined(1, 'install --frozen'), defined(2, 'test'), defined(3, 'package')]

    const plan = reusePlan(before, now)

    expect(plan.map(one => one.reuse)).toEqual([true, false, false, false])
    // Named as what it is: the later steps did not change, they are downstream
    // of something that did.
    expect(plan[2]?.reason).toBe(AFTER_CHANGE)
    expect(plan[3]?.reason).toBe(AFTER_CHANGE)
    expect(skipThrough(plan)).toBe(1)
  })
})

describe('a step that failed', () => {
  test('is where the restart starts, and what came before it still stands', () => {
    const before = [ran(0, 'checkout'), ran(1, 'install'), ran(2, 'test', 'failed', null)]
    const now = [defined(0, 'checkout'), defined(1, 'install'), defined(2, 'test')]

    const plan = reusePlan(before, now)

    expect(plan.map(one => one.reuse)).toEqual([true, true, false])
    expect(plan[2]?.reason).toBe(NOT_SUCCEEDED)
    expect(skipThrough(plan)).toBe(2)
  })
})

describe('a step whose result was lost', () => {
  /**
   * Reported by a runner too old to send it, or dropped for being too large.
   * Skipping it would silently hand the steps after it an empty value they
   * would read as the answer, which is worse than running it again.
   */
  test('is run again rather than skipped with nothing', () => {
    const before = [ran(0, 'checkout'), ran(1, 'build', 'succeeded', null)]
    const now = [defined(0, 'checkout'), defined(1, 'build')]

    const plan = reusePlan(before, now)

    expect(plan[1]?.reuse).toBe(false)
    expect(plan[1]?.reason).toBe(NO_RESULT)
  })

  test('but a step that simply produced none is still skippable', () => {
    // Nothing downstream reads what it did not produce, which is exactly why
    // skipping it is safe.
    const before = [ran(0, 'checkout', 'succeeded', {})]
    const now = [defined(0, 'checkout')]

    expect(reusePlan(before, now)[0]?.reuse).toBe(true)
  })
})

describe('steps that appeared or vanished', () => {
  test('a new step at the end is new work', () => {
    const before = [ran(0, 'checkout')]
    const now = [defined(0, 'checkout'), defined(1, 'deploy')]

    const plan = reusePlan(before, now)

    expect(plan.map(one => one.reuse)).toEqual([true, false])
    expect(plan[1]?.reason).toBe(CHANGED)
  })

  test('and one inserted in the middle shifts everything after it, which is a change', () => {
    // Position is the pairing, so inserting at 1 makes the old step 1 into the
    // new step 2 - and the signatures no longer line up, which is the honest
    // answer rather than a coincidence this has to defend against.
    const before = [ran(0, 'checkout'), ran(1, 'test')]
    const now = [defined(0, 'checkout'), defined(1, 'lint'), defined(2, 'test')]

    expect(reusePlan(before, now).map(one => one.reuse)).toEqual([true, false, false])
  })

  test('and a run with no record at all reuses nothing', () => {
    expect(reusePlan([], [defined(0, 'checkout')])[0]?.reuse).toBe(false)
    expect(skipThrough(reusePlan([], [defined(0, 'checkout')]))).toBe(0)
  })
})

describe('what counts as the same step', () => {
  test('the fields that decide what running it would do', () => {
    const one = signatureOf({ command: 'make', env: '{"CI":"1"}' })
    const same = signatureOf({ command: 'make', env: '{"CI":"1"}' })
    const other = signatureOf({ command: 'make', env: '{"CI":"0"}' })

    expect(one).toBe(same)
    expect(one).not.toBe(other)
  })

  /**
   * A renamed step is the same work. Refusing to reuse it would mean a restart
   * re-running a twenty-minute build because a label got clearer, which is how
   * a feature gets a reputation for never working.
   */
  test('and not the name, which somebody is allowed to improve', () => {
    expect(signatureOf({ command: 'make' })).toBe(signatureOf({ command: 'make' }))
  })

  test('and a condition counts, because it decides whether the step runs at all', () => {
    expect(signatureOf({ command: 'make', condition: "github.ref == 'refs/heads/main'" }))
      .not.toBe(signatureOf({ command: 'make' }))
  })
})
