import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { currentUser } from '../Identity/lookup'
import { coerced } from '../inputs'

/** Members choose whether their own accepted membership is on their profile. */
export default new Action({
  name: 'SetMembershipVisibility',
  description: 'Choose whether your organization membership is public',
  method: 'POST',
  validations: {
    organization_id: { rule: coerced },
    visibility: { rule: schema.enum(['public', 'private']).required() },
  },
  responses: {
    200: { description: 'Your membership visibility was updated.' },
    303: { description: 'Return to organization settings after submitting the form.' },
    401: { description: 'Sign in to change membership visibility.' },
    404: { description: 'You have no accepted membership in this organization.' },
    422: { description: 'An organization and a public or private visibility are required.' },
  },
  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user) return response.json({ error: 'Unauthenticated' }, 401)
    const organizationId = Number(request.get('organization_id'))
    if (!Number.isSafeInteger(organizationId) || organizationId <= 0)
      return response.json({ error: 'An organization is required' }, 422)
    const membership = await db.selectFrom('org_members').select(['id']).where('organization_id', '=', organizationId)
      .where('user_id', '=', user.id).whereNotNull('joined_at').executeTakeFirst()
    if (!membership) return response.json({ error: 'No such membership' }, 404)
    await db.updateTable('org_members').set({ is_public: request.get('visibility') === 'public' })
      .where('id', '=', Number(membership.id)).execute()
    if (String(request.header('accept') ?? '').includes('text/html'))
      return response.redirect('/settings/organizations', 303)
    return response.json({ ok: true })
  },
})
