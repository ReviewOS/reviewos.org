// What a re-run touches.
//
// The argument this settles: re-running "the failed jobs" has to carry the jobs
// that never ran *because* those failed. Without that, the second attempt
// finishes green with half the pipeline still skipped - which is worse than not
// having the button, because it produces a passing run nobody should trust.

import { describe, expect, test } from 'bun:test'
import { rerunPlan, resetState } from '../../app/Actions/Workflow/rerun'

let next = 1

function job(job_id: string, state: string, extra: Partial<{ needs: string, kind: string }> = {}) {
  return { id: next++, job_id, state, needs: null, ...extra }
}

describe('re-running what failed', () => {
  test('takes the failure and everything downstream of it', () => {
    const jobs = [
      job('build', 'succeeded'),
      job('test', 'failed'),
      job('package', 'skipped', { needs: 'test' }),
      job('deploy', 'skipped', { needs: 'package' }),
      job('docs', 'succeeded'),
    ]

    const chosen = rerunPlan({ jobs, scope: 'failed' }).map(one => one.job_id).sort()

    // Two layers deep: `deploy` never named `test`, but it could not run
    // because `package` could not.
    expect(chosen).toEqual(['deploy', 'package', 'test'])
  })

  test('a cancelled job counts as a failure', () => {
    // Somebody stopped it, or fail-fast did. Either way nobody has an answer
    // for it, which is the thing a re-run is for.
    expect(rerunPlan({ jobs: [job('build', 'cancelled')], scope: 'failed' }).length).toBe(1)
  })

  test('and a run where nothing failed selects nothing', () => {
    /*
     * Answered as nothing rather than as everything. "Re-run failed jobs" on a
     * green run is somebody looking at the wrong run, and quietly running the
     * whole thing would spend the fleet on a question they did not ask.
     */
    expect(rerunPlan({ jobs: [job('build', 'succeeded')], scope: 'failed' })).toEqual([])
  })

  test('a job that succeeded is left alone even when a sibling failed', () => {
    const jobs = [job('build', 'succeeded'), job('test', 'failed')]

    expect(rerunPlan({ jobs, scope: 'failed' }).map(one => one.job_id)).toEqual(['test'])
  })
})

describe('re-running one job', () => {
  test('takes that job and what waited on it', () => {
    const jobs = [
      job('build', 'succeeded'),
      job('test', 'succeeded'),
      job('deploy', 'succeeded', { needs: 'test' }),
    ]

    // Even though everything passed: re-running `test` invalidates the answer
    // `deploy` was given, and leaving it alone would leave a run whose deploy
    // belongs to a test result that no longer exists.
    expect(rerunPlan({ jobs, scope: 'job', jobKey: 'test' }).map(one => one.job_id).sort())
      .toEqual(['deploy', 'test'])
  })

  test('and a name nobody has selects nothing', () => {
    expect(rerunPlan({ jobs: [job('build', 'failed')], scope: 'job', jobKey: 'ghost' })).toEqual([])
  })
})

describe('re-running everything', () => {
  test('is every job, whatever state it is in', () => {
    const jobs = [job('build', 'succeeded'), job('test', 'failed'), job('skip', 'skipped')]

    expect(rerunPlan({ jobs, scope: 'all' }).length).toBe(3)
  })
})

describe('where a job goes back to', () => {
  test('queued when nothing gates it, blocked when something does', () => {
    expect(resetState(job('build', 'failed'))).toBe('queued')
    expect(resetState(job('deploy', 'failed', { needs: 'build' }))).toBe('blocked')
  })

  test('and always blocked for the control plane\'s own kinds', () => {
    /*
     * The same rule the dispatcher uses when it builds a graph: `queued` means
     * "a runner may take this", and no runner may take a barrier, a gate or a
     * trigger. A re-run that put one back as queued would leave it sitting in a
     * queue nothing can ever answer.
     */
    for (const kind of ['wait', 'block', 'trigger'])
      expect(resetState(job('gate', 'succeeded', { kind }))).toBe('blocked')
  })
})
