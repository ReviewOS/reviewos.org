// `cancel-on-build-failing`: the long job nobody is going to read the result of.
//
// The case is the forty-minute browser suite that is still going when the unit
// tests have already gone red. The run is failed whatever the suite says, and
// the machine it holds is one nothing else can use.
//
// Two things make this different from `fail-fast`, and each one is a way it
// could reasonably have been built and should not have been: it is run-wide
// rather than scoped to a matrix, and it is off unless a job asks.

import { describe, expect, test } from 'bun:test'
import type { JobState } from '../../app/Actions/Workflow/states'
import { cancelOnFailingCasualties } from '../../app/Actions/Workflow/states'

interface Row {
  id: number
  job_id: string
  state: JobState
  continue_on_error?: boolean
  cancel_on_build_failing?: boolean
}

let next = 1

function row(job_id: string, state: JobState, extra: Partial<Row> = {}): Row {
  return { id: next++, job_id, state, ...extra }
}

describe('once the run is going to fail', () => {
  test('a job that asked is stopped, and one that did not is left alone', () => {
    const decided = cancelOnFailingCasualties([
      row('unit', 'failed'),
      row('browser', 'running', { cancel_on_build_failing: true }),
      row('lint', 'running'),
    ])

    expect(decided.stop.map(one => one.job_id)).toEqual(['browser'])
    expect(decided.cancel).toEqual([])
  })

  test('one that has not started yet is cancelled rather than asked to stop', () => {
    /*
     * Nothing is holding it, so there is nobody to tell. A `cancelling` row
     * with no machine behind it is one waiting for an acknowledgement that will
     * never come.
     */
    const decided = cancelOnFailingCasualties([
      row('unit', 'failed'),
      row('browser', 'queued', { cancel_on_build_failing: true }),
      row('e2e', 'blocked', { cancel_on_build_failing: true }),
    ])

    expect(decided.cancel.map(one => one.job_id)).toEqual(['browser', 'e2e'])
    expect(decided.stop).toEqual([])
  })

  test('and a running job is asked to stop rather than declared stopped', () => {
    // The machine has to be told and has to acknowledge. A control plane that
    // writes `cancelled` for work it cannot observe reports outcomes that did
    // not happen.
    const decided = cancelOnFailingCasualties([
      row('unit', 'failed'),
      row('browser', 'running', { cancel_on_build_failing: true }),
    ])

    expect(decided.stop.map(one => one.state)).toEqual(['running'])
  })
})

describe('what does not count as the run failing', () => {
  test('a failure the workflow said to allow', () => {
    // `continue-on-error: true` means "this failing is fine", and a job that
    // tolerates its own failure has not sunk anything.
    const decided = cancelOnFailingCasualties([
      row('flaky-linter', 'failed', { continue_on_error: true }),
      row('browser', 'running', { cancel_on_build_failing: true }),
    ])

    expect(decided.stop).toEqual([])
    expect(decided.cancel).toEqual([])
  })

  test('nothing having failed at all', () => {
    expect(cancelOnFailingCasualties([
      row('unit', 'running'),
      row('browser', 'running', { cancel_on_build_failing: true }),
    ])).toEqual({ cancel: [], stop: [] })
  })
})

describe('the default', () => {
  test('is off, so the jobs written for a failure still run', () => {
    /*
     * The reason this is opt-in rather than run-wide. A job that publishes the
     * results, tears down a preview environment, or posts the failure to a
     * channel exists *because* something failed - and stopping those
     * automatically would break the pipelines people lean on hardest on the
     * day a build breaks.
     */
    const decided = cancelOnFailingCasualties([
      row('unit', 'failed'),
      row('publish-results', 'queued'),
      row('teardown', 'running'),
    ])

    expect(decided).toEqual({ cancel: [], stop: [] })
  })

  test('and an unrecorded value is off rather than absent-means-true', () => {
    // A row written before this key existed behaves the way its file said.
    const decided = cancelOnFailingCasualties([
      row('unit', 'failed'),
      row('browser', 'running', { cancel_on_build_failing: undefined }),
    ])

    expect(decided.stop).toEqual([])
  })
})
