import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { auditEvent } from '../../Audit/events'
import { REPOSITORY_LEVELS, type RepositoryPermission } from '../../Permissions'
import { auditFrom } from '../Git/audit'
import { authorizeRepository } from '../Repo/authorize'
import { organizationRoleOf } from '../Identity/lookup'
import { coerced } from '../inputs'

/**
 * Give a team access to a repository, change what it has, or take it away.
 *
 * **Authorized on the repository, not on the organization.** Handing out access
 * to a repository is an act on that repository, and its `repository:settings`
 * rung is the one that already means "may change how this is reached". Checking
 * organization membership instead would let an organization admin grant access
 * to a repository they cannot themselves administer.
 *
 * The team must belong to the organization that owns the repository. Without
 * that, a grant would cross an organization boundary - and inheritance would
 * carry it further, since a child team elsewhere would pick it up too.
 */
export default new Action({
  name: 'GrantRepositoryToTeam',
  description: 'Grant, change, or revoke a team\'s access to a repository',
  method: 'POST',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.string() },
    permission: { rule: schema.string() },
    team_id: { rule: coerced },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:settings')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    // A personal repository has no organization, so it has no teams to grant
    // to. Said plainly rather than answered with an empty list, because the
    // fix is to transfer the repository and that is worth knowing.
    if (String(repository.owner_type) !== 'organization')
      return response.json({ error: 'Only a repository owned by an organization can be granted to a team' }, 422)

    const teamId = Number(request.get('team_id'))

    const team: any = Number.isInteger(teamId) && teamId > 0
      ? await db
          .selectFrom('teams')
          .select(['id'])
          .where('id', '=', teamId)
          .where('organization_id', '=', Number(repository.owner_id))
          .executeTakeFirst()
      : null

    if (!team)
      return response.json({ error: 'No such team in this organization' }, 404)

    if (String(request.get('operation') ?? '') === 'revoke') {
      await db
        .deleteFrom('team_repositories')
        .where('team_id', '=', teamId)
        .where('repository_id', '=', Number(repository.id))
        .execute()

      await auditEvent('team:access-changed', {
        subject: { type: 'team', id: teamId },
        actorId: user.id,
        ...await auditFrom(request),
        repositoryId: Number(repository.id),
        organizationId: Number(repository.owner_id),
        detail: { revoked: true },
      })

      return response.json({ revoked: true })
    }

    const permission = String(request.get('permission') ?? 'read') as RepositoryPermission

    if (!(REPOSITORY_LEVELS as readonly string[]).includes(permission))
      return response.json({ error: `A permission is one of ${REPOSITORY_LEVELS.join(', ')}` }, 422)

    /*
     * An admin grant needs admin, not settings.
     *
     * `repository:settings` is the maintain rung, and without this a maintainer
     * could grant `admin` to a team they are in and then administer the
     * repository through it. That is a two-step privilege escalation, and the
     * second step looks like ordinary team membership.
     */
    if (permission === 'admin' && !auth.context.can('repository:delete')) {
      const role = await organizationRoleOf(Number(repository.owner_id), user.id)

      if (role !== 'owner' && role !== 'admin')
        return response.json({ error: 'Only an administrator can grant admin' }, 403)
    }

    const existing = await db
      .selectFrom('team_repositories')
      .select(['id'])
      .where('team_id', '=', teamId)
      .where('repository_id', '=', Number(repository.id))
      .executeTakeFirst()

    // Upserted rather than inserted. Granting twice is the same grant, and two
    // rows with different permissions would make the answer depend on which
    // came back first.
    if (existing) {
      await db
        .updateTable('team_repositories')
        .set({ permission })
        .where('id', '=', Number(existing.id))
        .execute()
    }
    else {
      await db
        .insertInto('team_repositories')
        .values({ team_id: teamId, repository_id: Number(repository.id), permission })
        .execute()
    }

    /*
     * A grant to a team reaches everybody in it, and everybody in every team
     * beneath it, without any of them appearing anywhere on this repository.
     * That is the point of teams and it is also why this line matters more than
     * a direct grant would: nothing else in the product will ever name the
     * people who just gained access.
     */
    await auditEvent('team:access-changed', {
      subject: { type: 'team', id: teamId },
      actorId: user.id,
      ...await auditFrom(request),
      repositoryId: Number(repository.id),
      organizationId: Number(repository.owner_id),
      detail: { permission, granted: !existing },
    })

    return response.json({ team_id: teamId, repository_id: Number(repository.id), permission })
  },
})
