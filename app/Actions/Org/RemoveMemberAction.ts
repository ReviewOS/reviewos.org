import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { auditEvent } from '../../Audit/events'
import { canInOrganization, wouldOrphanOrganization } from '../../Permissions'
import { auditFrom } from '../Git/audit'
import { currentUser, organizationOwnerCount, organizationRoleOf } from '../Identity/lookup'
import { coerced } from '../inputs'

/**
 * Remove somebody from an organization.
 *
 * Leaving of your own accord is allowed without the manage permission, since
 * nobody should need permission to stop being a member. The last owner still
 * cannot leave, for the same reason they cannot be demoted.
 */
export default new Action({
  name: 'RemoveMember',
  description: 'Remove a member from an organization',
  method: 'DELETE',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    organization_id: { rule: coerced },
    user_id: { rule: schema.number() },
  },

  async handle(request: RequestInstance) {
    const actor = await currentUser(request)
    if (!actor)
      return response.json({ error: 'Unauthenticated' }, 401)

    const organizationId = Number(request.get('organization_id'))
    const memberUserId = Number(request.get('user_id'))
    const leavingSelf = memberUserId === actor.id

    const actorRole = await organizationRoleOf(organizationId, actor.id)
    if (!leavingSelf && !canInOrganization(actorRole, 'members:manage'))
      return response.json({ error: 'Forbidden' }, 403)

    const memberRole = await organizationRoleOf(organizationId, memberUserId)
    if (!memberRole)
      return response.json({ error: 'Not a member of this organization' }, 404)

    const ownerCount = await organizationOwnerCount(organizationId)
    if (wouldOrphanOrganization({ memberRole, ownerCount, nextRole: null })) {
      return response.json({
        error: leavingSelf
          ? 'Appoint another owner before leaving'
          : 'An organization must keep at least one owner',
      }, 422)
    }

    await db
      .deleteFrom('org_members')
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', memberUserId)
      .execute()

    // Whether they left or were removed, recorded as a fact rather than left to
    // be inferred from the actor. They are the same row when somebody leaves,
    // and reading a log should not require noticing that.
    await auditEvent('member:removed', {
      subject: { type: 'user', id: memberUserId },
      actorId: actor.id,
      ...await auditFrom(request),
      organizationId,
      detail: { role: memberRole, left: leavingSelf },
    })

    return response.json({ ok: true })
  },
})
