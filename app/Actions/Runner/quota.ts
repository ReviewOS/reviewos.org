/**
 * Stopping one repository from holding the whole fleet.
 *
 * The queue is first-in, first-out and that is right, until a monorepository's
 * push fans out into eighty jobs: everybody else's one-job build then waits
 * behind all eighty, and the instance feels broken to everyone except the team
 * that owns the busy repository.
 *
 * Two halves, and they are different in kind.
 *
 * **The ceiling** refuses: past the configured number a repository's next job
 * is skipped even with machines idle. Off by default, because on a single-team
 * instance it is a limit that only ever gets in the way.
 *
 * **The fairness** reorders: when several repositories have work queued, the one
 * holding fewer machines is offered first. It costs one pass over the
 * candidates, changes nothing when only one repository is pushing, and is the
 * whole difference when four teams push at once.
 *
 * Both are read at the claim rather than at dispatch, because "how many are
 * running" is only true at the moment a machine asks - and a decision taken at
 * dispatch would be a decision about a fleet that has since changed.
 */

import { db } from '@stacksjs/database'
import { maxRunningPerOwner, maxRunningPerRepository } from '../../../config/ci-quotas'

/** How many jobs each repository and owner is holding right now. */
export interface FleetLoad {
  byRepository: Map<number, number>
  byOwner: Map<number, number>
}

/**
 * What the fleet is holding, in one query.
 *
 * Read once per claim rather than once per candidate: a poll examines up to
 * fifty rows, and asking the database per row would turn one query into fifty
 * on the hottest path this instance has.
 */
export async function fleetLoad(): Promise<FleetLoad> {
  const rows = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .innerJoin('repositories', 'repositories.id', '=', 'workflow_runs.repository_id')
    .select([
      'workflow_runs.repository_id as repository_id',
      'repositories.owner_id as owner_id',
    ])
    .where('workflow_jobs.state', '=', 'running')
    .limit(5000)
    .execute()
    .catch(() => [])

  const byRepository = new Map<number, number>()
  const byOwner = new Map<number, number>()

  for (const row of rows as any[]) {
    const repository = Number(row.repository_id)
    const owner = Number(row.owner_id)

    byRepository.set(repository, (byRepository.get(repository) ?? 0) + 1)
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1)
  }

  return { byRepository, byOwner }
}

/**
 * Whether this job may start, given what its repository already holds.
 *
 * A refusal here is a *skip*, not a failure: the job stays queued and the next
 * poll asks again. Nothing about being over a ceiling says the work is wrong,
 * only that it is not this machine's turn.
 */
export function withinQuota(load: FleetLoad, job: { repositoryId: number, ownerId: number }): boolean {
  const perRepository = maxRunningPerRepository()
  const perOwner = maxRunningPerOwner()

  if (perRepository > 0 && (load.byRepository.get(job.repositoryId) ?? 0) >= perRepository)
    return false

  /*
   * The owner ceiling is the one that matters on an instance hosting several
   * organizations: a per-repository limit does nothing against an owner with
   * forty repositories, which is the shape a monorepository split becomes.
   */
  if (perOwner > 0 && (load.byOwner.get(job.ownerId) ?? 0) >= perOwner)
    return false

  return true
}

/**
 * Reorder candidates so a repository holding fewer machines goes first.
 *
 * **Stable within a repository**, which is the part that makes this safe: the
 * candidates arrive in priority order with age breaking the tie, and this only
 * moves whole repositories relative to each other. A repository's own jobs keep
 * the order the queue gave them, so a deploy still beats a test in its own
 * repository - fairness between teams is not a licence to reorder inside one.
 */
export function fairOrder<T extends { repository_id?: unknown }>(rows: readonly T[], load: FleetLoad): T[] {
  return [...rows]
    .map((row, index) => ({ row, index, held: load.byRepository.get(Number((row as any).repository_id)) ?? 0 }))
    .sort((left, right) => (left.held - right.held) || (left.index - right.index))
    .map(one => one.row)
}
