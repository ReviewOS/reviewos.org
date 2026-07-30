import { Action } from '@stacksjs/actions'
import { canInOrganization } from '../../Permissions'
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

  async handle(request: any) {
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

    await db
      .insertInto('org_members')
      .values({
        organization_id: organizationId,
        user_id: inviteeId,
        role,
        invited_by_id: actor.id,
        joined_at: new Date().toISOString(),
      })
      .execute()

    return response.json({ ok: true, handle, role }, 201)
  },
})
