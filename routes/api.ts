import { response, route } from '@stacksjs/router'

/**
 * The JSON API.
 *
 * Everything here is prefixed with `/api` by the route registry in
 * `app/Routes.ts`. The git wire protocol is not: it has to live at
 * `/{owner}/{repository}.git/...` for a plain `git clone` to work, so it is
 * registered separately in `routes/git.ts` with no prefix.
 *
 * Framework routes (auth, dashboard) load automatically from
 * storage/framework/defaults/routes. Only application routes belong here.
 */

route.get('/health', () => response.json({ ok: true }))

// Organizations. Membership changes carry rules that cannot be recovered from
// if they are got wrong (an organization with no owner), so each one is its own
// action rather than a general update endpoint.
route.post('/orgs', 'Actions/Org/CreateOrganizationAction').middleware('auth')
route.post('/orgs/members', 'Actions/Org/InviteMemberAction').middleware('auth')
route.put('/orgs/members/role', 'Actions/Org/ChangeMemberRoleAction').middleware('auth')
route.delete('/orgs/members', 'Actions/Org/RemoveMemberAction').middleware('auth')

// Keys the caller pushes with.
route.post('/user/keys', 'Actions/Keys/AddSshKeyAction').middleware('auth')
