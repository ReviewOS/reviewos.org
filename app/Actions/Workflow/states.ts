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

export type RunState =
  | 'queued' | 'running' | 'waiting' | 'paused'
  | 'cancelling' | 'cancelled' | 'failed' | 'succeeded'

export type JobState =
  | 'blocked' | 'queued' | 'running' | 'cancelling'
  | 'cancelled' | 'failed' | 'skipped' | 'succeeded'

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
  blocked: ['queued', 'cancelled', 'skipped', 'failed'],
  queued: ['running', 'cancelling', 'cancelled', 'skipped', 'failed'],
  running: ['cancelling', 'cancelled', 'failed', 'succeeded'],
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
 * The jobs that can be handed out now.
 *
 * A job is eligible when everything it needs has succeeded. `needs` naming a
 * job that is not in the run cannot happen - the validator refused it before a
 * row existed - but it is treated as unsatisfied rather than ignored, because
 * "the graph is missing a job" must not become "run it anyway".
 */
export function eligibleJobs<T extends { job_id: string, state: JobState, needs?: string | null }>(
  jobs: readonly T[],
): T[] {
  const byId = new Map(jobs.map(job => [job.job_id, job]))

  return jobs.filter((job) => {
    if (job.state !== 'blocked')
      return false

    const needs = String(job.needs ?? '').split('\n').map(line => line.trim()).filter(Boolean)

    return needs.every(need => byId.get(need)?.state === 'succeeded')
  })
}

/**
 * Jobs that can never run, because something they needed did not succeed.
 *
 * Skipped rather than left blocked forever. A run whose last job sits in
 * `blocked` never reaches a terminal state, and a run that never finishes is
 * one that holds a pull request's checks open with nothing to show for it.
 */
export function unreachableJobs<T extends { job_id: string, state: JobState, needs?: string | null }>(
  jobs: readonly T[],
): T[] {
  const byId = new Map(jobs.map(job => [job.job_id, job]))

  const failed = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id))
      return false

    seen.add(id)
    const job = byId.get(id)
    if (!job)
      return true

    if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'skipped')
      return true

    const needs = String(job.needs ?? '').split('\n').map(line => line.trim()).filter(Boolean)
    return needs.some(need => failed(need, seen))
  }

  return jobs.filter((job) => {
    if (job.state !== 'blocked')
      return false

    const needs = String(job.needs ?? '').split('\n').map(line => line.trim()).filter(Boolean)
    return needs.some(need => failed(need))
  })
}
