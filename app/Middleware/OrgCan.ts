import { HttpError } from '@stacksjs/error-handling'
import { Middleware } from '@stacksjs/router'
import { ORGANIZATION_ABILITIES, canInOrganization, type OrganizationAbility } from '../Permissions'
import { currentUser, organizationRoleOf } from '../Actions/Identity/lookup'

/**
 * Require an ability in the organization the request names.
 *
 * The sibling of `orgRole`, and the one to reach for. `orgCan:members:manage`
 * says what the endpoint is *for*; `orgRole:admin` says which rung happens to
 * reach it today. When the rung moves - and `ORGANIZATION_ABILITIES` is a table
 * precisely so it can - every route named by ability follows, and every route
 * named by role has to be found and edited.
 *
 * `orgRole` is still there for the handful of places where the rung really is
 * the requirement, and for reading a route file and seeing at a glance who is
 * being let in.
 *
 * The same three rules as `orgRole`: an unknown ability is a 500 rather than a
 * 403, because a misconfigured route is a server fault and not something for
 * somebody to check their own permissions over; a request that names no
 * organization is refused rather than waved through, since a gate whose subject
 * is missing has not passed; and the action behind it checks again, because a
 * route registered without this looks exactly like one registered with it.
 */
export default new Middleware({
  name: 'OrgCan',
  priority: 2,

  async handle(request: any) {
    /*
     * The parameter arrives on the request rather than as an argument. The
     * router parses `orgCan:x` and stores `x` under the middleware name, which
     * is what makes the order of a route's middleware list irrelevant - and is
     * easy to miss, because a `handle(request, parameter)` signature compiles
     * and simply receives undefined.
     */
    const parameter = request._middlewareParams?.orgCan
    const ability = String(parameter ?? '').trim() as OrganizationAbility

    if (!Object.prototype.hasOwnProperty.call(ORGANIZATION_ABILITIES, ability))
      throw new HttpError(500, `orgCan needs one of ${Object.keys(ORGANIZATION_ABILITIES).join(', ')}`)

    const user = await currentUser(request)
    if (!user)
      throw new HttpError(401, 'Unauthenticated')

    const organizationId = Number(request.get?.('organization_id') ?? request.params?.organization_id)
    if (!Number.isInteger(organizationId) || organizationId <= 0)
      throw new HttpError(422, 'An organization is required')

    const role = await organizationRoleOf(organizationId, user.id)

    if (!canInOrganization(role, ability))
      throw new HttpError(403, 'Forbidden')
  },
})
