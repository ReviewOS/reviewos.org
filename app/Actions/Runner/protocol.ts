/**
 * Who may take a job, and whose word about it counts.
 *
 * The decisions of the runner protocol, separated from the database so they can
 * be tested against the cases that matter - a duplicate claim, a late
 * completion, a credential used against the wrong job - none of which are
 * convenient to produce with a real runner, and all of which will happen.
 *
 * Every rule here starts from one assumption, which is [the threat
 * model's](../../../docs/ci-threat-model.md): **a runner is somebody else's
 * machine executing hostile code, and everything it says is untrusted input.**
 * It can lie about a result, replay an old credential, or come back from a
 * network partition believing it still holds work it lost ten minutes ago. None
 * of those may be able to change a run's answer.
 */

export interface RunnerFacts {
  id: number
  state: string
  scopeType: string
  /** Null when the scope is the whole instance. */
  scopeId: number | null
  /** What it says it can run, already split. */
  labels: readonly string[]
}

export interface JobFacts {
  id: number
  state: string
  /** `runs-on`, already split. */
  runsOn: readonly string[]
  /** Which repository's code this job would be handed. */
  repositoryId: number
  /** The repository's owner, for an organization-scoped runner. */
  ownerId: number
  /** Who holds it now, and until when. */
  runnerId: number | null
  leaseExpiresAt: string | null
}

/** One pattern per line, blank lines dropped. */
export function splitLabels(stored: string | null | undefined): string[] {
  return String(stored ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Whether a runner is allowed to see this repository's work at all.
 *
 * Checked before labels, because it is the one that matters: a runner
 * registered for one repository being handed another's source is not a
 * scheduling mistake, it is the instance giving somebody else's private code to
 * a machine its owner chose.
 */
export function runnerReaches(runner: RunnerFacts, job: JobFacts): boolean {
  switch (runner.scopeType) {
    case 'instance':
      return true
    case 'organization':
      return runner.scopeId !== null && runner.scopeId === job.ownerId
    case 'repository':
      return runner.scopeId !== null && runner.scopeId === job.repositoryId
    default:
      // An unknown scope reaches nothing. A scope this code does not
      // understand must not default to "everything" - that is the direction
      // that leaks, and a new scope added later would silently do it.
      return false
  }
}

/**
 * Whether a runner has what a job asks for.
 *
 * Every label, not any: `runs-on: [self-hosted, macos]` means both, and a
 * runner that has one of them is the wrong machine. Matching on "any" is how a
 * macOS build lands on a Linux box and fails with a confusing error rather than
 * waiting for the machine that could have run it.
 *
 * A job that asks for nothing runs anywhere, which is what an empty `runs-on`
 * means to somebody who wrote it.
 */
export function runnerSatisfies(runner: RunnerFacts, job: JobFacts): boolean {
  if (job.runsOn.length === 0)
    return true

  const has = new Set(runner.labels.map(label => label.toLowerCase()))

  return job.runsOn.every(label => has.has(label.toLowerCase()))
}

export interface ClaimDecision {
  ok: boolean
  /** Why not, in words a runner's log can carry and a person can read. */
  reason: string
}

/**
 * May this runner take this job, right now?
 *
 * `now` is passed rather than read, because a lease decision that depends on a
 * hidden clock cannot be tested at the boundary - and the boundary is the whole
 * question.
 */
export function mayClaim(runner: RunnerFacts, job: JobFacts, now: Date): ClaimDecision {
  if (runner.state !== 'active')
    return { ok: false, reason: 'this runner is disabled' }

  if (!runnerReaches(runner, job))
    return { ok: false, reason: 'this runner is not registered for that repository' }

  if (job.state === 'queued' && job.runnerId === null)
    return runnerSatisfies(runner, job)
      ? { ok: true, reason: 'queued and unheld' }
      : { ok: false, reason: `this runner does not have ${job.runsOn.join(', ')}` }

  /*
   * Held by somebody. The only way it becomes claimable again is the lease
   * lapsing - which is what makes a runner that died recoverable without a
   * person noticing, and what stops a duplicate claim while one is alive.
   */
  if (job.state === 'running' || job.runnerId !== null) {
    if (leaseIsLive(job, now))
      return { ok: false, reason: 'another runner holds this job' }

    return runnerSatisfies(runner, job)
      ? { ok: true, reason: 'the previous lease expired' }
      : { ok: false, reason: `this runner does not have ${job.runsOn.join(', ')}` }
  }

  return { ok: false, reason: `a job that is ${job.state} is not available` }
}

/** Whether the lease on a job has not yet lapsed. */
export function leaseIsLive(job: JobFacts, now: Date): boolean {
  if (!job.leaseExpiresAt)
    return false

  const expires = Date.parse(job.leaseExpiresAt)
  if (!Number.isFinite(expires))
    return false

  return expires > now.getTime()
}

export interface ReportDecision {
  ok: boolean
  reason: string
  /**
   * True when the report is a repeat of one already applied.
   *
   * Delivery is at-least-once, so a runner that did not hear the answer will
   * say it again. The second one is not an error and must not be treated as
   * one - it is answered as though it worked, because from the runner's side it
   * did.
   */
  duplicate: boolean
}

/**
 * Does this runner's word about this job count?
 *
 * The rule the whole protocol rests on: **only the lease holder, and only
 * before the lease lapses.** A worker that lost its connection and came back is
 * indistinguishable from one that never left, except by the lease - and without
 * this it can publish a success over a job that was cancelled and handed to
 * somebody else, which is a green check for work nobody did.
 */
export function mayReport(
  runner: RunnerFacts,
  job: JobFacts,
  now: Date,
  terminalStates: readonly string[] = ['cancelled', 'failed', 'skipped', 'succeeded'],
): ReportDecision {
  if (job.runnerId === null)
    return { ok: false, reason: 'this job is not held by anybody', duplicate: false }

  if (job.runnerId !== runner.id) {
    // The credential-against-the-wrong-job case. Not "not found", because the
    // runner is real: it is holding something, just not this.
    return { ok: false, reason: 'this job is held by another runner', duplicate: false }
  }

  if (terminalStates.includes(job.state)) {
    // Already finished, by this runner. At-least-once delivery means it will
    // be said twice, and the second time is a repeat rather than a conflict.
    return { ok: true, reason: 'already recorded', duplicate: true }
  }

  if (!leaseIsLive(job, now))
    return { ok: false, reason: 'this lease has expired', duplicate: false }

  return { ok: true, reason: 'the lease holder, in time', duplicate: false }
}

/** How long a lease lasts before a runner has to say it is still alive. */
export const LEASE_SECONDS = 60

/**
 * When a lease taken or renewed now would lapse.
 *
 * Short, and renewed by heartbeat rather than long. A long lease means a job
 * held by a machine that died is stuck for as long as the lease - and the whole
 * reason for the recovery sweep is that the machine cannot be asked.
 */
export function leaseUntil(now: Date, seconds = LEASE_SECONDS): string {
  return new Date(now.getTime() + seconds * 1000).toISOString()
}
