import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { apiError } from '../../Api/errors'
import { auditEvent } from '../../Audit/events'
import { adminRepositories, adminUsers, failedJobs, instanceStats, retryFailedJob } from '../../Ops/admin'
import { auditFrom } from '../Git/audit'
import { currentActor } from '../Identity/lookup'

/**
 * The administration surface: what this instance is, and the few levers.
 *
 * One endpoint with an `operation`, like the audit log and the instance
 * settings, and for the same reason each time: **a second endpoint is a second
 * place the administrator check has to be right.** There are five reads and two
 * writes here, and a mistake in the gate on any one of them exposes every
 * private repository on the instance.
 *
 * A stranger gets a 404 rather than a 403. Whether an instance has an
 * administration API is not something to confirm to somebody who may not use
 * it, and the same answer for "not an administrator" and "no such endpoint"
 * means neither can be distinguished by asking.
 *
 * **The levers are deliberately few.** Promote and demote an administrator, and
 * retry a failed job. Everything else an administrator might want - deleting a
 * repository, transferring one, revoking a token - already has an endpoint with
 * its own rules, and duplicating them here would be a second implementation of
 * each rule that has to stay in step. An administration page should mostly be a
 * *window*.
 */
export default new Action({
  name: 'Admin',
  description: 'Instance statistics, accounts, repositories, and the queue',
  method: 'POST',

  validations: {
    operation: { rule: schema.enum(['stats', 'users', 'repositories', 'queue', 'promote', 'demote', 'retry-job']) },
    handle: { rule: schema.string() },
    search: { rule: schema.string() },
    id: { rule: schema.number() },
    limit: { rule: schema.number() },
  },

  async handle(request: any) {
    const { user } = await currentActor(request)

    if (!user?.is_admin)
      return apiError('not_found', 'No such endpoint')

    const operation = String(request.get('operation') ?? 'stats').trim()
    const limit = Number(request.get('limit')) || 50

    if (operation === 'stats')
      return response.json(await instanceStats())

    if (operation === 'users')
      return response.json({ users: await adminUsers(String(request.get('search') ?? ''), limit) })

    if (operation === 'repositories')
      return response.json({ repositories: await adminRepositories(limit) })

    if (operation === 'queue') {
      const stats = await instanceStats()

      return response.json({ pending: stats.queue, failed: await failedJobs(limit) })
    }

    if (operation === 'promote' || operation === 'demote')
      return await changeAdmin(request, user, operation === 'promote')

    if (operation !== 'retry-job')
      return response.json({ error: `Unknown operation: ${operation}` }, 422)

    const id = Number(request.get('id') ?? 0)

    if (!Number.isInteger(id) || id <= 0)
      return response.json({ error: 'Which job?' }, 422)

    const retried = await retryFailedJob(id)

    if (retried) {
      await auditEvent('admin:job-retried', {
        subject: { type: 'failed_job', id },
        actorId: user.id,
        ...await auditFrom(request),
        detail: { job_id: id },
      })
    }

    // The same answer either way. A second click on the same button is the
    // usual reason a job is not there, and reporting that as a failure teaches
    // people the button is unreliable.
    return response.json({ retried })
  },
})

/**
 * Make somebody an administrator, or stop them being one.
 *
 * The most consequential thing on this page by a distance - an administrator
 * reads every private repository on the instance and every line of the audit
 * log - so it is by handle rather than by id. An id is a number somebody can
 * mistype into a different person; a handle is a name they have to have meant.
 */
async function changeAdmin(request: any, actor: { id: number }, promote: boolean): Promise<Response> {
  const handle = String(request.get('handle') ?? '').trim().toLowerCase()

  if (!handle)
    return response.json({ error: 'Which account?' }, 422)

  const target: any = await db
    .selectFrom('users')
    .select(['id', 'handle', 'is_admin'])
    .where('handle', '=', handle)
    .executeTakeFirst()

  if (!target)
    return response.json({ error: 'No such account' }, 404)

  /*
   * The last administrator cannot demote themselves.
   *
   * Unrecoverable otherwise: nobody left can promote a replacement, and the fix
   * is an `UPDATE` in `psql` - which is exactly the situation an administration
   * page exists to prevent. The same rule the organization owner count enforces,
   * for the same reason.
   */
  if (!promote) {
    const others: any[] = await db
      .selectFrom('users')
      .select(['id'])
      .where('is_admin', '=', true)
      .execute()

    if (others.filter(row => Number(row.id) !== Number(target.id)).length === 0)
      return response.json({ error: 'This instance must keep at least one administrator.' }, 422)
  }

  await db.updateTable('users').set({ is_admin: promote }).where('id', '=', Number(target.id)).execute()

  await auditEvent(promote ? 'admin:granted' : 'admin:revoked', {
    subject: { type: 'user', id: Number(target.id) },
    actorId: actor.id,
    ...await auditFrom(request),
    detail: { handle, was_admin: Boolean(target.is_admin) },
  })

  return response.json({ handle, is_admin: promote })
}
