import { HttpError } from '@stacksjs/error-handling'
import { Middleware } from '@stacksjs/router'
import { ORGANIZATION_ROLES, organizationRoleSatisfies, type OrganizationRole } from '../Permissions'
import { currentUser, organizationRoleOf } from '../Actions/Identity/lookup'

/**
 * Require a minimum role in the organization the request names.
 *
 * **Ranked, not matched.** `orgRole:admin` admits an owner, because the roles
 * are a ladder and an owner can do everything an admin can. A middleware that
 * compared for equality would lock owners out of every admin endpoint, which is
 * the kind of bug that gets fixed by giving somebody two rows.
 *
 * The organization is read from `organization_id` in the request, and a request
 * that does not name one is refused rather than waved through. A gate whose
 * subject is missing has not passed; it has failed to run, and the two must
 * never be the same answer.
 *
 * **This is a convenience, not the boundary.** Every action behind it checks
 * again through `organizationRoleOf`, because a route registered without the
 * middleware would otherwise be unguarded and look exactly like one that is.
 * What the middleware buys is the failure arriving as a 403 before the action
 * loads anything, and one place to read what a route requires.
 */
export default new Middleware({
  name: 'OrgRole',
  priority: 2,

  async handle(request: any) {
    /*
     * The parameter arrives on the request rather than as an argument. The
     * router parses `orgRole:x` and stores `x` under the middleware name, which
     * is what makes the order of a route's middleware list irrelevant - and is
     * easy to miss, because a `handle(request, parameter)` signature compiles
     * and simply receives undefined.
     */
    const parameter = request._middlewareParams?.orgRole
    const minimum = String(parameter ?? '').trim() as OrganizationRole

    // A misconfigured route is a server fault, not a forbidden request. Saying
    // 403 here would send somebody looking at their own permissions for a typo
    // in a route file.
    if (!(ORGANIZATION_ROLES as readonly string[]).includes(minimum))
      throw new HttpError(500, `orgRole needs one of ${ORGANIZATION_ROLES.join(', ')}`)

    const user = await currentUser(request)
    if (!user)
      throw new HttpError(401, 'Unauthenticated')

    const organizationId = Number(request.get?.('organization_id') ?? request.params?.organization_id)
    if (!Number.isInteger(organizationId) || organizationId <= 0)
      throw new HttpError(422, 'An organization is required')

    // Null for a pending invitation as well as for a stranger, which is the
    // point: the role is what somebody accepted, not what they were offered.
    const role = await organizationRoleOf(organizationId, user.id)

    if (!role || !organizationRoleSatisfies(role, minimum))
      throw new HttpError(403, 'Forbidden')
  },
})
