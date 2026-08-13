// The state machine as a whole, rather than one transition at a time.
//
// `workflow-states.test.ts` covers the transitions somebody thought to write
// down. What it cannot cover is the shape of the table itself: a state added to
// the union and forgotten in the table, a terminal state that grew an exit, a
// transition naming a state that does not exist. Each of those is a one-line
// mistake that no individual case would catch, and each ends with a run that
// either never finishes or finishes twice.
//
// The roadmap asks for "tests covering every state transition". This is the
// half that makes that claim checkable: every state is in the table, every exit
// is real, and the states nothing may leave are exactly the ones the terminal
// lists name.

import { describe, expect, test } from 'bun:test'
import type { JobState, RunState } from '../../app/Actions/Workflow/states'
import {
  canJobMove,
  canRunMove,
  isTerminalJob,
  isTerminalRun,
  runStateFromJobs,
  TERMINAL_JOB_STATES,
  TERMINAL_RUN_STATES,
} from '../../app/Actions/Workflow/states'

/**
 * Every state, written out here rather than imported.
 *
 * Deliberately a second copy: importing the same list the code uses would make
 * this test agree with any change automatically, which is the one thing it must
 * not do. A state added to the product has to be added here too, and that edit
 * is the moment somebody decides what it may become.
 */
const RUN_STATES: RunState[] = [
  'queued', 'running', 'waiting', 'paused', 'cancelling', 'cancelled', 'failed', 'succeeded',
]

const JOB_STATES: JobState[] = [
  'blocked', 'queued', 'running', 'cancelling', 'cancelled', 'failed', 'skipped', 'succeeded',
]

describe('the run table', () => {
  test('every state can reach a terminal one, or is already terminal', () => {
    // A state with no way out is a run that never finishes, which holds a pull
    // request's checks open on work nobody is doing.
    const stuck = RUN_STATES.filter((from) => {
      if (isTerminalRun(from))
        return false

      return !RUN_STATES.some(to => to !== from && isTerminalRun(to) && canRunMove(from, to))
    })

    expect(stuck).toEqual([])
  })

  test('no terminal state has an exit', () => {
    /*
     * The rule the whole file exists for. A cancelled run turning green
     * satisfies a branch protection rule with a check nobody ran, and a
     * succeeded run turning failed does the reverse to somebody's release -
     * and both are silent, because the row simply says something else.
     */
    const escapes: string[] = []

    for (const from of TERMINAL_RUN_STATES) {
      for (const to of RUN_STATES) {
        if (to !== from && canRunMove(from, to))
          escapes.push(`${from} → ${to}`)
      }
    }

    expect(escapes).toEqual([])
  })

  test('a state may always stay where it is', () => {
    // At-least-once delivery means the same report arrives twice, and the
    // second one asks for the transition that already happened.
    for (const state of RUN_STATES)
      expect({ state, same: canRunMove(state, state) }).toEqual({ state, same: true })
  })

  test('cancelling keeps every way out, not only to cancelled', () => {
    // Cancellation is cooperative: a job that finished successfully in the
    // moment between the request and the acknowledgement really did finish, and
    // forcing it to `cancelled` would be the control plane overwriting
    // something that happened.
    expect(canRunMove('cancelling', 'succeeded')).toBe(true)
    expect(canRunMove('cancelling', 'failed')).toBe(true)
    expect(canRunMove('cancelling', 'cancelled')).toBe(true)
  })
})

describe('the job table', () => {
  test('every state can reach a terminal one, or is already terminal', () => {
    const stuck = JOB_STATES.filter((from) => {
      if (isTerminalJob(from))
        return false

      return !JOB_STATES.some(to => to !== from && isTerminalJob(to) && canJobMove(from, to))
    })

    expect(stuck).toEqual([])
  })

  test('no terminal state has an exit', () => {
    const escapes: string[] = []

    for (const from of TERMINAL_JOB_STATES) {
      for (const to of JOB_STATES) {
        if (to !== from && canJobMove(from, to))
          escapes.push(`${from} → ${to}`)
      }
    }

    expect(escapes).toEqual([])
  })

  test('a blocked job can be skipped without ever running', () => {
    // What happens when the job it needed failed. Without it the run waits on
    // something that can never happen.
    expect(canJobMove('blocked', 'skipped')).toBe(true)
  })
})

describe('the run state derived from its jobs', () => {
  /*
   * Derived rather than accumulated, so a control plane that restarted
   * mid-run reaches the same answer as one that watched every transition. These
   * assert the precedence, which is the part a reader has to trust.
   */
  test('anything unfinished means the run is unfinished', () => {
    expect(runStateFromJobs(['succeeded', 'running'])).toBe('running')
    expect(runStateFromJobs(['succeeded', 'queued'])).toBe('queued')
    expect(runStateFromJobs(['failed', 'running'])).toBe('running')
  })

  test('one job asked to stop makes the run cancelling', () => {
    expect(runStateFromJobs(['succeeded', 'cancelling'])).toBe('cancelling')
  })

  test('a failure fails the run once everything has finished', () => {
    expect(runStateFromJobs(['succeeded', 'failed'])).toBe('failed')
  })

  test('a cancellation among finished jobs cancels the run', () => {
    // A mix of cancelled and succeeded is still a cancellation: something was
    // stopped, and calling that green would be the tick a superseded run leaves
    // behind.
    expect(runStateFromJobs(['succeeded', 'cancelled'])).toBe('cancelled')
  })

  test('a skipped job does not fail a run', () => {
    // It is a job the graph decided not to run, which is an outcome rather than
    // a problem.
    expect(runStateFromJobs(['succeeded', 'skipped'])).toBe('succeeded')
  })

  test('and a run with no jobs at all is queued rather than green', () => {
    // The state a misconfigured workflow leaves behind. Green would mean a run
    // that did nothing satisfied every check on the commit.
    expect(runStateFromJobs([])).toBe('queued')
  })

  test('every state it can produce is a state the table knows', () => {
    // The two lists are edited in different places, and a derived state the
    // transition table has never heard of is a run that cannot move again.
    const produced = new Set<RunState>()

    for (const a of JOB_STATES) {
      for (const b of JOB_STATES)
        produced.add(runStateFromJobs([a, b]))
    }

    for (const state of produced)
      expect({ state, known: RUN_STATES.includes(state) }).toEqual({ state, known: true })
  })
})
