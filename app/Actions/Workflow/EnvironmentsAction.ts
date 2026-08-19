import type { RowOf } from '@stacksjs/database'
import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'

/**
 * The environments a repository deploys to, and who may open their gates.
 *
 * Separate from the workflow file on purpose, and it is the whole point of the
 * feature: a rule a workflow author can edit is a rule they can remove on the
 * afternoon they are in a hurry. `environment: production` says *where* a job
 * deploys; this says what that costs.
 *
 * Writing one takes `repository:settings` rather than `check:report` or plain
 * write access. Everybody who can push can name an environment in a workflow; only
 * somebody who administers the repository can decide a deploy to it needs two
 * people and a ten-minute pause.
 */
export default new Action({
  name: 'Environments',
  description: 'Create, list, and configure deployment environments and their reviewers',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.enum(['list', 'create', 'update', 'delete', 'add-reviewer', 'remove-reviewer']) },
    name: { rule: schema.string() },
    wait_minutes: { rule: schema.number() },
    branches: { rule: schema.string() },
    description: { rule: schema.string() },
    reviewer: { rule: schema.string() },
  },

  responses: {
    200: { description: 'The environments, or the one that changed.' },
    ...REPOSITORY_ERRORS,
    404: { description: 'No such environment here, or no such person.' },
    422: { description: 'A name is required, and a wait timer is minutes.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const operation = String(request.get('operation') ?? 'list').trim()

    /*
     * Reading is read access - a contributor should be able to see that a
     * deploy needs approval before they wonder why their run is paused - and
     * every change is administration.
     */
    const auth = await authorizeRepository(request, operation === 'list' ? 'repository:read' : 'repository:settings')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repositoryId = Number(auth.context.repository.id)

    if (operation === 'list') {
      const rows = await db
        .selectFrom('environments')
        .selectAll()
        .where('repository_id', '=', repositoryId)
        .orderBy('name', 'asc')
        .execute()

      return response.json({ environments: await Promise.all(rows.map(shape)) })
    }

    const name = String(request.get('name') ?? '').trim()

    if (!name)
      return response.json({ error: 'Which environment?' }, 422)

    if (operation === 'create') {
      const existing = await db
        .selectFrom('environments')
        .select(['id'])
        .where('repository_id', '=', repositoryId)
        .where('name', '=', name)
        .executeTakeFirst()

      if (existing)
        return response.json({ error: 'That environment already exists', environment: await shape(await row(Number(existing.id))) }, 409)

      const created = await db
        .insertInto('environments')
        .values({
          repository_id: repositoryId,
          name: name.slice(0, 120),
          wait_minutes: Math.max(0, Math.min(43_200, Number(request.get('wait_minutes')) || 0)),
          branches: cleanBranches(request.get('branches')),
          description: String(request.get('description') ?? '').slice(0, 500),
        })
        .returning(['id'])
        .executeTakeFirst()

      await auditEvent('workflow:environment-configured', {
        subject: { type: 'repository', id: repositoryId },
        actorId: auth.context.user?.id ?? null,
        ...await auditFrom(request),
        repositoryId,
        detail: { environment: name, created: true },
      }).catch(() => null)

      return response.json({ environment: await shape(await row(Number(created?.id))) })
    }

    const found = await db
      .selectFrom('environments')
      .selectAll()
      .where('repository_id', '=', repositoryId)
      .where('name', '=', name)
      .executeTakeFirst()

    if (!found)
      return response.json({ error: 'No such environment' }, 404)

    if (operation === 'delete') {
      /*
       * Deleting the environment unprotects every job that names it, silently,
       * from the next run onwards. Said back rather than assumed, because the
       * difference between "removed a stale row" and "turned off approvals for
       * production" is one somebody should see in the answer.
       */
      await db.deleteFrom('environments').where('id', '=', Number(found.id)).execute()

      /*
       * Recorded, because this is the change with no visible trace afterwards:
       * the row is gone, the workflow file still says `environment: production`,
       * and every deploy from here runs unguarded.
       */
      await auditEvent('workflow:environment-removed', {
        subject: { type: 'repository', id: repositoryId },
        actorId: auth.context.user?.id ?? null,
        ...await auditFrom(request),
        repositoryId,
        detail: { environment: name, wait_minutes: Number(found.wait_minutes ?? 0), branches: String(found.branches ?? '') },
      }).catch(() => null)

      return response.json({
        deleted: name,
        note: `Jobs that name \`${name}\` now run without approval, a wait timer, or a branch policy.`,
      })
    }

    if (operation === 'add-reviewer' || operation === 'remove-reviewer') {
      const handle = String(request.get('reviewer') ?? '').trim()

      const user = await db
        .selectFrom('users')
        .select(['id'])
        .where('handle', '=', handle)
        .executeTakeFirst()

      if (!user)
        return response.json({ error: 'No such person' }, 404)

      if (operation === 'remove-reviewer') {
        await db
          .deleteFrom('environment_reviewers')
          .where('environment_id', '=', Number(found.id))
          .where('user_id', '=', Number(user.id))
          .execute()
      }
      else {
        const already = await db
          .selectFrom('environment_reviewers')
          .select(['id'])
          .where('environment_id', '=', Number(found.id))
          .where('user_id', '=', Number(user.id))
          .executeTakeFirst()

        if (!already) {
          await db
            .insertInto('environment_reviewers')
            .values({ environment_id: Number(found.id), repository_id: repositoryId, user_id: Number(user.id) })
            .execute()
        }
      }

      await auditEvent('workflow:environment-configured', {
        subject: { type: 'repository', id: repositoryId },
        actorId: auth.context.user?.id ?? null,
        ...await auditFrom(request),
        repositoryId,
        detail: { environment: name, reviewer: handle, operation },
      }).catch(() => null)

      return response.json({ environment: await shape(await row(Number(found.id))) })
    }

    const changes: Partial<EnvironmentRow> = {}

    if (request.get('wait_minutes') !== undefined && Number.isFinite(Number(request.get('wait_minutes'))))
      changes.wait_minutes = Math.max(0, Math.min(43_200, Number(request.get('wait_minutes'))))

    if (request.get('branches') !== undefined)
      changes.branches = cleanBranches(request.get('branches'))

    if (request.get('description') !== undefined)
      changes.description = String(request.get('description')).slice(0, 500)

    if (!Object.keys(changes).length)
      return response.json({ error: 'Nothing to change' }, 422)

    await db.updateTable('environments').set(changes).where('id', '=', Number(found.id)).execute()

    await auditEvent('workflow:environment-configured', {
      subject: { type: 'repository', id: repositoryId },
      actorId: auth.context.user?.id ?? null,
      ...await auditFrom(request),
      repositoryId,
      detail: { environment: name, changes },
    }).catch(() => null)

    return response.json({ environment: await shape(await row(Number(found.id))) })
  },
})

/** One environment, or nothing if it has just been deleted underneath us. */
async function row(id: number): Promise<EnvironmentRow | undefined> {
  return db.selectFrom('environments').selectAll().where('id', '=', id).executeTakeFirst()
}

type EnvironmentRow = RowOf<'environments'>

/** `main, release/*` from whatever shape the caller sent. */
function cleanBranches(value: unknown): string {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(',')

  return parts.map(one => String(one ?? '').trim()).filter(Boolean).slice(0, 50).join(',')
}

async function shape(environment: EnvironmentRow | undefined): Promise<Record<string, unknown>> {
  const reviewers = await db
    .selectFrom('environment_reviewers')
    .innerJoin('users', 'users.id', '=', 'environment_reviewers.user_id')
    .select(['users.handle as handle'])
    .where('environment_reviewers.environment_id', '=', Number(environment?.id))
    .execute()
    .catch(() => [])

  return {
    name: String(environment?.name ?? ''),
    wait_minutes: Number(environment?.wait_minutes ?? 0),
    branches: String(environment?.branches ?? '').split(',').map(one => one.trim()).filter(Boolean),
    description: String(environment?.description ?? ''),
    reviewers: reviewers.map(one => String(one.handle)),
    /*
     * Said out loud, because an environment with no reviewers, no timer and no
     * branch policy protects nothing - and it looks identical to a configured
     * one in a list.
     */
    protects: Number(environment?.wait_minutes ?? 0) > 0
      || reviewers.length > 0
      || String(environment?.branches ?? '').trim().length > 0,
  }
}
