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

// Access tokens. Fine-grained is the only kind: every capability the product
// has maps to a scope in `app/TokenScopes.ts`, enforced by a test, so there is
// never a reason to reach for something broader.
route.get('/user/tokens', 'Actions/Tokens/ListTokensAction').middleware('auth')
route.post('/user/tokens', 'Actions/Tokens/CreateTokenAction').middleware('auth')
route.delete('/user/tokens', 'Actions/Tokens/RevokeTokenAction').middleware('auth')

// When notifications may interrupt, and what has been muted. Both are here
// rather than under a repository because they are decisions about a person.
route.put('/user/notifications/schedule', 'Actions/Notification/UpdateScheduleAction').middleware('auth')
route.post('/user/notifications/mutes', 'Actions/Notification/MuteAction').middleware('auth')

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
route.post('/repos/pulls/review-requests', 'Actions/Pull/RequestReviewAction').middleware('auth')
route.put('/repos/pulls/reviews/dismiss', 'Actions/Pull/DismissReviewAction').middleware('auth')
route.post('/repos/pulls/comments', 'Actions/Pull/CommentOnCodeAction').middleware('auth')
route.put('/repos/pulls/threads', 'Actions/Pull/ResolveThreadAction').middleware('auth')
route.post('/repos/pulls/mergeability', 'Actions/Pull/RefreshMergeabilityAction').middleware('auth')
route.post('/repos/pulls/merge', 'Actions/Pull/MergePullRequestAction').middleware('auth')

// Landing a whole stack, bottom first. Separate from the single merge because
// it can partially succeed, and the caller needs to know how far it got.
route.post('/repos/pulls/merge-stack', 'Actions/Pull/MergeStackAction').middleware('auth')

// Mirrors. The webhook is deliberately unauthenticated at the route level: an
// upstream forge has no session here, and the request is verified instead by
// its signature against the mirror's own secret inside the action.
route.post('/mirrors/webhook', 'Actions/Mirror/MirrorWebhookAction')
