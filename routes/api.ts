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

// Repositories. Settings is one endpoint for every field, because a rename
// moves a directory and the row and the directory have to end up agreeing;
// splitting it up is how that ends up implemented twice. Delete, transfer and
// fork are their own, because each does something to disk that a general update
// endpoint should never be able to reach by accident.
route.post('/repos', 'Actions/Repo/CreateRepositoryAction').middleware('auth')
route.put('/repos', 'Actions/Repo/UpdateSettingsAction').middleware('auth')
// The same action on POST, because an HTML form can only GET or POST and the
// settings page is a form. The action does not care which verb carried it.
route.post('/repos/settings', 'Actions/Repo/UpdateSettingsAction').middleware('auth')
route.delete('/repos', 'Actions/Repo/DeleteRepositoryAction').middleware('auth')
// And on POST, for the settings page's form. Same action, same typed-back
// confirmation - a form cannot send DELETE, and a hidden `_method` field is a
// convention the router does not have.
route.post('/repos/delete', 'Actions/Repo/DeleteRepositoryAction').middleware('auth')
route.post('/repos/transfer', 'Actions/Repo/TransferRepositoryAction').middleware('auth')
route.post('/repos/forks', 'Actions/Repo/ForkRepositoryAction').middleware('auth')

// Following a repository. Starring toggles, because the page cannot know
// whether the star it drew has been pressed since it was drawn. Watching does
// not, because it has three answers and the middle one is the one people want.
route.post('/repos/stars', 'Actions/Repo/StarAction').middleware('auth')
route.put('/repos/watches', 'Actions/Repo/WatchAction').middleware('auth')

// Reading a repository. None of these carries `auth` middleware, and that is
// the point: a public repository is public, and `browseContext` inside each
// action answers 404 to anyone who cannot read a private one - the same answer
// a repository that does not exist gives, so a stranger learns nothing either
// way. A token still works, over Bearer or over the basic auth somebody clones
// with, because the same credential should read a file and a clone.
route.get('/repos/tree', 'Actions/Browse/TreeAction')
route.get('/repos/blob', 'Actions/Browse/BlobAction')
route.get('/repos/commits', 'Actions/Browse/CommitsAction')
route.get('/repos/commit', 'Actions/Browse/CommitAction')
route.get('/repos/branches', 'Actions/Browse/BranchesAction')
route.get('/repos/tags', 'Actions/Browse/TagsAction')
route.get('/repos/blame', 'Actions/Browse/BlameAction')
route.get('/repos/compare', 'Actions/Browse/CompareAction')

// Releases. A release is a tag plus what somebody wanted to say about it, so
// listing is a read of the repository and publishing is a settings-level write:
// an announcement about the project rather than a change to its code. One
// endpoint for create, update and delete, because all three share the rule that
// decides whether a tag already has a release.
route.get('/repos/releases', 'Actions/Repo/ListReleasesAction')
route.post('/repos/releases', 'Actions/Repo/ManageReleaseAction').middleware('auth')

// The files attached to a release. Downloading carries no auth middleware, the
// same as the rest of the read surface: a public repository's binaries are
// public, and the action answers 404 to anyone who cannot read a private one -
// and to anyone at all for a draft, because an unannounced release is the thing
// a draft is keeping.
route.post('/repos/releases/assets', 'Actions/Release/UploadAssetAction').middleware('auth')
route.get('/repos/releases/assets', 'Actions/Release/DownloadAssetAction')

// Topics. The whole list at once, because that is how the interface presents
// it; two endpoints would mean the page reconstructing the difference itself.
route.put('/repos/topics', 'Actions/Repo/UpdateTopicsAction').middleware('auth')
route.post('/repos/topics', 'Actions/Repo/UpdateTopicsAction').middleware('auth')

// Bytes rather than JSON. Both stream, and neither serves a repository's
// content as its own type - see app/Actions/Git/download.ts for why that is a
// security decision rather than a convenience one.
route.get('/repos/raw', 'Actions/Git/RawFileAction')
route.get('/repos/archive', 'Actions/Git/ArchiveAction')

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

// The lines between two hunks. Read from the blob at the head commit, because
// the patch does not contain them: not containing them is what makes them a gap.
route.get('/repos/pulls/diff/context', 'Actions/Pull/DiffContextAction')

// The files that conflict, both versions in each. Read out of the tree that
// `git merge-tree` already wrote, so no working tree is checked out to answer.
route.get('/repos/pulls/diff/conflicts', 'Actions/Pull/DiffConflictsAction')

// Landing a whole stack, bottom first. Separate from the single merge because
// it can partially succeed, and the caller needs to know how far it got.
route.post('/repos/pulls/merge-stack', 'Actions/Pull/MergeStackAction').middleware('auth')

// Where a reviewer got to: which files they have finished with, and the comment
// they were halfway through writing. Read without `auth` middleware, because a
// signed-out reader gets an empty answer rather than a refusal and the page
// carries on with local storage; written with it, because there is no such
// thing as anonymous progress to record.
route.get('/repos/pulls/review-state', 'Actions/Pull/ReviewStateAction')
route.put('/repos/pulls/review-state/viewed', 'Actions/Pull/MarkFileViewedAction').middleware('auth')
route.put('/repos/pulls/review-state/draft', 'Actions/Pull/SaveReviewDraftAction').middleware('auth')

// Mirrors. The webhook is deliberately unauthenticated at the route level: an
// upstream forge has no session here, and the request is verified instead by
// its signature against the mirror's own secret inside the action.
route.post('/mirrors/webhook', 'Actions/Mirror/MirrorWebhookAction')
