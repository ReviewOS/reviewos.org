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
        'create-token',
        'revoke-token',
        'add-maintainer',
        'remove-maintainer',
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
    token: { rule: schema.number() },
    expires: { rule: schema.string() },
    user: { rule: schema.number() },
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
     *
     * A **pool maintainer** gets past this for their own pools. The role exists
     * because the alternative is what every self-hosted forge ends up with: the
     * person who looks after the build machines is made an instance
     * administrator - because draining a queue needs it - and now they can read
     * every private repository on the instance.
     */
    const maintains = user?.id ? await poolsMaintainedBy(Number(user.id)) : []

    if (!user?.is_admin && maintains.length === 0)
      return response.json({ error: 'No such endpoint' }, 404)

    const operation = String(request.get('operation') ?? 'list').trim()

    /*
     * Which pool this operation is about, resolved before it runs so one check
     * covers every verb. A maintainer acting on a pool they do not maintain is
     * refused with the same 404 as a stranger: the existence of somebody else's
     * pool is not theirs to learn.
     */
    if (!user?.is_admin) {
      const subject = await poolOf(request, operation)

      if (subject === null || (subject !== -1 && !maintains.includes(subject)))
        return response.json({ error: 'No such endpoint' }, 404)

      /*
       * Two verbs stay administrator-only. Creating a pool is creating a
       * boundary, and appointing maintainers is handing out the power to
       * manage one - a role that can appoint itself sideways into another pool
       * is not a narrower role at all.
       */
      if (['create-pool', 'add-maintainer', 'remove-maintainer'].includes(operation))
        return response.json({ error: 'No such endpoint' }, 404)
    }

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

    if (operation === 'add-maintainer' || operation === 'remove-maintainer') {
      const poolId = Number(request.get('pool'))
      const userId = Number(request.get('user'))

      if (!Number.isInteger(poolId) || !Number.isInteger(userId) || poolId <= 0 || userId <= 0)
        return response.json({ error: 'Which pool, and which person?' }, 422)

      if (operation === 'remove-maintainer') {
        await db
          .deleteFrom('runner_pool_maintainers')
          .where('runner_pool_id', '=', poolId)
          .where('user_id', '=', userId)
          .execute()
      }
      else {
        const already: any = await db
          .selectFrom('runner_pool_maintainers')
          .select(['id'])
          .where('runner_pool_id', '=', poolId)
          .where('user_id', '=', userId)
          .executeTakeFirst()

        if (!already)
          await db.insertInto('runner_pool_maintainers').values({ runner_pool_id: poolId, user_id: userId } as any).execute()
      }

      const context = await entry(request, user, { pool: poolId, user: userId })

      if (operation === 'add-maintainer')
        await auditEvent('fleet:maintainer-added', context).catch(() => null)
      else
        await auditEvent('fleet:maintainer-removed', context).catch(() => null)

      return response.json(await fleet())
    }

    if (operation === 'create-token') {
      /*
       * A credential a machine registers *itself* with, scoped to one pool.
       *
       * The credential an autoscaler's cloud-init should carry. Without it a
       * scaler needs an administrator's token to create runners, which puts
       * the widest credential on the instance into a userdata blob on every
       * machine it starts.
       */
      const poolId = Number(request.get('pool'))

      if (!Number.isInteger(poolId) || poolId <= 0)
        return response.json({ error: 'Which pool?' }, 422)

      const queueId = Number(request.get('queue'))
      const { generateToken } = await import('../Tokens/secret')
      const secret = generateToken()

      const created: any = await db
        .insertInto('runner_registration_tokens')
        .values({
          runner_pool_id: poolId,
          runner_queue_id: Number.isInteger(queueId) && queueId > 0 ? queueId : null,
          name: String(request.get('name') ?? 'registration').slice(0, 200),
          token_hash: hashToken(secret.token),
          expires_at: String(request.get('expires') ?? '').trim() || null,
          created_by_id: user?.id ?? null,
        } as any)
        .returning(['id'])
        .executeTakeFirst()

      await auditEvent('fleet:token-created', await entry(request, user, { pool: poolId, token: Number(created?.id) })).catch(() => null)

      return response.json({
        registration_token: {
          id: Number(created?.id),
          pool: poolId,
          // Shown once; the column holds a hash.
          token: secret.token,
        },
      })
    }

    if (operation === 'revoke-token') {
      const tokenId = Number(request.get('token'))

      if (!Number.isInteger(tokenId) || tokenId <= 0)
        return response.json({ error: 'Which token?' }, 422)

      await db
        .updateTable('runner_registration_tokens')
        /*
         * Revoked rather than deleted. "Which token did that machine register
         * with" outlives the token, and a row that is gone answers that
         * question with silence - at exactly the moment somebody is asking it
         * because a machine did something surprising.
         */
        .set({ revoked_at: new Date().toISOString() } as any)
        .where('id', '=', tokenId)
        .execute()

      await auditEvent('fleet:token-revoked', await entry(request, user, { token: tokenId })).catch(() => null)

      return response.json({ registration_token: { id: tokenId, revoked: true } })
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
              // Back in the queue means back to waiting, and the wait this job
              // is about to do is the one an operator needs measured.
              queued_at: new Date().toISOString(),
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
    .select(['id', 'name', 'state', 'labels', 'tags', 'runner_queue_id', 'last_seen_at', 'stop_requested'])
    .execute()

  const tokens: any[] = await db
    .selectFrom('runner_registration_tokens')
    .select(['id', 'runner_pool_id', 'name', 'first_used_at', 'last_used_at', 'uses', 'revoked_at', 'expires_at'])
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
      // What the machine says it is, which is what an `agents:` query selects on.
      tags: String(runner.tags ?? '').split('\n').map(tag => tag.trim()).filter(Boolean),
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
      /*
       * The tokens, with first and last use. Those two answer the questions
       * asked about a credential nobody remembers making: has this ever been
       * used, and is it still being used - and a token with a null first use
       * is one to delete without asking anybody.
       */
      registration_tokens: tokens
        .filter(token => Number(token.runner_pool_id) === Number(pool.id))
        .map(token => ({
          id: Number(token.id),
          name: String(token.name),
          uses: Number(token.uses ?? 0),
          first_used_at: token.first_used_at ? String(token.first_used_at) : null,
          last_used_at: token.last_used_at ? String(token.last_used_at) : null,
          revoked: Boolean(token.revoked_at),
          expires_at: token.expires_at ? String(token.expires_at) : null,
        })),
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

/** The pools this person may manage. */
async function poolsMaintainedBy(userId: number): Promise<number[]> {
  const rows: any[] = await db
    .selectFrom('runner_pool_maintainers')
    .select(['runner_pool_id'])
    .where('user_id', '=', userId)
    .execute()

  return rows.map(row => Number(row.runner_pool_id))
}

/**
 * Which pool an operation is about.
 *
 * Every verb names its subject differently - a pool, a queue, a runner, a
 * token - and a maintainer check that only understood one of them would leave
 * the others open. Null means "cannot tell", which is refused: a permission
 * check that fails open is not one.
 */
async function poolOf(request: any, operation: string): Promise<number | null> {
  const direct = Number(request.get('pool'))

  if (Number.isInteger(direct) && direct > 0)
    return direct

  const queueId = Number(request.get('queue'))

  if (Number.isInteger(queueId) && queueId > 0) {
    const queue: any = await db.selectFrom('runner_queues').select(['runner_pool_id']).where('id', '=', queueId).executeTakeFirst()

    return queue ? Number(queue.runner_pool_id) : null
  }

  const tokenId = Number(request.get('token'))

  if (Number.isInteger(tokenId) && tokenId > 0) {
    const token: any = await db.selectFrom('runner_registration_tokens').select(['runner_pool_id']).where('id', '=', tokenId).executeTakeFirst()

    return token ? Number(token.runner_pool_id) : null
  }

  const runnerId = Number(request.get('runner'))

  if (Number.isInteger(runnerId) && runnerId > 0) {
    const runner: any = await db
      .selectFrom('runners')
      .innerJoin('runner_queues', 'runner_queues.id', '=', 'runners.runner_queue_id')
      .select(['runner_queues.runner_pool_id as pool_id'])
      .where('runners.id', '=', runnerId)
      .executeTakeFirst()

    return runner ? Number(runner.pool_id) : null
  }

  // `list` is the only verb with no subject, and a maintainer may see the
  // fleet - the listing is filtered by nothing today, which is a gap worth
  // naming rather than hiding: it shows pool names and machine states, not
  // repository contents.
  return operation === 'list' ? -1 : null
}
