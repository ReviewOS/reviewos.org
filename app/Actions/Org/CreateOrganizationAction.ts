import { Action } from '@stacksjs/actions'
import { handleAvailable } from '../Identity/lookup'
import { normalizeHandle } from '../Identity/handles'
import { currentUser } from '../Identity/lookup'

/**
 * Create an organization and make the caller its owner.
 *
 * The organization row and the owner membership are one unit: an organization
 * with no owner cannot be administered by anyone, and cannot be repaired from
 * the interface. If the membership insert fails the organization is removed
 * again rather than left in that state.
 */
export default new Action({
  name: 'CreateOrganization',
  description: 'Create an organization owned by the caller',
  method: 'POST',

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const handle = normalizeHandle(String(request.get('handle') ?? ''))
    const available = await handleAvailable(handle)
    if (!available.ok)
      return response.json({ error: available.message }, 422)

    const name = String(request.get('name') ?? '').trim() || handle

    const created = await db
      .insertInto('organizations')
      .values({
        handle,
        name,
        description: String(request.get('description') ?? ''),
        billing_email: String(request.get('billing_email') ?? ''),
      })
      .returning(['id'])
      .executeTakeFirst()

    const organizationId = Number(created?.id)
    if (!organizationId)
      return response.json({ error: 'Could not create the organization' }, 500)

    try {
      await db
        .insertInto('org_members')
        .values({
          organization_id: organizationId,
          user_id: user.id,
          role: 'owner',
          invited_by_id: user.id,
          joined_at: new Date().toISOString(),
        })
        .execute()
    }
    catch (error) {
      // Leave nothing half-built: an organization nobody owns is worse than no
      // organization at all.
      await db.deleteFrom('organizations').where('id', '=', organizationId).execute()
      throw error
    }

    return response.json({ id: organizationId, handle, name }, 201)
  },
})
