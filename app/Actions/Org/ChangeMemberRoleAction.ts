import { Action } from '@stacksjs/actions'
import { canInOrganization, wouldOrphanOrganization, type OrganizationRole } from '../../Permissions'
import { currentUser, organizationOwnerCount, organizationRoleOf } from '../Identity/lookup'

/**
 * Change what a member of an organization may do.
 *
 * Refuses the change that would leave the organization with no owner. That is
 * checked here rather than trusted to the caller because it is unrecoverable:
 * nobody left can appoint a replacement.
 */
export default new Action({
  name: 'ChangeMemberRole',
  description: 'Change an organization member role',
  method: 'PUT',

  async handle(request: any) {
    const actor = await currentUser(request)
    if (!actor)
      return response.json({ error: 'Unauthenticated' }, 401)

    const organizationId = Number(request.get('organization_id'))
    const memberUserId = Number(request.get('user_id'))
    const nextRole = String(request.get('role') ?? '') as OrganizationRole

    if (!['owner', 'admin', 'member'].includes(nextRole))
      return response.json({ error: 'Unknown role' }, 422)

    const actorRole = await organizationRoleOf(organizationId, actor.id)
    if (!canInOrganization(actorRole, 'members:manage'))
      return response.json({ error: 'Forbidden' }, 403)

    // Only an owner may create another owner. An admin promoting itself would
    // be a privilege escalation with extra steps.
    if (nextRole === 'owner' && actorRole !== 'owner')
      return response.json({ error: 'Only an owner can appoint another owner' }, 403)

    const memberRole = await organizationRoleOf(organizationId, memberUserId)
    if (!memberRole)
      return response.json({ error: 'Not a member of this organization' }, 404)

    const ownerCount = await organizationOwnerCount(organizationId)
    if (wouldOrphanOrganization({ memberRole, ownerCount, nextRole }))
      return response.json({ error: 'An organization must keep at least one owner' }, 422)

    await db
      .updateTable('org_members')
      .set({ role: nextRole })
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', memberUserId)
      .execute()

    return response.json({ ok: true, role: nextRole })
  },
})
