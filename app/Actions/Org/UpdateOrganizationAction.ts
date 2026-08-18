import { Action } from '@stacksjs/actions'
import { canInOrganization } from '../../Permissions'
import { currentUser, handleAvailable, organizationRoleOf } from '../Identity/lookup'
import { normalizeHandle } from '../Identity/handles'

/**
 * Change an organization's profile, and its handle.
 *
 * The handle is the URL segment, so changing it moves the organization's page
 * and every repository URL beneath it. That is a real cost and it is the
 * owner's to pay, but it goes through the same `handleAvailable` as
 * registration: an organization must never be able to take `/settings` or
 * `/explore`, which would make part of the product unreachable and hand its
 * owner a page every reader trusts.
 *
 * Gated on `settings:manage`, which `ORGANIZATION_ABILITIES` puts at owner.
 * There is deliberately no separate, lower rung for the profile fields: an
 * organization's name and description are what every reader sees above its
 * repositories, and an admin appointed to manage members has not been given
 * that. If a lower rung is ever wanted, it belongs in the abilities table where
 * it can be read against the others, not as a second rule here.
 */
export default new Action({
  name: 'UpdateOrganization',
  description: 'Update an organization profile',
  method: 'PUT',

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const organizationId = Number(request.get('organization_id'))
    const role = await organizationRoleOf(organizationId, user.id)

    if (!canInOrganization(role, 'settings:manage'))
      return response.json({ error: 'Forbidden' }, 403)

    const organization = await db
      .selectFrom('organizations')
      .select(['id', 'handle'])
      .where('id', '=', organizationId)
      .executeTakeFirst()

    if (!organization)
      return response.json({ error: 'No such organization' }, 404)

    const changes: Record<string, string> = {}

    for (const field of ['name', 'description', 'website', 'billing_email'] as const) {
      const value = request.get(field)
      if (value === undefined || value === null)
        continue

      changes[field] = String(value).trim()
    }

    /*
     * A website must start with http or https, the same rule the user profile
     * applies. The field is rendered as an anchor on a page every reader
     * visits, and `javascript:` in that anchor is stored XSS with a form in
     * front of it.
     */
    if (changes.website && !/^https?:\/\//i.test(changes.website))
      return response.json({ error: 'A website must start with http:// or https://' }, 422)

    const requested = request.get('handle')

    if (requested !== undefined && requested !== null) {
      const handle = normalizeHandle(String(requested))

      if (handle !== String(organization.handle)) {
        const available = await handleAvailable(handle)
        if (!available.ok)
          return response.json({ error: available.message }, 422)

        changes.handle = handle
      }
    }

    if (Object.keys(changes).length === 0)
      return response.json({ ok: true, unchanged: true })

    await db
      .updateTable('organizations')
      .set(changes)
      .where('id', '=', organizationId)
      .execute()

    return response.json({ ok: true, ...changes })
  },
})
