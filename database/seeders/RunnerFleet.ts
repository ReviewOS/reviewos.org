import { db, Seeder } from '@stacksjs/database'

/**
 * A runner fleet, and the environments a workflow can deploy to.
 *
 * Two screens read these and both showed nothing. The run detail page answers
 * "what executed this job" by walking `workflow_jobs.runner_id` to `runners`,
 * then `runners.runner_queue_id` to `runner_queues`, then
 * `runner_queues.runner_pool_id` to `runner_pools` - and all three tables were
 * empty, so the block was skipped entirely and a run never said where it ran.
 * The workflows page lists `environments` by name, and that table was empty
 * too.
 *
 * `Pipelines` is what leaves `runner_id` null, so this also fills that in for
 * the jobs it created. A job that reports a runner nothing can resolve would be
 * worse than one that reports none: the page would join to nothing and show a
 * blank where a name belongs.
 *
 * ## Why a fleet rather than one runner
 *
 * The pool and the queue are not decoration. Phase 15's whole argument is that
 * the control plane is ours and the compute is yours, which means a job is
 * claimed by a runner in a queue belonging to a pool that serves some set of
 * repositories. One runner with no queue demonstrates none of that, and the
 * run page has three columns for exactly those three names. So there are two
 * pools with different shapes: a shared one with two queues, and a dedicated
 * one whose single queue is paused with a reason, because a paused queue is a
 * state somebody has to recognise on sight.
 */

/** The pools, and the queues in each. A paused queue carries its reason. */
const POOLS = [
  {
    name: 'Shared Linux',
    slug: 'shared-linux',
    description: 'General purpose x86_64 runners, claimed by any repository.',
    queues: [
      { name: 'default', state: 'active' as const, reason: null },
      { name: 'large', state: 'active' as const, reason: null },
    ],
  },
  {
    name: 'Release',
    slug: 'release',
    description: 'Signing and publishing, restricted to tagged runs.',
    queues: [
      { name: 'signing', state: 'paused' as const, reason: 'Waiting on the quarterly key rotation' },
    ],
  },
] as const

/** The runners, by the queue they belong to. */
const RUNNERS = [
  { name: 'shared-01', queue: 'default', state: 'active' as const, version: '0.8.2', labels: ['self-hosted', 'linux', 'x64'] },
  { name: 'shared-02', queue: 'default', state: 'active' as const, version: '0.8.2', labels: ['self-hosted', 'linux', 'x64'] },
  { name: 'shared-large-01', queue: 'large', state: 'active' as const, version: '0.8.2', labels: ['self-hosted', 'linux', 'x64', 'large'] },
  { name: 'release-signer', queue: 'signing', state: 'disabled' as const, version: '0.7.9', labels: ['self-hosted', 'linux', 'arm64', 'signing'] },
] as const

/**
 * The environments, which are a deployment target plus the rule that guards it.
 *
 * `production` waits and requires its checks, `staging` does neither. The pair
 * is the point: an environment with no gate and an environment with one render
 * differently, and a seeded instance where every environment is identical
 * shows neither.
 */
const ENVIRONMENTS = [
  { name: 'staging', waitMinutes: 0, requireChecks: false, branches: null, description: 'Deployed on every merge to the default branch.' },
  { name: 'production', waitMinutes: 10, requireChecks: true, branches: 'main', description: 'Deployed from the default branch, after a wait.' },
] as const

/** A stable millisecond offset, so timestamps read as a sequence. */
function minutesBefore(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

export default class RunnerFleet extends Seeder {
  /**
   * After `Pipelines` (14), whose jobs this attaches runners to, and after
   * `RepositoryMeasures` (15) only incidentally - there is no dependency
   * between them.
   */
  static order = 16
  static tags = ['checks', 'pipelines', 'runners']

  async run(): Promise<void> {
    const queues = await this.fleet()

    if (queues.size === 0)
      return

    const runners = await this.runners(queues)
    const attached = await this.attachToJobs(runners.ids)
    const environments = await this.environments()

    /*
     * Silent when nothing was written, like the other seeders here.
     *
     * This counted `runners.ids`, which includes the ones it found rather than
     * created, so a second seed announced four runners and zero of everything
     * else. A line on a run that changed nothing is the kind of noise that
     * teaches people to stop reading the seed output.
     */
    if (runners.created > 0 || attached > 0 || environments > 0)
      console.error(`[seed] ${runners.created} runner(s) across ${queues.size} queue(s), ${attached} job(s) attributed, ${environments} environment(s)`)
  }

  /**
   * The pools and their queues, looked up before they are inserted.
   *
   * `runner_pools.slug` is the stable name, so an existing pool is reused
   * rather than duplicated. Same rule as everywhere else in these seeders: a
   * partial run has to converge, not accumulate.
   */
  private async fleet(): Promise<Map<string, number>> {
    const queues = new Map<string, number>()

    for (const pool of POOLS) {
      const existing = await db
        .selectFrom('runner_pools')
        .select(['id'])
        .where('slug', '=', pool.slug)
        .executeTakeFirst()

      const poolId = existing?.id
        ? Number(existing.id)
        : Number((await db
            .insertInto('runner_pools')
            .values({
              name: pool.name,
              slug: pool.slug,
              description: pool.description,
              uuid: crypto.randomUUID(),
            })
            .returning(['id'])
            .executeTakeFirst())?.id ?? 0)

      if (!poolId)
        continue

      for (const queue of pool.queues) {
        const already = await db
          .selectFrom('runner_queues')
          .select(['id'])
          .where('runner_pool_id', '=', poolId)
          .where('name', '=', queue.name)
          .executeTakeFirst()

        const queueId = already?.id
          ? Number(already.id)
          : Number((await db
              .insertInto('runner_queues')
              .values({
                runner_pool_id: poolId,
                name: queue.name,
                state: queue.state,
                paused_reason: queue.reason,
                uuid: crypto.randomUUID(),
              })
              .returning(['id'])
              .executeTakeFirst())?.id ?? 0)

        if (queueId)
          queues.set(queue.name, queueId)
      }
    }

    return queues
  }

  /**
   * The runners themselves, one row per declared name.
   *
   * Returns both the ids and how many were new, because the caller needs the
   * ids to attribute jobs and the count to decide whether it did anything.
   */
  private async runners(queues: Map<string, number>): Promise<{ ids: number[], created: number }> {
    const ids: number[] = []
    let created = 0

    for (const [index, runner] of RUNNERS.entries()) {
      const queueId = queues.get(runner.queue)

      if (!queueId)
        continue

      const existing = await db
        .selectFrom('runners')
        .select(['id'])
        .where('name', '=', runner.name)
        .executeTakeFirst()

      if (existing?.id) {
        ids.push(Number(existing.id))
        continue
      }

      const row = await db
        .insertInto('runners')
        .values({
          name: runner.name,
          scope_type: 'instance',
          scope_id: null,
          /*
           * A hash, and not of anything. `token_hash` is `not null` and holds
           * the digest of a registration token; these runners have no token
           * because nothing is going to authenticate as them, and writing a
           * plausible-looking secret into seed data is how a fake credential
           * ends up being tried against something real.
           */
          token_hash: `seed:${runner.name}:not-a-token`,
          labels: runner.labels.join('\n'),
          state: runner.state,
          version: runner.version,
          last_seen_at: runner.state === 'active' ? minutesBefore(index + 1) : minutesBefore(60 * 24 * 3),
          runner_queue_id: queueId,
          uuid: crypto.randomUUID(),
        })
        .returning(['id'])
        .executeTakeFirst()

      if (row?.id) {
        ids.push(Number(row.id))
        created += 1
      }
    }

    return { ids, created }
  }

  /**
   * Say which runner took each job that ran.
   *
   * Only jobs that have **finished**, which is narrower than it first looks and
   * is the whole lesson of this seeder.
   *
   * The obvious rule is "any job that started", and it is wrong. A `running`
   * job carries a lease, and `app/Actions/Runner/claim.ts` has a recovery path
   * for a lease that has lapsed: `state = 'running'` and a matching stale
   * `runner_id` and `lease_expires_at`. A seeded running job has a `runner_id`
   * and a null lease, which reads as a lease that expired long ago, so the
   * claimer treats it as work to recover and hands it to whichever runner asks
   * next. Two suites that drive a fake runner claimed eleven seeded jobs that
   * way and failed on the extra work they drained.
   *
   * Giving them a live lease is not the fix either, because a lease that is
   * live now expires during a long test run and the problem comes back on a
   * timer. A finished job has nothing left to claim, so it is the only state
   * where an attributed runner is inert.
   *
   * The cost is that a running job shows no runner on the page even though
   * something is notionally executing it. That is the honest trade: seed data
   * must not look like live work.
   *
   * `runner_id` is a varchar on `workflow_jobs` rather than a foreign key, and
   * the run page parses it back with `Number(...)`, so it holds the id as text.
   */
  private async attachToJobs(runners: readonly number[]): Promise<number> {
    if (runners.length === 0)
      return 0

    const jobs = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'state', 'runner_id'])
      .orderBy('id')
      .execute()

    let attached = 0

    for (const [index, job] of jobs.entries()) {
      if (String(job.runner_id ?? '') !== '')
        continue

      // Terminal states only. See the note above: anything still in flight is
      // claimable, and a seeded row that a runner can claim is a trap.
      if (!['succeeded', 'failed', 'cancelled', 'skipped'].includes(String(job.state)))
        continue

      await db
        .updateTable('workflow_jobs')
        .set({ runner_id: String(runners[index % runners.length]) })
        .where('id', '=', job.id)
        .execute()

      attached += 1
    }

    return attached
  }

  /** Two environments per repository that has a workflow. */
  private async environments(): Promise<number> {
    const repositories = await db
      .selectFrom('workflows')
      .select(['repository_id'])
      .execute()

    const ids = [...new Set(repositories.map(row => Number(row.repository_id)).filter(Boolean))]
    let written = 0

    for (const repositoryId of ids) {
      for (const environment of ENVIRONMENTS) {
        const existing = await db
          .selectFrom('environments')
          .select(['id'])
          .where('repository_id', '=', repositoryId)
          .where('name', '=', environment.name)
          .executeTakeFirst()

        if (existing)
          continue

        await db
          .insertInto('environments')
          .values({
            repository_id: repositoryId,
            name: environment.name,
            wait_minutes: environment.waitMinutes,
            require_checks: environment.requireChecks,
            branches: environment.branches,
            description: environment.description,
            uuid: crypto.randomUUID(),
          })
          .execute()

        written += 1
      }
    }

    return written
  }
}
