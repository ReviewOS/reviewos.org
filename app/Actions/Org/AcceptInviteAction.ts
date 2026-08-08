import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'

/**
 * Accept or decline an invitation to an organization.
 *
 * **Only your own, and there is no parameter that could say otherwise.** The
 * row is found by the caller's own id, so an endpoint that accepts on somebody
 * else's behalf does not exist to be forgotten. That matters more here than in
 * most places: accepting for somebody would add them to an organization they
 * never agreed to join, and organization membership is what a lot of other
 * access hangs off.
 *
 * Accepting is one column. `joined_at` moving from null to a timestamp is the
 * whole of it, because the role was decided by whoever invited them and
 * `organizationRoleOf` already refuses to answer while it is null.
 */
export default new Action({
  name: 'AcceptInvite',
  description: 'Accept or decline an invitation to an organization',
  method: 'POST',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const organizationId = Number(request.get('organization_id'))
    if (!Number.isInteger(organizationId) || organizationId <= 0)
      return response.json({ error: 'An organization is required' }, 422)

    const invitation: any = await db
      .selectFrom('org_members')
      .select(['id', 'role', 'joined_at'])
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', user.id)
      .executeTakeFirst()

    if (!invitation)
      return response.json({ error: 'No invitation to this organization' }, 404)

    // Already a member. Answered as success rather than as a conflict: the
    // desired state holds, and the usual way to reach this is a second click on
    // a notification that is still sitting in the inbox.
    if (invitation.joined_at)
      return response.json({ ok: true, role: String(invitation.role), already: true })

    if (String(request.get('operation') ?? '') === 'decline') {
      await db.deleteFrom('org_members').where('id', '=', Number(invitation.id)).execute()

      return response.json({ declined: true })
    }

    await db
      .updateTable('org_members')
      .set({ joined_at: new Date().toISOString() })
      .where('id', '=', Number(invitation.id))
      .execute()

    return response.json({ ok: true, role: String(invitation.role) })
  },
})
