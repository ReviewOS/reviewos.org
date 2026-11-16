import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { auditEvent } from '../../Audit/events'
import { canInOrganization, wouldOrphanOrganization, type OrganizationRole } from '../../Permissions'
import { auditFrom } from '../Git/audit'
import { currentUser, organizationOwnerCount, organizationRoleOf } from '../Identity/lookup'
import { coerced } from '../inputs'
import { refuse, succeed } from '../Support/forge'

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

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    organization_id: { rule: coerced },
    role: { rule: schema.string() },
    user_id: { rule: schema.number() },
  },

  async handle(request: RequestInstance) {
    const actor = await currentUser(request)
    if (!actor)
      return refuse(request, 'Unauthenticated', 401)

    const organizationId = Number(request.get('organization_id'))
    const memberUserId = Number(request.get('user_id'))
    const nextRole = String(request.get('role') ?? '') as OrganizationRole

    if (!['owner', 'admin', 'member'].includes(nextRole))
      return refuse(request, 'Unknown role', 422)

    const actorRole = await organizationRoleOf(organizationId, actor.id)
    if (!canInOrganization(actorRole, 'members:manage'))
      return refuse(request, 'Forbidden', 403)

    // Only an owner may create another owner. An admin promoting itself would
    // be a privilege escalation with extra steps.
    if (nextRole === 'owner' && actorRole !== 'owner')
      return refuse(request, 'Only an owner can appoint another owner', 403)

    const memberRole = await organizationRoleOf(organizationId, memberUserId)
    if (!memberRole)
      return refuse(request, 'Not a member of this organization', 404)

    const ownerCount = await organizationOwnerCount(organizationId)
    if (wouldOrphanOrganization({ memberRole, ownerCount, nextRole }))
      return refuse(request, 'An organization must keep at least one owner', 422)

    await db
      .updateTable('org_members')
      .set({ role: nextRole })
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', memberUserId)
      .execute()

    // The role somebody held is as much of the record as the one they hold now:
    // "was made an owner" and "was already an owner" are different sentences,
    // and only one of them explains what happened next.
    await auditEvent('member:role-changed', {
      subject: { type: 'user', id: memberUserId },
      actorId: actor.id,
      ...await auditFrom(request),
      organizationId,
      detail: { from: memberRole, to: nextRole },
    })

    return succeed(request, { ok: true, role: nextRole }, 'Role changed')
  },
})
