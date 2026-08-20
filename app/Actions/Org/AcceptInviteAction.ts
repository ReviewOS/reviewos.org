import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
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

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    operation: { rule: schema.string() },
    organization_id: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const organizationId = Number(request.get('organization_id'))
    if (!Number.isInteger(organizationId) || organizationId <= 0)
      return response.json({ error: 'An organization is required' }, 422)

    const invitation = await db
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

      // A declined invitation is recorded as a removal rather than not at all.
      // The pending row granted nothing, but somebody offered access and it is
      // the offer that a reader is trying to account for.
      await auditEvent('member:removed', {
        subject: { type: 'user', id: user.id },
        actorId: user.id,
        ...await auditFrom(request),
        organizationId,
        detail: { role: String(invitation.role), declined: true },
      })

      return response.json({ declined: true })
    }

    await db
      .updateTable('org_members')
      .set({ joined_at: new Date().toISOString() })
      .where('id', '=', Number(invitation.id))
      .execute()

    // The moment the role starts granting anything. Until now the row existed
    // and `organizationRoleOf` answered null, so this - not the invitation - is
    // when access began.
    await auditEvent('member:joined', {
      subject: { type: 'user', id: user.id },
      actorId: user.id,
      ...await auditFrom(request),
      organizationId,
      detail: { role: String(invitation.role) },
    })

    return response.json({ ok: true, role: String(invitation.role) })
  },
})
