/**
 * Pools and queues: which machines may take which repository's work.
 *
 * A list of runners is enough for one team on one box. It stops being enough
 * the moment a fleet has machines bought for different reasons: a runner
 * standing up the deployment pipeline, holding the credentials that pipeline
 * needs, will take a pull request check from an unrelated repository, and the
 * only thing between the two is whichever labels somebody remembered to write.
 *
 * Two rules, both decided here so the claim and the "why is this queued" screen
 * cannot disagree about them:
 *
 * - **A paused queue hands out nothing.** Draining is how machines come out of
 *   service without deleting them, and the jobs waiting stay waiting rather
 *   than failing.
 * - **A pool serves the repositories it lists, and every repository when it
 *   lists none.** The empty list is what every existing install has, so nobody
 *   is quietly given a boundary they did not ask for; adding one repository is
 *   the act of drawing it.
 *
 * Pure over rows the caller has already read, like `protocol.ts` next to it,
 * so both the dispatcher's answer and the screen's explanation come from one
 * function rather than from two that drift.
 */

export interface QueueFacts {
  id: number
  name: string
  state: string
  poolId: number
  poolName: string
  pausedReason: string | null
  /**
   * Repository ids this pool serves, or an empty list for "every one".
   *
   * Empty is *unrestricted* rather than *nothing*, which reads backwards until
   * you consider which way an operator would rather be wrong: a pool that
   * silently served nothing would take a fleet offline the moment somebody
   * created it.
   */
  repositoryIds: readonly number[]
  /**
   * Whether machines in this pool refuse work this instance did not sign.
   *
   * Carried on the queue facts because the claim already reads them, and the
   * runner needs the answer at the same moment it receives the steps: a flag it
   * has to fetch separately is one it can be talked out of fetching.
   */
  requireSignedSteps: boolean
}

export type FleetVerdict =
  | { ok: true }
  | { ok: false, kind: 'queue-paused' | 'pool-refuses', reason: string }

/**
 * Whether this queue may take this repository's work right now.
 *
 * A runner in no queue is not asking this question at all: it is matched by
 * label and scope exactly as every runner was before pools existed, which is
 * what keeps an instance that never opened this screen working.
 */
export function queueAccepts(queue: QueueFacts | null, repositoryId: number): FleetVerdict {
  if (!queue)
    return { ok: true }

  if (queue.state === 'paused') {
    return {
      ok: false,
      kind: 'queue-paused',
      reason: queue.pausedReason
        ? `The \`${queue.name}\` queue is paused: ${queue.pausedReason}`
        : `The \`${queue.name}\` queue is paused, so its machines are not taking work.`,
    }
  }

  if (queue.repositoryIds.length === 0)
    return { ok: true }

  if (queue.repositoryIds.includes(repositoryId))
    return { ok: true }

  return {
    ok: false,
    kind: 'pool-refuses',
    /*
     * Named without listing the pool's other repositories. Somebody looking at
     * one repository's run has no business learning which other repositories a
     * pool serves, and on a shared instance that list is the map of who is
     * working on what.
     */
    reason: `The \`${queue.poolName}\` pool does not serve this repository, so its runners will not take this job.`,
  }
}

/**
 * What a runner is doing, as opposed to what an operator set it to.
 *
 * `state` is administrative - somebody switched this machine on or off - and it
 * answers the wrong question when a fleet is not behaving. The question is
 * "which machines are working, which are sitting there, and which have gone
 * quiet", and none of those is a column: they are the lease, the last poll and
 * the stop somebody asked for, read together.
 *
 * Derived rather than stored for the reason every derived state in this phase
 * is: a status column has to be written by whoever causes the change, and the
 * one change nobody causes - a machine going quiet - is the one that matters.
 */
export type RunnerLifecycle =
  /** Registered, never polled. A credential somebody made and nobody used. */
  | 'never-seen'
  /** Switched off by an operator. */
  | 'disabled'
  /** Asked to stop, still finishing what it holds. */
  | 'stopping'
  /** Holding a job, with a live lease. */
  | 'running'
  /** Polling, with nothing to do. */
  | 'idle'
  /** Was working and stopped talking. The one nobody sets. */
  | 'lost'

export interface RunnerObservation {
  state: string
  lastSeenAt: string | null
  stopRequested: string | null
  /** Whether it currently holds a job whose lease has not lapsed. */
  holdsJob: boolean
  /** Whether the lease on that job has already passed. */
  leaseLapsed: boolean
}

/**
 * How long a runner may be silent before it counts as lost.
 *
 * Longer than a poll interval and shorter than a person's patience. A runner
 * that is idle polls every few seconds; one that has been quiet for two minutes
 * has either stopped or cannot reach the instance, and both are worth showing
 * as something other than "idle".
 */
export const SILENT_SECONDS = 120

export function runnerLifecycle(runner: RunnerObservation, now: Date = new Date()): RunnerLifecycle {
  if (runner.state === 'disabled')
    return 'disabled'

  const seen = runner.lastSeenAt ? Date.parse(runner.lastSeenAt) : Number.NaN
  const silentFor = Number.isFinite(seen) ? (now.getTime() - seen) / 1000 : Number.POSITIVE_INFINITY

  /*
   * Lost outranks stopping and running, because it is the one that is not
   * true by assumption: a machine asked to stop that then goes quiet has
   * stopped without saying so, and a machine holding a job whose lease has
   * lapsed is exactly what the reclaim sweep is about.
   */
  if (runner.leaseLapsed || (silentFor > SILENT_SECONDS && runner.lastSeenAt))
    return 'lost'

  if (!runner.lastSeenAt)
    return 'never-seen'

  if (runner.stopRequested)
    return 'stopping'

  return runner.holdsJob ? 'running' : 'idle'
}
