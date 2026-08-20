/**
 * Stopping one repository's bad afternoon from spending the whole model budget.
 *
 * This is [`Runner/quota.ts`](../Runner/quota.ts) for repair, and it is
 * deliberately the same shape: a load read in one query, a pure predicate over
 * it, ceilings per repository and per owner. Somebody who has read one should
 * recognise the other, because they answer the same question about two
 * different resources.
 *
 * ## The resource is not a machine
 *
 * Which is where the two part company. A workflow job holds a runner - this
 * instance's own hardware, where a ceiling that idles a machine wastes capacity
 * somebody already paid for. That is why the fleet ceiling is off by default.
 *
 * A repair holds a call to somebody else's API. Past its rate limit, the calls
 * do not queue politely: they are refused, and they are refused for *everybody*,
 * including the repairs that mattered. And each one costs money. So there is a
 * third ceiling here that the fleet has no use for - an instance-wide one - and
 * all three are on by default. The failure mode being prevented is a
 * monorepository whose push fans out into eighty failing jobs and eighty
 * simultaneous model calls.
 *
 * ## Waiting, not refusing
 *
 * Being over a ceiling is not a verdict about the work. `Runner/quota.ts` says
 * it plainly - "a refusal here is a skip, not a failure" - and a repair does the
 * same thing by a different route: it puts itself back on the queue and asks
 * again. Only when it has asked for longer than an operator would want to wait
 * does it hand the attempt back, and it hands it back as a *refusal* rather than
 * a failure, so the run's budget is not charged for a repair that never ran.
 *
 * ## Approximate at the edges, and honestly so
 *
 * Two repairs starting in the same instant can both read a load with room in it
 * and both start, putting the count one over. That is the same race
 * `Runner/quota.ts` accepts for the same reason: the alternative is a lock on
 * the hottest path, and the ceiling's job is to bound the steady state rather
 * than to guarantee an instantaneous maximum. It is worth saying out loud rather
 * than implying a precision that is not there.
 */

import { db } from '@stacksjs/database'
import { rowsChanged } from '../Support/sql'
import {
  repairMaxRunning,
  repairMaxRunningPerOwner,
  repairMaxRunningPerRepository,
  repairStaleMinutes,
} from '../../../config/ci-repair'

/** How many repairs each repository and owner is running right now. */
export interface RepairLoad {
  byRepository: Map<number, number>
  byOwner: Map<number, number>
  total: number
}

/** Nothing running, which is the answer on an instance that has never repaired. */
export function emptyRepairLoad(): RepairLoad {
  return { byRepository: new Map(), byOwner: new Map(), total: 0 }
}

/**
 * What is running, in one query.
 *
 * `started_at` is the whole trick. An attempt row exists from the moment the
 * policy allowed it, which is *before* it has capacity to run - so counting
 * every `attempted` row would count the repairs that are waiting for a slot
 * against the ceiling that is keeping them waiting, and past the limit nothing
 * would ever start again.
 *
 * The horizon is the other half. A repair whose process died leaves a row that
 * still claims to be running, and without a cutoff that row holds a slot for
 * ever - one crash at a time, until repair quietly stops happening and nothing
 * says why.
 */
export async function repairLoad(now: Date = new Date()): Promise<RepairLoad> {
  const since = new Date(now.getTime() - repairStaleMinutes() * 60_000).toISOString()

  const rows = await db
    .selectFrom('repair_attempts')
    .innerJoin('repositories', 'repositories.id', '=', 'repair_attempts.repository_id')
    .select([
      'repair_attempts.repository_id as repository_id',
      'repositories.owner_id as owner_id',
    ])
    .where('repair_attempts.state', '=', 'attempted')
    .where('repair_attempts.started_at', 'is not', null)
    .where('repair_attempts.started_at', '>=', since)
    .limit(5000)
    .execute()
    .catch(() => [])

  const load = emptyRepairLoad()

  for (const row of rows as any[]) {
    const repository = Number(row.repository_id)
    const owner = Number(row.owner_id)

    load.byRepository.set(repository, (load.byRepository.get(repository) ?? 0) + 1)
    load.byOwner.set(owner, (load.byOwner.get(owner) ?? 0) + 1)
    load.total += 1
  }

  return load
}

/**
 * Whether this repair may start, given what is already running.
 *
 * Pure, so the interesting part - which ceiling binds, and in what order - is
 * settled by reading a test. The instance ceiling is checked first because it is
 * the one protecting a resource this instance does not own.
 */
export function withinRepairQuota(load: RepairLoad, repair: { repositoryId: number, ownerId: number }): boolean {
  const instance = repairMaxRunning()
  const perRepository = repairMaxRunningPerRepository()
  const perOwner = repairMaxRunningPerOwner()

  if (instance > 0 && load.total >= instance)
    return false

  if (perRepository > 0 && (load.byRepository.get(repair.repositoryId) ?? 0) >= perRepository)
    return false

  /*
   * The owner ceiling is the one that matters on an instance hosting several
   * organizations: a per-repository limit does nothing against an owner with
   * forty repositories, which is the shape a monorepository split becomes.
   */
  if (perOwner > 0 && (load.byOwner.get(repair.ownerId) ?? 0) >= perOwner)
    return false

  return true
}

/**
 * Take a slot, by stamping the attempt as started.
 *
 * Written before the credential is minted and before anything is spent, so the
 * row that says "this one is running" exists for the whole time it is true.
 *
 * Guarded on the row still being unstarted and still `attempted`, which makes a
 * repair that somehow ran twice take one slot rather than two - and, more
 * usefully, makes this return false for an attempt something else has already
 * finished, which is the shape a duplicate queue delivery takes.
 */
export async function startAttempt(attemptId: number, now: Date = new Date()): Promise<boolean> {
  const changed: any = await db
    .updateTable('repair_attempts')
    .set({ started_at: now.toISOString() })
    .where('id', '=', attemptId)
    .where('state', '=', 'attempted')
    .whereNull('started_at')
    .executeTakeFirst()
    .catch(() => null)

  return changed ? rowsChanged(changed) : false
}

/** The owner of a repository, for the ceiling that spans them. */
export async function ownerOf(repositoryId: number): Promise<number> {
  const row: any = await db
    .selectFrom('repositories')
    .select(['owner_id'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()
    .catch(() => null)

  return Number(row?.owner_id ?? 0)
}
