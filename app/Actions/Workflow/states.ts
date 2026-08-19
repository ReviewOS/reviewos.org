/**
 * What a run and its jobs are allowed to do next.
 *
 * The rule worth enforcing in one place is the one about going backwards. A
 * finished run must never move again: the runner that was executing it may
 * still be alive - it is somebody else's machine and the control plane cannot
 * kill it - so a late message from a lease that has lapsed will arrive, and the
 * only question is whether it is refused here or quietly believed.
 *
 * **Believing it is the worst outcome this system has.** A cancelled run
 * turning green satisfies a branch protection rule with a check nobody ran, and
 * a succeeded run turning failed does the reverse to somebody's release. Both
 * are silent: the row simply says something else than it did.
 */

import { isNotFalse, isTrue } from '../Support/sql'

export type RunState =
  | 'queued' | 'running' | 'waiting' | 'paused'
  | 'cancelling' | 'cancelled' | 'failed' | 'succeeded'

export type JobState =
  | 'blocked' | 'queued' | 'running' | 'cancelling'
  | 'cancelled' | 'failed' | 'skipped' | 'succeeded'
  /*
   * A gate waiting for a person.
   *
   * Deliberately not `blocked`, which means "waiting for another job" and is
   * something the graph resolves on its own. Nothing resolves this but
   * somebody deciding, and a screen that cannot tell the two apart cannot show
   * the button - which is the entire difference between a gate and a hang.
   */
  | 'paused'
  /**
   * An orchestrator that suspended itself on a timer.
   *
   * The fourth kind of waiting, and it needed its own name because what
   * resolves it is different again: the graph resolves `blocked`, a person
   * resolves `paused`, the next free machine resolves `queued`, and a clock
   * resolves this. Leaving it `queued` would let a runner claim a workflow that
   * asked to wait three days, and it would claim it immediately.
   */
  | 'sleeping'

/** A state nothing can leave. */
export const TERMINAL_RUN_STATES: readonly RunState[] = ['cancelled', 'failed', 'succeeded']
export const TERMINAL_JOB_STATES: readonly JobState[] = ['cancelled', 'failed', 'skipped', 'succeeded']

export function isTerminalRun(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state)
}

export function isTerminalJob(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state)
}

/**
 * Where a run may go from here.
 *
 * `cancelling` keeps its way out to every terminal state rather than only to
 * `cancelled`: cancellation is cooperative first, and a job that finished
 * successfully in the moment between the request and the acknowledgement really
 * did finish. Forcing it to `cancelled` would be the control plane overwriting
 * something that happened.
 */
const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['running', 'cancelling', 'cancelled', 'failed'],
  running: ['waiting', 'paused', 'cancelling', 'cancelled', 'failed', 'succeeded'],
  waiting: ['running', 'paused', 'cancelling', 'cancelled', 'failed'],
  paused: ['running', 'waiting', 'cancelling', 'cancelled', 'failed'],
  cancelling: ['cancelled', 'failed', 'succeeded'],
  cancelled: [],
  failed: [],
  succeeded: [],
}

const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  // A blocked job can be skipped without ever running, which is what happens
  // when what it needed failed.
  blocked: ['queued', 'paused', 'cancelled', 'skipped', 'failed'],
  /*
   * A paused gate goes to `succeeded` when somebody opens it and `cancelled`
   * when somebody stops the run. It has no way to `failed`: a gate nobody
   * opened did not fail, and reporting it as a failure would put a red cross
   * on somebody's commit for a decision that was never made.
   */
  paused: ['succeeded', 'cancelled', 'skipped'],
  /*
   * A sleep ends by going back to the queue, and that is its only way forward
   * other than being stopped. It cannot reach `running` directly: the run
   * resumes by a machine claiming it, and pretending otherwise would give a run
   * a state no runner ever agreed to.
   */
  sleeping: ['queued', 'cancelling', 'cancelled', 'failed', 'skipped'],
  queued: ['running', 'cancelling', 'cancelled', 'skipped', 'failed'],
  running: ['sleeping', 'cancelling', 'cancelled', 'failed', 'succeeded'],
  cancelling: ['cancelled', 'failed', 'succeeded'],
  cancelled: [],
  failed: [],
  skipped: [],
  succeeded: [],
}

export function canRunMove(from: RunState, to: RunState): boolean {
  if (from === to)
    return true

  return (RUN_TRANSITIONS[from] ?? []).includes(to)
}

export function canJobMove(from: JobState, to: JobState): boolean {
  if (from === to)
    return true

  return (JOB_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * What a run's state should be, given its jobs.
 *
 * Derived rather than accumulated, so a control plane that restarted mid-run
 * reaches the same answer as one that watched every transition. An accumulated
 * status is a second source of truth that drifts from the rows it summarises.
 *
 * The precedence is the one a reader expects: **anything unfinished means the
 * run is unfinished**, one failure fails it, and a run is only green when
 * everything that was going to happen has and none of it failed. A skipped job
 * does not fail a run - it is a job the graph decided not to run, which is an
 * outcome rather than a problem.
 */
export function runStateFromJobs(states: readonly JobState[]): RunState {
  if (states.length === 0)
    return 'queued'

  if (states.some(state => state === 'cancelling'))
    return 'cancelling'

  /*
   * A run with a gate open, or an orchestrator asleep, is `waiting` rather than
   * `running`.
   *
   * The difference is whether a machine is working. `running` says one is;
   * `waiting` says nothing will happen until something outside this instance
   * moves - a person opening the gate, or a timer coming due. Both are states
   * where a spinner is not the instance being slow, which is the distinction
   * worth showing.
   */
  if (states.some(state => state === 'paused' || state === 'sleeping') && !states.some(state => state === 'running'))
    return 'waiting'

  const unfinished = states.some(state => !isTerminalJob(state))

  if (unfinished) {
    // A failure with work still going is still running: the remaining jobs may
    // be cancelled by policy, and saying "failed" now would be a verdict the
    // run has not reached.
    return states.some(state => state === 'running') ? 'running' : 'queued'
  }

  if (states.some(state => state === 'failed'))
    return 'failed'

  // Every job cancelled means the run was cancelled. A mix of cancelled and
  // succeeded is also a cancellation: something was stopped.
  if (states.some(state => state === 'cancelled'))
    return 'cancelled'

  return 'succeeded'
}

/**
 * One row of a run, as the graph needs to see it.
 *
 * `job_id` is **not** unique in a run: a matrix of four is four rows under one
 * `job_id`, which is exactly what `needs:` names. Everything below is written
 * against that fact rather than around it.
 */
export interface GraphJob {
  job_id: string
  state: JobState
  needs?: string | null
  /** `continue-on-error:` on the job, which changes what its failure means. */
  continue_on_error?: boolean | null
  /** `strategy.fail-fast`, defaulting to Actions' `true` when unrecorded. */
  fail_fast?: boolean | null
  /**
   * Whether this job runs even when what it needed did not succeed.
   *
   * The roadmap's `allow_dependency_failure`, and what a `wait:` barrier with
   * `continue-on-failure: true` sets. It is the graph-level twin of
   * `if: always()`: the dependencies still have to be *finished*, because the
   * point of a barrier is that everything before it is over - only their
   * verdict stops mattering.
   */
  allow_failure?: boolean | null

  /**
   * `cancel-on-build-failing:` - stop this job once the run is going to fail.
   *
   * Off unless the job asks. The default has to be off: a job that publishes
   * the results, tears down a preview environment or posts the failure to a
   * channel is written to run *because* something failed, and stopping those
   * automatically would break the pipelines people rely on most when a build
   * breaks.
   */
  cancel_on_build_failing?: boolean | null
}

/**
 * What a job's state means to everything that reads it.
 *
 * A job with `continue-on-error: true` that failed reports `success` to the
 * jobs that need it and does not fail the run - Actions' rule, and the reason
 * the key exists at all. The row keeps saying `failed`, because that is what
 * happened; this is the one place that decides what it *counts as*, so a screen
 * can show the failure while the graph carries on.
 */
export function effectiveState(job: { state: JobState, continue_on_error?: boolean | null }): JobState {
  return job.state === 'failed' && isTrue(job.continue_on_error) ? 'succeeded' : job.state
}

/** The `needs:` column, which is newline-separated because YAML lists are. */
function needsOf(job: GraphJob): string[] {
  return String(job.needs ?? '').split('\n').map(line => line.trim()).filter(Boolean)
}

/**
 * What one name in a `needs:` list has come to, over every row that carries it.
 *
 * The aggregate, not the last row - which is the bug this replaces. `needs:
 * build` on a matrix of four means all four, so one failing combination has to
 * hold the dependent back even when the other three are green. Keying a map by
 * `job_id` quietly kept the last combination and ran the deploy that the first
 * one said not to.
 */
function groupState(members: readonly GraphJob[]): JobState | 'pending' | 'missing' {
  if (members.length === 0)
    return 'missing'

  const states = members.map(effectiveState)

  if (states.some(state => !isTerminalJob(state)))
    return 'pending'

  if (states.some(state => state === 'failed'))
    return 'failed'

  if (states.some(state => state === 'cancelled'))
    return 'cancelled'

  if (states.every(state => state === 'skipped'))
    return 'skipped'

  return 'succeeded'
}

function grouped<T extends GraphJob>(jobs: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()

  for (const job of jobs)
    groups.set(job.job_id, [...(groups.get(job.job_id) ?? []), job])

  return groups
}

/**
 * The jobs that can be handed out now.
 *
 * A job is eligible when every group it needs has succeeded. `needs` naming a
 * job that is not in the run cannot happen - the validator refused it before a
 * row existed - but it is treated as unsatisfied rather than ignored, because
 * "the graph is missing a job" must not become "run it anyway".
 */
export function eligibleJobs<T extends GraphJob>(jobs: readonly T[]): T[] {
  const groups = grouped(jobs)

  return jobs.filter((job) => {
    if (job.state !== 'blocked')
      return false

    return needsOf(job).every((need) => {
      const state = groupState(groups.get(need) ?? [])

      if (job.allow_failure === true)
        return state !== 'pending' && state !== 'missing'

      return state === 'succeeded'
    })
  })
}

/**
 * Jobs that can never run, because something they needed did not succeed.
 *
 * Skipped rather than left blocked forever. A run whose last job sits in
 * `blocked` never reaches a terminal state, and a run that never finishes is
 * one that holds a pull request's checks open with nothing to show for it.
 */
export function unreachableJobs<T extends GraphJob>(jobs: readonly T[]): T[] {
  const groups = grouped(jobs)

  const failed = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id))
      return false

    seen.add(id)

    const members = groups.get(id) ?? []
    const state = groupState(members)

    if (state === 'missing')
      return true

    if (state === 'failed' || state === 'cancelled' || state === 'skipped')
      return true

    return members.some(member => needsOf(member).some(need => failed(need, seen)))
  }

  return jobs.filter((job) => {
    if (job.state !== 'blocked')
      return false

    // A job that said it survives a failed dependency is never unreachable:
    // that is the whole of what it asked for.
    if (job.allow_failure === true)
      return false

    return needsOf(job).some(need => failed(need))
  })
}

/**
 * The jobs that asked to be stopped once the run is going to fail.
 *
 * Buildkite's `cancel_on_build_failing`, and the case it is for is the
 * forty-minute browser suite that is still going when the unit tests have
 * already gone red. Nobody is going to read its result: the run is failed
 * whatever it says, and the machine it is holding is one nothing else can use.
 *
 * **The run being *already* failed is the trigger, not this job failing.** That
 * makes it different from `fail-fast`, which is scoped to one matrix and stops
 * siblings of the combination that broke. This is run-wide and opt-in per job,
 * which is the right way round: run-wide by default would stop the cleanup jobs
 * written precisely for a failure.
 *
 * A failure the workflow said to allow does not count, the same rule
 * `fail-fast` follows - `continue-on-error: true` means "this failing is fine",
 * and a job that tolerates its own failure has not sunk anything.
 */
export function cancelOnFailingCasualties<T extends GraphJob>(jobs: readonly T[]): { cancel: T[], stop: T[] } {
  const cancel: T[] = []
  const stop: T[] = []

  const sunk = jobs.some(job => job.state === 'failed' && !isTrue(job.continue_on_error))

  if (!sunk)
    return { cancel, stop }

  for (const job of jobs) {
    if (job.cancel_on_build_failing !== true)
      continue

    if (job.state === 'blocked' || job.state === 'queued')
      cancel.push(job)

    /*
     * Asked to stop rather than declared stopped, the same shape as every other
     * cancellation here: the machine holding it has to be told and has to
     * acknowledge, and a control plane that writes `cancelled` for work it
     * cannot observe is one that reports outcomes that did not happen.
     */
    if (job.state === 'running')
      stop.push(job)
  }

  return { cancel, stop }
}

/**
 * The matrix combinations a failed sibling takes with it.
 *
 * `strategy.fail-fast` defaults to **true**, which is the surprising direction
 * and the one Actions chose: one combination failing cancels the rest. The
 * argument for it is money - twenty combinations of a broken commit is nineteen
 * machines proving the same thing - and the argument against it is that the
 * *interesting* question is usually "which ones broke", which is why the key
 * exists and why a matrix that sets `fail-fast: false` must be left alone.
 *
 * Only within one group. Actions scopes this to the matrix rather than to the
 * run, and widening it here would mean an unrelated job's failure stopping work
 * somebody is watching.
 */
export function failFastCasualties<T extends GraphJob>(jobs: readonly T[]): { cancel: T[], stop: T[] } {
  const cancel: T[] = []
  const stop: T[] = []

  for (const members of grouped(jobs).values()) {
    if (members.length < 2)
      continue

    // Unrecorded means Actions' default, not "off": a row written before this
    // column existed should behave the way the file said.
    if (members.some(member => !isNotFalse(member.fail_fast)))
      continue

    // A failure the workflow said to allow is not a failure to fail fast on.
    if (!members.some(member => member.state === 'failed' && !isTrue(member.continue_on_error)))
      continue

    for (const member of members) {
      if (member.state === 'blocked' || member.state === 'queued')
        cancel.push(member)

      if (member.state === 'running')
        stop.push(member)
    }
  }

  return { cancel, stop }
}
