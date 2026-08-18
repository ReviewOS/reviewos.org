import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { canInOrganization } from '../../Permissions'
import { auditFrom } from '../Git/audit'
import { currentUser, organizationRoleOf } from '../Identity/lookup'
import { normalizeHandle } from '../Identity/handles'

/**
 * Add somebody to an organization.
 *
 * Named for what it will become: today it adds the member directly, and the
 * invitation flow (a pending row the invitee accepts) lands with notifications
 * in phase 5. The permission check and the role rules are the same either way,
 * so they are written once here.
 */
export default new Action({
  name: 'InviteMember',
  description: 'Add a member to an organization',
  method: 'POST',

  async handle(request: RequestInstance) {
    const actor = await currentUser(request)
    if (!actor)
      return response.json({ error: 'Unauthenticated' }, 401)

    const organizationId = Number(request.get('organization_id'))
    const role = String(request.get('role') ?? 'member')

    if (!['owner', 'admin', 'member'].includes(role))
      return response.json({ error: 'Unknown role' }, 422)

    const actorRole = await organizationRoleOf(organizationId, actor.id)
    if (!canInOrganization(actorRole, 'members:manage'))
      return response.json({ error: 'Forbidden' }, 403)

    if (role === 'owner' && actorRole !== 'owner')
      return response.json({ error: 'Only an owner can appoint another owner' }, 403)

    const handle = normalizeHandle(String(request.get('handle') ?? ''))
    const invitee = await db.selectFrom('users').select(['id']).where('handle', '=', handle).executeTakeFirst()
    if (!invitee)
      return response.json({ error: 'No such user' }, 404)

    const inviteeId = Number(invitee.id)
    const existing = await organizationRoleOf(organizationId, inviteeId)
    if (existing)
      return response.json({ error: 'Already a member', role: existing }, 409)

    /*
     * The row is written with a null `joined_at`, which is what "invited" is.
     *
     * It carries the role it will have, so accepting is one column and no
     * decision, and `organizationRoleOf` answers null until then - so the
     * pending row grants nothing anywhere in the product, including to a query
     * written later by somebody who has never read this file.
     */
    await db
      .insertInto('org_members')
      .values({
        organization_id: organizationId,
        user_id: inviteeId,
        role,
        invited_by_id: actor.id,
        joined_at: null,
      })
      .execute()

    await notifyOfInvitation({ organizationId, inviteeId, role, invitedBy: actor.handle })

    // The invitation, not only the joining. Who was offered what is the half of
    // the story that explains an account nobody remembers adding, and the
    // acceptance on its own does not say who opened the door.
    await auditEvent('member:invited', {
      subject: { type: 'user', id: inviteeId },
      actorId: actor.id,
      ...await auditFrom(request),
      organizationId,
      detail: { handle, role },
    })

    return response.json({ ok: true, handle, role, pending: true }, 201)
  },
})

/**
 * Put the invitation in the invitee's inbox.
 *
 * Written directly rather than emitted as an event, because the notification
 * machinery resolves recipients from subscriptions and there is exactly one
 * recipient here, known by name. Routing a single addressed message through a
 * subscription resolver would mean inventing a subscription for it.
 *
 * Never throws. An invitation that was recorded and not announced is a member
 * waiting to be told; an invitation that failed because the inbox insert did is
 * a caller retrying against a row that already exists.
 */
async function notifyOfInvitation(input: {
  organizationId: number
  inviteeId: number
  role: string
  invitedBy: string
}): Promise<void> {
  try {
    const organization = await db
      .selectFrom('organizations')
      .select(['handle', 'name'])
      .where('id', '=', input.organizationId)
      .executeTakeFirst()

    const name = String(organization?.name || organization?.handle || 'an organization')

    await db.insertInto('notifications').values({
      user_id: input.inviteeId,
      type: 'org:invited',
      data: JSON.stringify({
        title: `${input.invitedBy} invited you to ${name} as ${input.role}`,
        // Straight to the page that can accept it. An invitation notification
        // that lands somewhere requiring a hunt for the accept button is a
        // notification people leave unread.
        url: '/settings/organizations',
        reason: 'You were invited',
        repository: null,
        number: null,
      }),
    }).execute()
  }
  catch (error) {
    console.error('[org] could not announce the invitation:', error)
  }
}
