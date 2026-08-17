import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { auditEvent } from '../../Audit/events'
import { hashToken } from './authenticate'
import { runnerLifecycle } from './fleet'
import { auditFrom } from '../Git/audit'
import { currentActor } from '../Identity/lookup'

/**
 * The fleet: pools, queues, and which machines serve what.
 *
 * One endpoint with named operations rather than nine routes, because these are
 * administrative verbs an operator runs a handful of times and a program drives
 * from a script. The shape matches `instance/admin`, which is the same kind of
 * caller.
 *
 * **Draining is the operation this exists for.** Every other way to take
 * machines out of service loses something: deleting runners loses their
 * identity and their history, disabling them one at a time is a list somebody
 * has to keep, and turning them off leaves jobs waiting on a machine that is
 * never coming back. Pausing a queue says "no new work here", lets what is
 * running finish, and is undone by one call at four in the afternoon when the
 * maintenance turns out not to be needed.
 */
export default new Action({
  name: 'Fleet',
  description: 'Runner pools and queues: create, drain, and assign',
  method: 'POST',

  validations: {
    operation: {
      rule: schema.enum([
        'list',
        'create-pool',
        'create-queue',
        'pause-queue',
        'resume-queue',
        'assign-repository',
        'unassign-repository',
        'assign-runner',
        'stop-runner',
        'create-runner',
      ]),
    },
    name: { rule: schema.string() },
    slug: { rule: schema.string() },
    labels: { rule: schema.string() },
    reason: { rule: schema.string() },
    pool: { rule: schema.number() },
    queue: { rule: schema.number() },
    runner: { rule: schema.number() },
    repository: { rule: schema.number() },
    force: { rule: schema.boolean() },
  },

  responses: {
    200: { description: 'The fleet as it now stands.' },
    404: { description: 'Not an administrator. The endpoint does not admit it exists.' },
    422: { description: 'The operation needs something it was not given.' },
  },

  async handle(request: any) {
    const { user } = await currentActor(request)

    /*
     * 404 rather than 403, like the rest of the administrative surface: whether
     * this instance has a fleet at all is not something to confirm to a
     * stranger.
     */
    if (!user?.is_admin)
      return response.json({ error: 'No such endpoint' }, 404)

    const operation = String(request.get('operation') ?? 'list').trim()

    if (operation === 'list')
      return response.json(await fleet())

    if (operation === 'create-pool') {
      const name = String(request.get('name') ?? '').trim()

      if (!name)
        return response.json({ error: 'A pool needs a name' }, 422)

      const slug = (String(request.get('slug') ?? '').trim() || name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100)

      const created: any = await db
        .insertInto('runner_pools')
        .values({ name: name.slice(0, 100), slug, description: String(request.get('reason') ?? '').slice(0, 1000) || null } as any)
        .returning(['id'])
        .executeTakeFirst()

      await auditEvent('fleet:pool-created', await entry(request, user, { pool: Number(created?.id), name })).catch(() => null)

      return response.json({ pool: { id: Number(created?.id), name, slug } })
    }

    if (operation === 'create-queue') {
      const poolId = Number(request.get('pool'))
      const name = String(request.get('name') ?? '').trim()

      if (!Number.isInteger(poolId) || poolId <= 0 || !name)
        return response.json({ error: 'A queue needs a pool and a name' }, 422)

      const created: any = await db
        .insertInto('runner_queues')
        .values({ runner_pool_id: poolId, name: name.slice(0, 100), state: 'active' } as any)
        .returning(['id'])
        .executeTakeFirst()

      await auditEvent('fleet:queue-created', await entry(request, user, { queue: Number(created?.id), pool: poolId, name })).catch(() => null)

      return response.json({ queue: { id: Number(created?.id), name, state: 'active' } })
    }

    if (operation === 'pause-queue' || operation === 'resume-queue') {
      const queueId = Number(request.get('queue'))

      if (!Number.isInteger(queueId) || queueId <= 0)
        return response.json({ error: 'Which queue?' }, 422)

      const paused = operation === 'pause-queue'
      const reason = String(request.get('reason') ?? '').slice(0, 500)

      await db
        .updateTable('runner_queues')
        .set({
          state: paused ? 'paused' : 'active',
          // Kept only while paused: a reason left on a running queue is a note
          // about something that is no longer true.
          paused_reason: paused ? (reason || null) : null,
        } as any)
        .where('id', '=', queueId)
        .execute()

      const context = await entry(request, user, { queue: queueId, reason })

      if (paused)
        await auditEvent('fleet:queue-paused', context).catch(() => null)
      else
        await auditEvent('fleet:queue-resumed', context).catch(() => null)

      return response.json({ queue: { id: queueId, state: paused ? 'paused' : 'active', reason: reason || null } })
    }

    if (operation === 'assign-repository' || operation === 'unassign-repository') {
      const poolId = Number(request.get('pool'))
      const repositoryId = Number(request.get('repository'))

      if (!Number.isInteger(poolId) || !Number.isInteger(repositoryId) || poolId <= 0 || repositoryId <= 0)
        return response.json({ error: 'Which pool, and which repository?' }, 422)

      if (operation === 'unassign-repository') {
        await db
          .deleteFrom('runner_pool_repositories')
          .where('runner_pool_id', '=', poolId)
          .where('repository_id', '=', repositoryId)
          .execute()
      }
      else {
        const already: any = await db
          .selectFrom('runner_pool_repositories')
          .select(['id'])
          .where('runner_pool_id', '=', poolId)
          .where('repository_id', '=', repositoryId)
          .executeTakeFirst()

        if (!already) {
          await db
            .insertInto('runner_pool_repositories')
            .values({ runner_pool_id: poolId, repository_id: repositoryId } as any)
            .execute()
        }
      }

      /*
       * Worth an audit entry more than most of these. Adding the first
       * repository to a pool is the moment it stops serving everything, and
       * removing the last one is the moment it starts again - which is a
       * boundary changing, quietly, in the direction nobody expects.
       */
      const context = await entry(request, user, { pool: poolId, repository: repositoryId })

      if (operation === 'assign-repository')
        await auditEvent('fleet:repository-assigned', context).catch(() => null)
      else
        await auditEvent('fleet:repository-unassigned', context).catch(() => null)

      return response.json(await fleet())
    }

    if (operation === 'create-runner') {
      /*
       * Registering a machine over the API, which is what an autoscaler needs.
       *
       * `buddy runner:local --register` is an operator at a shell on the
       * instance's own host; a scaler is a program somewhere else that has to
       * make a credential seconds before a machine boots. Same row, same
       * hashing, different caller - and the credential is returned once here
       * for the same reason it is printed once there.
       */
      const name = String(request.get('name') ?? '').trim() || `runner-${Date.now()}`
      const queueId = Number(request.get('queue'))

      const { generateToken } = await import('../Tokens/secret')
      const secret = generateToken()

      const labels = String(request.get('labels') ?? 'ubuntu-latest,self-hosted')
        .split(',')
        .map(label => label.trim())
        .filter(Boolean)

      const created: any = await db
        .insertInto('runners')
        .values({
          name: name.slice(0, 200),
          /*
           * Instance-scoped, because a scaler making a machine for a queue is
           * making it for whatever that queue serves - and the pool is where
           * the boundary is drawn now. A repository-scoped runner is still
           * available and is what `--register --scope` is for.
           */
          scope_type: 'instance',
          scope_id: null,
          token_hash: hashToken(secret.token),
          labels: labels.join('\n'),
          state: 'active',
          version: '1',
          runner_queue_id: Number.isInteger(queueId) && queueId > 0 ? queueId : null,
        } as any)
        .returning(['id'])
        .executeTakeFirst()

      await auditEvent('fleet:runner-created', await entry(request, user, { runner: Number(created?.id), name, queue: queueId })).catch(() => null)

      return response.json({
        runner: {
          id: Number(created?.id),
          name,
          labels,
          // Shown once. The column holds a hash, and a credential in a
          // database in plain text is a credential in every backup.
          token: secret.token,
        },
      })
    }

    if (operation === 'stop-runner') {
      const runnerId = Number(request.get('runner'))

      if (!Number.isInteger(runnerId) || runnerId <= 0)
        return response.json({ error: 'Which runner?' }, 422)

      const forced = request.get('force') === true || String(request.get('force') ?? '') === 'true'

      await db
        .updateTable('runners')
        .set({ stop_requested: forced ? 'forced' : 'graceful' } as any)
        .where('id', '=', runnerId)
        .execute()

      let returned = 0

      if (forced) {
        /*
         * The job it is holding goes back to the queue, and is **not**
         * cancelled: the work is fine, it is the machine that is going away.
         * Same shape as a lapsed lease, including the attempt counter, so a
         * machine that is force-stopped repeatedly cannot hand one job round a
         * fleet forever.
         */
        const held: any[] = await db
          .selectFrom('workflow_jobs')
          .select(['id', 'attempt'])
          .where('runner_id', '=', String(runnerId))
          .where('state', '=', 'running')
          .execute()

        for (const job of held) {
          await db
            .updateTable('workflow_jobs')
            .set({
              state: 'queued',
              runner_id: null,
              lease_expires_at: null,
              job_token_hash: null,
              attempt: Number(job.attempt ?? 1) + 1,
              condition_reason: 'The machine running this was stopped, so the job went back to the queue.',
            } as any)
            .where('id', '=', Number(job.id))
            .where('state', '=', 'running')
            .execute()

          returned += 1
        }
      }

      await auditEvent('fleet:runner-stopped', await entry(request, user, { runner: runnerId, forced, returned })).catch(() => null)

      return response.json({
        runner: { id: runnerId, stop: forced ? 'forced' : 'graceful' },
        // How many jobs went back to the queue, so a script can tell whether it
        // just interrupted something.
        returned,
        /*
         * The machine is told the next time it polls, which is the only moment
         * this instance can tell it anything. Said in the answer so nobody
         * waits for a state change that arrives on the runner's schedule.
         */
        note: 'The runner is told when it next asks for work.',
      })
    }

    const runnerId = Number(request.get('runner'))
    const queueId = Number(request.get('queue'))

    if (!Number.isInteger(runnerId) || runnerId <= 0)
      return response.json({ error: 'Which runner?' }, 422)

    await db
      .updateTable('runners')
      // Zero means "no queue", which puts the machine back to being matched by
      // label and scope alone - the way every runner worked before pools.
      .set({ runner_queue_id: Number.isInteger(queueId) && queueId > 0 ? queueId : null } as any)
      .where('id', '=', runnerId)
      .execute()

    await auditEvent('fleet:runner-assigned', await entry(request, user, { runner: runnerId, queue: queueId })).catch(() => null)

    return response.json(await fleet())
  },
})

/** Every pool, its queues, its runners, and what it serves. */
async function fleet(): Promise<Record<string, unknown>> {
  const pools: any[] = await db.selectFrom('runner_pools').select(['id', 'name', 'slug', 'description']).execute()
  const queues: any[] = await db.selectFrom('runner_queues').select(['id', 'runner_pool_id', 'name', 'state', 'paused_reason']).execute()
  const assigned: any[] = await db.selectFrom('runner_pool_repositories').select(['runner_pool_id', 'repository_id']).execute()
  const runners: any[] = await db
    .selectFrom('runners')
    .select(['id', 'name', 'state', 'labels', 'runner_queue_id', 'last_seen_at', 'stop_requested'])
    .execute()

  /*
   * The jobs machines are holding, for the lifecycle below. One query for the
   * fleet rather than one per runner: a hundred-machine fleet asking the same
   * question a hundred times is how a status page becomes the slowest thing on
   * the instance.
   */
  const held: any[] = await db
    .selectFrom('workflow_jobs')
    .select(['runner_id', 'lease_expires_at'])
    .where('state', '=', 'running')
    .execute()

  const now = new Date()

  const describe = (runner: any): Record<string, unknown> => {
    const holding = held.find(job => String(job.runner_id ?? '') === String(runner.id))
    const lease = holding?.lease_expires_at ? Date.parse(String(holding.lease_expires_at)) : Number.NaN

    return {
      id: Number(runner.id),
      name: String(runner.name),
      state: String(runner.state),
      // What it is *doing*, which is the question a fleet screen is asked.
      lifecycle: runnerLifecycle({
        state: String(runner.state),
        lastSeenAt: runner.last_seen_at ? String(runner.last_seen_at) : null,
        stopRequested: runner.stop_requested ? String(runner.stop_requested) : null,
        holdsJob: Boolean(holding),
        leaseLapsed: Boolean(holding) && Number.isFinite(lease) && lease <= now.getTime(),
      }, now),
      last_seen_at: runner.last_seen_at ? String(runner.last_seen_at) : null,
    }
  }

  return {
    pools: pools.map(pool => ({
      id: Number(pool.id),
      name: String(pool.name),
      slug: String(pool.slug),
      description: pool.description ? String(pool.description) : null,
      /*
       * Said in words rather than left to be inferred from an empty array. "A
       * pool with no repositories serves all of them" is the rule people get
       * backwards, and a screen that shows `repositories: []` invites exactly
       * that mistake.
       */
      serves: assigned.some(entry => Number(entry.runner_pool_id) === Number(pool.id))
        ? 'the repositories listed'
        : 'every repository',
      repositories: assigned
        .filter(entry => Number(entry.runner_pool_id) === Number(pool.id))
        .map(entry => Number(entry.repository_id)),
      queues: queues
        .filter(queue => Number(queue.runner_pool_id) === Number(pool.id))
        .map(queue => ({
          id: Number(queue.id),
          name: String(queue.name),
          state: String(queue.state),
          reason: queue.paused_reason ? String(queue.paused_reason) : null,
          runners: runners
            .filter(runner => Number(runner.runner_queue_id ?? 0) === Number(queue.id))
            .map(describe),
        })),
    })),
    /*
     * The machines nobody has put in a queue, listed rather than hidden: on an
     * instance that has started using pools, a runner outside them is the one
     * that will surprise somebody.
     */
    unassigned: runners.filter(runner => !runner.runner_queue_id).map(describe),
  }
}

/**
 * The context every entry here shares.
 *
 * Split from the call rather than wrapping it, because the catalogue's rule is
 * that an event name appears literally at the place that emits it - an event
 * emitted only through a variable is one nobody can find by searching, which
 * is how a log grows entries nothing produces.
 */
async function entry(request: any, user: any, detail: Record<string, unknown>): Promise<any> {
  return {
    subject: { type: 'fleet', id: Number(detail.pool ?? detail.queue ?? detail.runner ?? 0) },
    actorId: user.id,
    ...await auditFrom(request),
    detail,
  }
}
