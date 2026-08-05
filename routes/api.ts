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
// Listing is the one that is readable without an account, because a public
// repository's issues are public.
route.get('/repos/issues', 'Actions/Issue/ListIssuesAction')
route.post('/repos/issues', 'Actions/Issue/CreateIssueAction').middleware('auth')
route.put('/repos/issues', 'Actions/Issue/UpdateIssueAction').middleware('auth')
route.post('/repos/issues/comments', 'Actions/Issue/CommentOnIssueAction').middleware('auth')
route.put('/repos/issues/comments', 'Actions/Issue/UpdateCommentAction').middleware('auth')
route.delete('/repos/issues/comments', 'Actions/Issue/DeleteCommentAction').middleware('auth')
route.put('/repos/issues/state', 'Actions/Issue/UpdateIssueStateAction').middleware('auth')
route.put('/repos/issues/labels', 'Actions/Issue/LabelIssueAction').middleware('auth')
route.put('/repos/issues/assignees', 'Actions/Issue/AssignIssueAction').middleware('auth')
route.put('/repos/issues/milestone', 'Actions/Issue/MilestoneIssueAction').middleware('auth')
route.put('/repos/issues/lock', 'Actions/Issue/LockIssueAction').middleware('auth')
// Ticking a checklist item. Anybody who can comment can tick a box: a checklist
// on a shared issue is a coordination device, and gating it behind write access
// turns it into a status report from the maintainers.
route.put('/repos/issues/tasks', 'Actions/Issue/ToggleTaskAction').middleware('auth')
// Reacting, on an issue body or on a comment. One endpoint, toggling: the page
// cannot know whether the button it drew has been pressed since it was drawn,
// so asking it to choose between add and remove is asking it to guess.
route.post('/repos/issues/reactions', 'Actions/Issue/ReactAction').middleware('auth')
// Attaching a file. The browser does not use this: a file picked next to a
// comment box is stored when the comment is submitted, because the page runs no
// client-side JavaScript and there is no editor to insert a link into. This is
// for the API, the CLI, and anything writing a body that needs the reference
// before it writes the body. Reading an attachment is at the root, in
// `routes/attachments.ts`.
route.post('/repos/attachments', 'Actions/Attachment/UploadAttachmentAction').middleware('auth')
// Triage in bulk. Each operation asks for the ability its single-issue version
// asks for, so nothing is reachable here that is not reachable one at a time.
route.post('/repos/issues/bulk', 'Actions/Issue/BulkUpdateIssuesAction').middleware('auth')

// The label and milestone *sets*, as opposed to applying them to an issue.
// One endpoint each, with the operation in the body: create, update and delete
// share the rule that decides whether a name is already taken, and splitting
// them into three routes is how that rule ends up implemented twice.
route.post('/repos/labels', 'Actions/Issue/ManageLabelAction').middleware('auth')
route.post('/repos/milestones', 'Actions/Issue/ManageMilestoneAction').middleware('auth')

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

// The file list of a diff, streamed as newline-delimited JSON while git is
// still writing the patch. No `auth` middleware: a public repository's pull
// request is public, and `authorizeRepository` inside the action answers 404 to
// anyone who cannot read a private one.
route.get('/repos/pulls/diff/manifest', 'Actions/Pull/DiffManifestAction')

// Rows for a named handful of files, for a diff too large to have been
// rendered inline. By path rather than by position, so `git diff` can be given
// a pathspec and the cost is the files asked for rather than the ones skipped.
route.get('/repos/pulls/diff/rows', 'Actions/Pull/DiffRowsAction')

// Landing a whole stack, bottom first. Separate from the single merge because
// it can partially succeed, and the caller needs to know how far it got.
route.post('/repos/pulls/merge-stack', 'Actions/Pull/MergeStackAction').middleware('auth')

// Mirrors. The webhook is deliberately unauthenticated at the route level: an
// upstream forge has no session here, and the request is verified instead by
// its signature against the mirror's own secret inside the action.
route.post('/mirrors/webhook', 'Actions/Mirror/MirrorWebhookAction')
