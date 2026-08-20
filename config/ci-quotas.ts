/**
 * **How much of the fleet one repository may hold at once**
 *
 * Concurrency groups already stop a workflow racing itself, and a queue already
 * decides which machines serve whom. Neither answers the question this file is
 * about: a monorepository whose push fans out into eighty jobs takes eighty
 * machines, and everybody else's one-job build waits behind all of them.
 *
 * That is not a bug in the queue - it is first-in, first-out working exactly as
 * written. It is also the thing that makes a shared instance feel broken to
 * everyone except the team that owns the busy repository.
 *
 * ## Ceilings, and then fairness
 *
 * The ceiling is the blunt half: past `CI_MAX_RUNNING_PER_REPOSITORY`, a
 * repository's next job waits even when machines are free. Off by default,
 * because on a single-team instance it is a limit that only ever gets in the
 * way, and the operator who needs it knows they need it.
 *
 * The fair half costs nothing and is always on: when two repositories both have
 * work queued, the one holding fewer machines is offered first. It changes
 * nothing when one repository is pushing - there is nobody to be fair to - and
 * it is the whole difference on the afternoon four teams push at once.
 *
 * ## Why not per token
 *
 * The roadmap asks for quotas per token too, and a token is not what occupies a
 * machine: a job is. A token that dispatches a hundred runs is bounded by the
 * repository those runs belong to, which is the limit that protects the fleet.
 * A separate per-token ceiling would be a second rule with the same purpose and
 * a different answer, and rate limiting already bounds the dispatching itself.
 */

export interface CiQuotasConfig {
  /** The most jobs one repository may have running at once. Zero for no limit. */
  maxRunningPerRepository: number
  /** The same for an owner, across every repository they have. Zero for no limit. */
  maxRunningPerOwner: number
  /** Whether a repository holding fewer machines is offered work first. */
  fairQueueing: boolean
}

/** A ceiling per repository, off unless an operator sets one. */
export function maxRunningPerRepository(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CI_MAX_RUNNING_PER_REPOSITORY ?? 0)

  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/**
 * And per owner, which is the one that matters on an instance hosting several
 * organizations: a ceiling per repository does nothing against an owner with
 * forty of them.
 */
export function maxRunningPerOwner(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CI_MAX_RUNNING_PER_OWNER ?? 0)

  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/**
 * Fairness, on unless somebody turns it off.
 *
 * On by default because it costs one ordering pass and only ever changes the
 * answer when two repositories are competing - and when they are, the
 * alternative is one of them waiting for the other to finish eighty jobs.
 * `CI_FAIR_QUEUEING=off` restores strict first-in, first-out for an instance
 * that would rather have it.
 */
export function fairQueueing(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.CI_FAIR_QUEUEING ?? '').trim().toLowerCase() !== 'off'
}

export default {
  maxRunningPerRepository: maxRunningPerRepository(),
  maxRunningPerOwner: maxRunningPerOwner(),
  fairQueueing: fairQueueing(),
} satisfies CiQuotasConfig
