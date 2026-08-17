// What a matrix means to the graph: `needs`, `fail-fast`, `continue-on-error`.
//
// The reason this file exists apart from `workflow-states.test.ts`: that one
// tests jobs whose `job_id` is unique, and a matrix breaks that assumption -
// four rows, one name, and `needs: build` meaning all four of them. Every case
// here is one the old code got wrong by keeping the last row it saw.

import { describe, expect, test } from 'bun:test'
import type { JobState } from '../../app/Actions/Workflow/states'
import {
  effectiveState,
  eligibleJobs,
  failFastCasualties,
  runStateFromJobs,
  unreachableJobs,
} from '../../app/Actions/Workflow/states'

interface Row {
  id: number
  job_id: string
  state: JobState
  needs: string | null
  continue_on_error?: boolean
  fail_fast?: boolean
}

let next = 1

function row(job_id: string, state: JobState, extra: Partial<Row> = {}): Row {
  return { id: next++, job_id, state, needs: null, ...extra }
}

describe('a matrix is several rows under one name', () => {
  test('a dependant waits for every combination, not the last one written', () => {
    const jobs = [
      row('build', 'succeeded'),
      row('build', 'running'),
      row('deploy', 'blocked', { needs: 'build' }),
    ]

    expect(eligibleJobs(jobs)).toEqual([])
  })

  /*
   * The failure this replaces, stated as a test because it shipped: a map keyed
   * by `job_id` kept the last combination, so a matrix whose first combination
   * failed and whose last succeeded unblocked the deploy that the failure was
   * supposed to stop.
   */
  test('one failed combination holds the dependant back even when the rest are green', () => {
    const jobs = [
      row('build', 'failed'),
      row('build', 'succeeded'),
      row('build', 'succeeded'),
      row('deploy', 'blocked', { needs: 'build' }),
    ]

    expect(eligibleJobs(jobs)).toEqual([])
    expect(unreachableJobs(jobs).map(job => job.job_id)).toEqual(['deploy'])
  })

  test('and all of them succeeding is what releases it', () => {
    const jobs = [
      row('build', 'succeeded'),
      row('build', 'succeeded'),
      row('deploy', 'blocked', { needs: 'build' }),
    ]

    expect(eligibleJobs(jobs).map(job => job.job_id)).toEqual(['deploy'])
  })

  test('a combination skipped by its own `if:` does not hold up the rest', () => {
    const jobs = [
      row('build', 'succeeded'),
      row('build', 'skipped'),
      row('deploy', 'blocked', { needs: 'build' }),
    ]

    expect(eligibleJobs(jobs).map(job => job.job_id)).toEqual(['deploy'])
  })

  test('but a group that was skipped entirely makes its dependant unreachable', () => {
    const jobs = [
      row('build', 'skipped'),
      row('build', 'skipped'),
      row('deploy', 'blocked', { needs: 'build' }),
    ]

    expect(eligibleJobs(jobs)).toEqual([])
    expect(unreachableJobs(jobs).map(job => job.job_id)).toEqual(['deploy'])
  })

  test('every blocked row of a dependent matrix is released, not just the first', () => {
    const jobs = [
      row('build', 'succeeded'),
      row('test', 'blocked', { needs: 'build' }),
      row('test', 'blocked', { needs: 'build' }),
      row('test', 'blocked', { needs: 'build' }),
    ]

    // Three rows, three ids. Moving one and calling it done is how two thirds
    // of a matrix sat in `blocked` until the run was force-cancelled.
    expect(eligibleJobs(jobs).map(job => job.id)).toHaveLength(3)
  })
})

describe('continue-on-error at job level', () => {
  test('a failure the workflow allowed counts as success to what needs it', () => {
    const jobs = [
      row('flaky', 'failed', { continue_on_error: true }),
      row('deploy', 'blocked', { needs: 'flaky' }),
    ]

    expect(eligibleJobs(jobs).map(job => job.job_id)).toEqual(['deploy'])
    expect(unreachableJobs(jobs)).toEqual([])
  })

  test('and does not fail the run', () => {
    expect(runStateFromJobs([
      effectiveState({ state: 'failed', continue_on_error: true }),
      effectiveState({ state: 'succeeded' }),
    ])).toBe('succeeded')
  })

  test('while the row itself still says what happened', () => {
    // The distinction the whole feature turns on: the run is green and the job
    // is red, which is exactly what somebody looking for the flaky suite needs
    // to see.
    const job = { state: 'failed' as JobState, continue_on_error: true }

    expect(job.state).toBe('failed')
    expect(effectiveState(job)).toBe('succeeded')
  })
})

describe('fail-fast', () => {
  test('a failed combination stops its siblings, queued and running alike', () => {
    const jobs = [
      row('test', 'failed'),
      row('test', 'queued'),
      row('test', 'running'),
      row('test', 'succeeded'),
    ]

    const casualties = failFastCasualties(jobs)

    expect(casualties.cancel.map(job => job.state)).toEqual(['queued'])
    expect(casualties.stop.map(job => job.state)).toEqual(['running'])
  })

  test('`fail-fast: false` leaves them alone, which is the whole reason to write it', () => {
    const jobs = [
      row('test', 'failed', { fail_fast: false }),
      row('test', 'queued', { fail_fast: false }),
      row('test', 'running', { fail_fast: false }),
    ]

    expect(failFastCasualties(jobs)).toEqual({ cancel: [], stop: [] })
  })

  test('a failure the workflow allowed is not one to fail fast on', () => {
    const jobs = [
      row('test', 'failed', { continue_on_error: true }),
      row('test', 'queued'),
    ]

    expect(failFastCasualties(jobs)).toEqual({ cancel: [], stop: [] })
  })

  test('it does not reach outside the matrix', () => {
    // Actions scopes this to the matrix, and widening it would mean one job's
    // failure stopping unrelated work somebody is watching.
    const jobs = [
      row('test', 'failed'),
      row('test', 'queued'),
      row('lint', 'running'),
      row('docs', 'queued'),
    ]

    const casualties = failFastCasualties(jobs)

    expect(casualties.cancel.map(job => job.job_id)).toEqual(['test'])
    expect(casualties.stop).toEqual([])
  })

  test('a job with no siblings has nothing to fail fast about', () => {
    expect(failFastCasualties([row('build', 'failed')])).toEqual({ cancel: [], stop: [] })
  })
})
