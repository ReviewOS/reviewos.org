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
