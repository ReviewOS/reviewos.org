import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { canInOrganization } from '../../Permissions'
import { auditFrom } from '../Git/audit'
import { currentUser, organizationRoleOf } from '../Identity/lookup'

/**
 * Delete an organization.
 *
 * **Refused while it still owns a repository, and the repositories are named.**
 * A cascade here would take every repository the organization owns, and with
 * them every issue, pull request and review anybody ever wrote against them.
 * That is not a plausible thing to ask for by accident, and it is not something
 * a confirmation box makes safe: the person clicking it is thinking about the
 * organization, not about the seventeen repositories underneath it.
 *
 * So the repositories have to be dealt with first - transferred to another
 * owner or deleted one at a time, each with its own confirmation and its own
 * recoverable copy on disk. Slower on purpose. The list comes back in the
 * refusal so the answer is a to-do list rather than a wall.
 *
 * The handle has to be typed back, exactly. It is the only confirmation that
 * survives a misdirected click, a stale tab, or a script pointed at the wrong
 * organization - all three of which produce a correctly authorized request for
 * the wrong thing, which is what the permission check cannot catch.
 */
export default new Action({
  name: 'DeleteOrganization',
  description: 'Delete an organization that owns nothing',
  method: 'DELETE',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const organizationId = Number(request.get('organization_id'))
    const role = await organizationRoleOf(organizationId, user.id)

    if (!canInOrganization(role, 'organization:delete'))
      return response.json({ error: 'Forbidden' }, 403)

    const organization = await db
      .selectFrom('organizations')
      .select(['id', 'handle'])
      .where('id', '=', organizationId)
      .executeTakeFirst()

    if (!organization)
      return response.json({ error: 'No such organization' }, 404)

    const handle = String(organization.handle)
    const confirmation = String(request.get('confirm') ?? '').trim()

    if (confirmation !== handle)
      return response.json({ error: `Type ${handle} to confirm` }, 422)

    const owned = await db
      .selectFrom('repositories')
      .select(['name'])
      .where('owner_type', '=', 'organization')
      .where('owner_id', '=', organizationId)
      .execute()

    if (owned.length > 0) {
      return response.json({
        error: `${handle} still owns ${owned.length} ${owned.length === 1 ? 'repository' : 'repositories'}. Transfer or delete them first.`,
        repositories: owned.map(row => String(row.name)),
      }, 409)
    }

    /*
     * Members and teams go with it, through the cascades on `org_members` and
     * `teams` - and a team's grants and memberships go with the team, through
     * the cascades on `team_repositories` and `team_members`. Nothing here has
     * meaning without the organization, and a dangling row in an access table
     * is the kind that survives a reorganisation and quietly grants somebody
     * something.
     */
    /*
     * Recorded before the row goes, and this is the one event whose own scope
     * outlives its subject.
     *
     * `organization_id` is written even though the organization is about to
     * stop existing, so the row is still found by the scope filter - by an
     * instance administrator, since there is no longer an owner to read it.
     * The alternative is a deletion that vanishes from the log along with the
     * thing it deleted, which is the one gap this table cannot have.
     */
    await auditEvent('organization:deleted', {
      subject: { type: 'organization', id: organizationId },
      actorId: user.id,
      ...await auditFrom(request),
      organizationId,
      detail: { handle },
    })

    await db.deleteFrom('organizations').where('id', '=', organizationId).execute()

    return response.json({ deleted: true, handle })
  },
})
