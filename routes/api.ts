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

// Issues. Both issues and pull requests live in one numbering sequence, so
// `#12` means one thing in a repository, and a comment endpoint serves both.
route.post('/repos/issues', 'Actions/Issue/CreateIssueAction').middleware('auth')
route.post('/repos/issues/comments', 'Actions/Issue/CommentOnIssueAction').middleware('auth')
route.put('/repos/issues/state', 'Actions/Issue/UpdateIssueStateAction').middleware('auth')

// Pull requests and review. Merging is its own endpoint rather than a state
// update: it moves a branch, and that is not something to reach by accident.
route.post('/repos/pulls', 'Actions/Pull/OpenPullRequestAction').middleware('auth')
route.put('/repos/pulls', 'Actions/Pull/UpdatePullRequestAction').middleware('auth')
route.put('/repos/pulls/state', 'Actions/Pull/UpdatePullRequestStateAction').middleware('auth')
route.post('/repos/pulls/reviews', 'Actions/Pull/SubmitReviewAction').middleware('auth')
route.post('/repos/pulls/comments', 'Actions/Pull/CommentOnCodeAction').middleware('auth')
route.put('/repos/pulls/threads', 'Actions/Pull/ResolveThreadAction').middleware('auth')
route.post('/repos/pulls/merge', 'Actions/Pull/MergePullRequestAction').middleware('auth')

// Landing a whole stack, bottom first. Separate from the single merge because
// it can partially succeed, and the caller needs to know how far it got.
route.post('/repos/pulls/merge-stack', 'Actions/Pull/MergeStackAction').middleware('auth')
