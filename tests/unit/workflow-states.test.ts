// What a run and its jobs are allowed to do next.
//
// The rule these exist for is the one about going backwards. The runner is
// somebody else's machine executing hostile code by design, so a late message
// from a lapsed lease *will* arrive - the only question is whether it is
// refused or quietly believed. Believing it is the worst outcome this system
// has: a cancelled run turning green satisfies a branch protection rule with a
// check nobody ran, and it is silent, because the row simply says something
// else than it did.

import { describe, expect, test } from 'bun:test'
import type { JobState } from '../../app/Actions/Workflow/states'
import {
  canJobMove,
  canRunMove,
  eligibleJobs,
  isTerminalJob,
  isTerminalRun,
  runStateFromJobs,
  unreachableJobs,
} from '../../app/Actions/Workflow/states'

describe('a finished run stays finished', () => {
  test('nothing leaves a terminal state', () => {
    for (const from of ['cancelled', 'failed', 'succeeded'] as const) {
      for (const to of ['queued', 'running', 'waiting', 'paused', 'cancelling', 'succeeded', 'failed'] as const) {
        if (from === to)
          continue

        expect(canRunMove(from, to)).toBe(false)
      }
    }
  })

  test('and the one that matters most is named on its own', () => {
    // A worker that lost its connection, coming back to publish a success over
    // a run somebody cancelled.
    expect(canRunMove('cancelled', 'succeeded')).toBe(false)
    expect(canJobMove('cancelled', 'succeeded')).toBe(false)
  })

  test('a repeat of the state it is already in is allowed', () => {
    // A retried delivery saying the same thing twice is not a violation.
    expect(canRunMove('succeeded', 'succeeded')).toBe(true)
    expect(canJobMove('failed', 'failed')).toBe(true)
  })

  test('terminal is the same list both sides agree on', () => {
    expect(isTerminalRun('succeeded')).toBe(true)
    expect(isTerminalRun('cancelling')).toBe(false)
    expect(isTerminalJob('skipped')).toBe(true)
    expect(isTerminalJob('blocked')).toBe(false)
  })
})

describe('the transitions a run does have', () => {
  test('the ordinary path', () => {
    expect(canRunMove('queued', 'running')).toBe(true)
    expect(canRunMove('running', 'succeeded')).toBe(true)
  })

  test('waiting and paused can resume', () => {
    expect(canRunMove('running', 'waiting')).toBe(true)
    expect(canRunMove('waiting', 'running')).toBe(true)
    expect(canRunMove('paused', 'running')).toBe(true)
  })

  /*
   * Cancellation is cooperative first, so a job that finished in the moment
   * between the request and the acknowledgement really did finish. Forcing
   * `cancelling` to `cancelled` would be the control plane overwriting
   * something that happened.
   */
  test('cancelling can still end in success', () => {
    expect(canRunMove('cancelling', 'cancelled')).toBe(true)
    expect(canRunMove('cancelling', 'succeeded')).toBe(true)
    expect(canRunMove('cancelling', 'running')).toBe(false)
  })

  test('a run cannot skip straight from queued to succeeded', () => {
    expect(canRunMove('queued', 'succeeded')).toBe(false)
  })
})

describe('runStateFromJobs', () => {
  const of = (...states: JobState[]) => runStateFromJobs(states)

  test('no jobs yet is queued', () => {
    expect(of()).toBe('queued')
  })

  test('anything unfinished keeps the run unfinished', () => {
    expect(of('running', 'succeeded')).toBe('running')
    expect(of('blocked', 'succeeded')).toBe('queued')
  })

  /*
   * A failure with work still going is still running. The remaining jobs may be
   * cancelled by policy, and saying "failed" now is a verdict the run has not
   * reached.
   */
  test('a failure while others run is not yet a failed run', () => {
    expect(of('failed', 'running')).toBe('running')
  })

  test('everything finished and one failed is failed', () => {
    expect(of('succeeded', 'failed')).toBe('failed')
  })

  test('everything succeeded is succeeded', () => {
    expect(of('succeeded', 'succeeded')).toBe('succeeded')
  })

  // A skipped job is an outcome the graph chose, not a problem.
  test('a skipped job does not fail the run', () => {
    expect(of('succeeded', 'skipped')).toBe('succeeded')
  })

  test('a cancellation shows even beside successes', () => {
    expect(of('succeeded', 'cancelled')).toBe('cancelled')
  })

  test('and a job being cancelled outranks everything', () => {
    expect(of('cancelling', 'succeeded', 'failed')).toBe('cancelling')
  })
})

describe('eligibleJobs', () => {
  const job = (job_id: string, state: JobState, needs?: string) => ({ job_id, state, needs: needs ?? null })

  test('a job with nothing to wait for is eligible', () => {
    expect(eligibleJobs([job('a', 'blocked')]).map(j => j.job_id)).toEqual(['a'])
  })

  test('a job waits until what it needs has succeeded', () => {
    expect(eligibleJobs([job('a', 'running'), job('b', 'blocked', 'a')])).toEqual([])
    expect(eligibleJobs([job('a', 'succeeded'), job('b', 'blocked', 'a')]).map(j => j.job_id)).toEqual(['b'])
  })

  test('and waits for all of them, not the first', () => {
    const jobs = [job('a', 'succeeded'), job('b', 'running'), job('c', 'blocked', 'a\nb')]
    expect(eligibleJobs(jobs)).toEqual([])
  })

  test('a job that already started is not eligible again', () => {
    expect(eligibleJobs([job('a', 'running')])).toEqual([])
  })

  /*
   * The validator refuses a `needs` naming a job that does not exist, so this
   * cannot arrive - but "the graph is missing a job" must never become "run it
   * anyway".
   */
  test('a dependency that is not in the run is treated as unsatisfied', () => {
    expect(eligibleJobs([job('b', 'blocked', 'ghost')])).toEqual([])
  })

  test('a failed dependency does not make its dependant eligible', () => {
    expect(eligibleJobs([job('a', 'failed'), job('b', 'blocked', 'a')])).toEqual([])
  })
})

describe('unreachableJobs', () => {
  const job = (job_id: string, state: JobState, needs?: string) => ({ job_id, state, needs: needs ?? null })

  /*
   * A run whose last job sits in `blocked` forever never reaches a terminal
   * state, and a run that never finishes holds a pull request's checks open
   * with nothing to show for it.
   */
  test('a job whose dependency failed can never run', () => {
    expect(unreachableJobs([job('a', 'failed'), job('b', 'blocked', 'a')]).map(j => j.job_id)).toEqual(['b'])
  })

  test('and so can nothing further down the chain', () => {
    const jobs = [job('a', 'failed'), job('b', 'blocked', 'a'), job('c', 'blocked', 'b')]
    expect(unreachableJobs(jobs).map(j => j.job_id)).toEqual(['b', 'c'])
  })

  test('a job waiting on something still running is not unreachable', () => {
    expect(unreachableJobs([job('a', 'running'), job('b', 'blocked', 'a')])).toEqual([])
  })

  test('a cancelled or skipped dependency counts too', () => {
    expect(unreachableJobs([job('a', 'cancelled'), job('b', 'blocked', 'a')]).map(j => j.job_id)).toEqual(['b'])
    expect(unreachableJobs([job('a', 'skipped'), job('b', 'blocked', 'a')]).map(j => j.job_id)).toEqual(['b'])
  })

  test('a missing dependency makes a job unreachable rather than eternal', () => {
    expect(unreachableJobs([job('b', 'blocked', 'ghost')]).map(j => j.job_id)).toEqual(['b'])
  })
})
