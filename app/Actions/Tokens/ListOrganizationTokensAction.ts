import { Action } from '@stacksjs/actions'
import { canInOrganization } from '../../Permissions'
import { currentUser, organizationRoleOf } from '../Identity/lookup'
import { tokensReaching } from './organization'

/**
 * Every live token that can reach this organization's repositories.
 *
 * The question an administrator actually has, and the one every forge answers
 * only for the token's owner: not "what are my tokens" but "what can currently
 * reach our code, and who is holding it". Without it, a contractor leaving is a
 * request to several people to please remember to revoke something.
 *
 * Gated on `settings:manage`, which the abilities table puts at owner. This is
 * a list of who holds credentials to the organization, which is a more
 * sensitive thing than the membership list it is adjacent to - a member can see
 * who their colleagues are, and should not be able to enumerate their tokens.
 *
 * **No secret in the response, in any form.** The prefix identifies which token
 * a row is and is public by design; there is no field here from which anything
 * could be authenticated.
 */
export default new Action({
  name: 'ListOrganizationTokens',
  description: 'List every token that can reach an organization',
  method: 'GET',

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const organizationId = Number(request.get('organization_id') ?? request.params?.organization_id)
    if (!Number.isInteger(organizationId) || organizationId <= 0)
      return response.json({ error: 'An organization is required' }, 422)

    const role = await organizationRoleOf(organizationId, user.id)

    // Not found rather than forbidden, the same answer somebody outside the
    // organization gets for its people page: a 403 confirms the organization
    // exists and that its token list is worth asking about.
    if (!canInOrganization(role, 'settings:manage'))
      return response.json({ error: 'No such organization' }, 404)

    const tokens = await tokensReaching(organizationId)

    return response.json({
      organization_id: organizationId,
      count: tokens.length,
      /*
       * Counted by how the token reaches here, because the three are different
       * problems. A `membership` token is one nobody scoped to this
       * organization at all - it reaches every repository its owner can, which
       * includes these, and it is the number an administrator has never seen
       * before.
       */
      by_reach: {
        organization: tokens.filter(token => token.via === 'organization').length,
        selected: tokens.filter(token => token.via === 'selected').length,
        membership: tokens.filter(token => token.via === 'membership').length,
      },
      tokens,
    })
  },
})
