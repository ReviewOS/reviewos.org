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

/*
 * Health, meaning the three things that can be broken while the process is
 * fine: the database, the queue, and the disk the repositories live on.
 *
 * It used to answer `{ ok: true }` unconditionally, which tells a load balancer
 * to keep sending traffic to an instance whose database is gone. The process
 * being up was never in doubt - it is the thing answering.
 *
 * `?quick=1` skips the disk write, for a liveness probe that runs every few
 * seconds. One endpoint serving both probes beats two that drift.
 */
route.get('/health', 'Actions/Ops/HealthAction')

/*
 * Link-preview cards for the pages a build cannot enumerate.
 *
 * `?path=/owner/repository/pull/12`, answering a PNG. Every page inside the
 * product points its `og:image` here rather than at a static file, because
 * there is no static file: an instance has a page per repository, per pull
 * request, per issue and per account, and those are most of what actually gets
 * pasted into a chat.
 *
 * Unauthenticated on purpose - the reader is whatever server unfurled the
 * link, arriving with no session - and so the action resolves everything as a
 * stranger and falls back to the generic site card for anything a stranger may
 * not see. See `app/Actions/Og/resolve.ts`.
 */
route.get('/og', 'Actions/Og/SocialCardAction')

/*
 * Metrics, for a scraper. Prometheus exposition format, because it is what
 * every scraper reads and a self-hosted forge should be observable with the
 * tools people already run.
 *
 * Not public: the numbers say how many repositories and accounts an instance
 * has, how much traffic it takes and when it is struggling, which is
 * reconnaissance served conveniently. An administrator, or `METRICS_TOKEN` -
 * a scrape config holds a bearer far more comfortably than a session, and
 * asking somebody to give their scraper an admin account is asking for an admin
 * password in a config file.
 */
route.get('/metrics', 'Actions/Ops/MetricsAction')

/*
 * The audit log, read-only.
 *
 * **There is no write route, and that absence is the append-only guarantee.** A
 * setting called append-only is one somebody turns off; a table with no
 * endpoint that writes to it outside `recordAudit` is one nobody can quietly
 * correct.
 *
 * An instance administrator reads everything; an organization owner reads their
 * own organization by passing `organization_id`. Everybody else gets a 404 -
 * the same answer as for an organization that does not exist, because
 * 403-versus-404 here is a membership oracle.
 */
route.get('/audit', 'Actions/Ops/AuditLogAction')

/*
 * The settings an administrator changes without a deploy.
 *
 * One endpoint for the read and the write, because a second is a second place
 * the administrator check has to be right - the same reasoning as the audit
 * log's two formats. The read returns each setting with its definition, so a
 * page built against it does not hard-code the list a second time.
 */
route.post('/instance/settings', 'Actions/Ops/InstanceSettingsAction')

/*
 * The administration surface: what this instance is, and the few levers.
 *
 * One endpoint for five reads and two writes, because a second is a second
 * place the administrator check has to be right - and a mistake in that gate on
 * any one of them exposes every private repository here. A stranger gets a 404,
 * so whether an instance has an administration API is not confirmable by asking.
 */
route.post('/instance/admin', 'Actions/Ops/AdminAction')
/*
 * The fleet: pools, queues, draining, and which machines serve what.
 *
 * Administrative, and answers 404 rather than 403 to everybody else - whether
 * an instance has a fleet at all is not something to confirm to a stranger.
 */
route.post('/instance/fleet', 'Actions/Runner/FleetAction')
/*
 * The pipeline numbers: runs, queue waits, fleet utilization, minutes, flakes.
 *
 * One route for both scopes rather than two, because the two answers are the
 * same shape and a repository-scoped copy is a second place the window, the
 * percentile, and the sample floor would have to agree. `owner` and `repo`
 * narrow it to one repository, which anybody who can read that repository may
 * ask for; without them it is instance-wide and administrative.
 */
route.get('/insight', 'Actions/Ops/InsightAction')
/*
 * The runner binary, so an autoscaler's cloud-init has a URL.
 *
 * Public and uncredentialed on purpose: the file contains no secret and does
 * nothing until it is given a URL and a token. Requiring a credential would
 * mean every cloud-init holding one *before* the runner credential it is
 * actually there to use.
 */
route.get('/runner/download', 'Actions/Runner/DownloadRunnerAction')
/*
 * A machine adding itself to the fleet with a registration token.
 *
 * Unauthenticated in the session sense - there is nobody at the keyboard - and
 * the credential in the header is the whole of the authentication. It is
 * exchanged immediately for a per-runner one, because by the threat model a
 * registration credential must never reach a job environment.
 */
route.post('/runner/register', 'Actions/Runner/RegisterRunnerAction')

/*
 * The OpenAPI document, at a stable public URL.
 *
 * Generating it is not publishing it: a document only somebody with the source
 * can find is a document for the group that did not need it. The bar this phase
 * set is that the API is discoverable *without* reading the source, and this is
 * the URL that makes that true.
 */
route.get('/openapi.json', 'Actions/Api/OpenApiAction')

/*
 * Long-running work, as a resource.
 *
 * One shape for all of it, so a client that can follow a mirror sync can follow
 * an import without learning anything new. The alternative - every endpoint
 * answering `202` with a body of its own invention - means each client writes
 * its own inference about what happened, and each one is wrong differently.
 *
 * `{id}` is the operation's uuid, never its primary key: a sequential id in a
 * URL says how much work this instance has done and invites walking it.
 */
route.get('/operations/{id}', 'Actions/Api/ShowOperationAction')
route.post('/operations/{id}/cancel', 'Actions/Api/CancelOperationAction')

/*
 * Search. No `auth` middleware, deliberately: a public repository is public and
 * a stranger searching for one should find it. Who the caller is decides what
 * comes back rather than whether they may ask - `SearchAction` filters every
 * hit through `visibility.ts` against the current user, anonymous included.
 */
route.get('/search', 'Actions/Search/SearchAction')

/*
 * The Model Context Protocol endpoint: the review surface as agent tools.
 *
 * No `auth` middleware, and that is not an oversight. The action reads the
 * bearer itself and hands it to every API call it makes - it holds no
 * credential of its own, so there is no path through it that reaches anything
 * the caller could not have reached directly. Putting `auth` in front would
 * additionally make an unauthenticated handshake a 401 HTML page rather than a
 * JSON-RPC error, which reads to an MCP client as a broken server.
 *
 * `skipCsrf` for the same reason it is safe: a request with no bearer is
 * refused by the action before anything else happens, so there is no
 * cookie-authenticated path here for a forged cross-site POST to ride. CSRF
 * protection defends the browser's ambient credential, and this endpoint
 * accepts no ambient credential at all. Left on, it answers a client that
 * forgot its token with a 403 about a cookie it was never going to send.
 */
route.post('/mcp', 'Mcp/McpAction').skipCsrf()

// Signing in, out, and up. These override the framework defaults, which answer
// with JSON and set no cookie - right for an API client reading access_token,
// wrong for a form, because a browser shown JSON is a browser still signed out.
// One endpoint serves both: an Accept of text/html gets a redirect and a cookie,
// anything else gets the token pack the framework clients already expect.
/*
 * Ten attempts every five minutes, per address.
 *
 * Sign-in is the one endpoint where the limit is the security control rather
 * than a courtesy: without it, a password is only as good as how fast somebody
 * can guess, and a modern machine guesses quickly. Ten is generous for a person
 * who has forgotten which password they used and useless to anybody working
 * through a list.
 *
 * Per address, unavoidably - a request that has not signed in yet carries no
 * token and names no account. It is the weak bucket the module warns about, and
 * it is the only one available here.
 */
route.post('/auth/login', 'Actions/Auth/LoginAction').middleware('throttle:10,5m')
/*
 * Twenty an hour, not five.
 *
 * Registration is keyed by address like sign-in, and unlike sign-in the limit
 * is not the security control - email verification and invite-only are. So the
 * number has to clear the case the module's own comment warns about: an office
 * or a university behind one NAT, where five people signing up in ten minutes
 * is a Monday rather than an attack.
 *
 * Twenty an hour still stops scripted bulk signup, which arrives in hundreds
 * and not dozens.
 */
route.post('/auth/register', 'Actions/Auth/RegisterAction').middleware('throttle:20,1h')
// POST, not GET. An <img src="/logout"> in a comment would sign every reader
// out, which is a denial of service written in one tag by anybody who can post
// markdown.
route.post('/auth/logout', 'Actions/Auth/LogoutAction')

/*
 * Signing in with an account somebody already has.
 *
 * Under `/api` with the rest of auth rather than at the root, and that is a
 * deployment fact rather than a preference: this application serves file-based
 * stx views for everything outside `/api`, so a route at `/auth/github` is a
 * route nothing reaches - `[owner]/[repository]` catches it first and reports
 * that there is no account called auth. The provider consoles are configured
 * to match, and `config/services.ts` defaults to these paths so an operator
 * who pastes what the config says gets a working OAuth application.
 *
 * `GET` for both halves, which OAuth2's redirect flow requires: the provider
 * returns the browser with a top-level navigation. That is why the state
 * cookie in `SocialRedirectAction` is doing so much work - see the note there.
 *
 * Throttled, and tighter than sign-in. These are the only unauthenticated
 * endpoints that make outbound requests to somebody else's API, so an
 * unlimited callback is a way to spend our rate limit at GitHub from anywhere.
 */
route.get('/auth/{provider}/callback', 'Actions/Auth/SocialCallbackAction').middleware('throttle:20,5m')
route.get('/auth/{provider}', 'Actions/Auth/SocialRedirectAction').middleware('throttle:20,5m')

/*
 * Forgotten passwords and unverified addresses.
 *
 * The reset endpoint is one action for both halves - asking for a link and
 * using one - because they are the same conversation and splitting them means
 * two places that have to agree on how a token is spelled.
 *
 * Verification is a GET, which is the one place the rule about GET not changing
 * anything has to bend: it is a link in an email, a mail client cannot POST,
 * and asking somebody to copy a token into a form loses most of them. The token
 * is single-use, expiring and unguessable, so the worst a prefetching mail
 * client can do is verify the address its own user asked to verify.
 */
/*
 * Tighter still. A reset sends mail to somebody who did not ask for it, so an
 * unthrottled endpoint is a way to use this instance to send a stranger fifty
 * emails - which costs them an afternoon and costs this instance its sending
 * reputation.
 */
route.post('/auth/password/reset', 'Actions/Auth/PasswordResetAction').middleware('throttle:5,15m')
route.get('/auth/verify', 'Actions/Auth/VerifyEmailAction')
route.post('/auth/verify/resend', 'Actions/Auth/VerifyEmailAction').middleware('auth')

// Your own profile, and only your own. There is no id parameter that could say
// otherwise - an endpoint that takes one and checks it is an endpoint where the
// check can be forgotten.
/*
 * Who this credential belongs to.
 *
 * No `auth` middleware: the endpoint's whole job is to answer whether the
 * caller is signed in, and a middleware that refuses an unauthenticated request
 * with an HTML 401 makes "no" indistinguishable from a broken server. The
 * action answers 401 as JSON itself.
 */
route.get('/user', 'Actions/Identity/WhoAmIAction')

route.post('/user/profile', 'Actions/Profile/UpdateProfileAction').middleware('auth')

/*
 * Somebody else's profile: who they are, their repositories, their README.
 *
 * Unauthenticated, because a profile is public and the action decides for
 * itself what this caller may see - private repositories to the owner and to
 * nobody else, which is the rule `/{handle}` follows.
 *
 * It exists because the page could do something a token could not:
 * `ownerRepositories` had exactly one caller, the profile view, so an agent
 * asking what an account has was left scraping the page or filtering
 * `/explore` by hand. `tests/unit/api-parity.test.ts` is what noticed.
 */
route.get('/owners', 'Actions/Profile/ShowOwnerAction')

// Organizations. Membership changes carry rules that cannot be recovered from
// if they are got wrong (an organization with no owner), so each one is its own
// action rather than a general update endpoint.
route.post('/orgs', 'Actions/Org/CreateOrganizationAction').middleware('auth')
/*
 * `orgCan:<ability>` in front of the endpoints that act on an existing
 * organization. It names what the endpoint is for rather than which rung
 * happens to reach it, so a rung moving in `ORGANIZATION_ABILITIES` carries the
 * route with it.
 *
 * The actions check again. This is a convenience - the failure arrives as a 403
 * before anything is loaded, and a route file says what it requires - and not
 * the boundary, because a route registered without it looks exactly like one
 * registered with it.
 */
route.put('/orgs', 'Actions/Org/UpdateOrganizationAction').middleware(['auth', 'orgCan:settings:manage'])
route.delete('/orgs', 'Actions/Org/DeleteOrganizationAction').middleware(['auth', 'orgCan:organization:delete'])
route.post('/orgs/members', 'Actions/Org/InviteMemberAction').middleware(['auth', 'orgCan:members:manage'])
// Accepting takes no id but the organization's, because the invitation is
// always the caller's own. There is no parameter that could name somebody else.
route.post('/orgs/members/accept', 'Actions/Org/AcceptInviteAction').middleware('auth')
// An account that holds tokens and nothing else. Not behind `orgCan`, because
// the action refuses with a 404 in one of its cases and a middleware saying 403
// first would confirm what the 404 is there to hide.
route.post('/orgs/machine-accounts', 'Actions/Org/CreateMachineAccountAction').middleware('auth')
route.put('/orgs/members/role', 'Actions/Org/ChangeMemberRoleAction').middleware(['auth', 'orgCan:members:manage'])
route.delete('/orgs/members', 'Actions/Org/RemoveMemberAction').middleware(['auth', 'orgCan:members:manage'])
// The same four over POST. An HTML form can only GET or POST, and every write
// on the organization settings page goes through one.
route.post('/orgs/update', 'Actions/Org/UpdateOrganizationAction').middleware(['auth', 'orgCan:settings:manage'])
route.post('/orgs/delete', 'Actions/Org/DeleteOrganizationAction').middleware(['auth', 'orgCan:organization:delete'])
route.post('/orgs/members/role', 'Actions/Org/ChangeMemberRoleAction').middleware(['auth', 'orgCan:members:manage'])
route.post('/orgs/members/remove', 'Actions/Org/RemoveMemberAction').middleware(['auth', 'orgCan:members:manage'])

// Keys the caller pushes with, and signs with. Both are listed by the settings
// page rather than by an endpoint: it reads them server-side, so a list route
// would exist only to be a second way to get the same rows wrong.
/*
 * The browsers signed in as you, and the button that ends one.
 *
 * One endpoint for the list and the revocation, like the audit log's two
 * formats: a second is a second place the ownership check has to be right, and
 * a list of where an account signs in from is a list of where a person is.
 */
route.post('/user/sessions', 'Actions/Auth/SessionsAction').middleware('auth')

/*
 * The second factor: enrolling, disabling, and reissuing recovery codes.
 *
 * Behind `auth` because every operation acts on the caller and takes no user
 * id - an endpoint that could turn off somebody else's second factor does not
 * exist here to be forgotten.
 */
route.post('/user/two-factor', 'Actions/Auth/TwoFactorAction').middleware('auth')

/*
 * Single sign-on, both legs on one route.
 *
 * A GET, because both are navigations: the browser is sent to the provider and
 * the provider sends it back. Unauthenticated by definition - it is how
 * somebody becomes authenticated - and everything it trusts is either signed by
 * the provider or signed by us in the handshake cookie, so there is no ambient
 * credential for a forged request to spend.
 */
route.get('/auth/sso', 'Actions/Auth/SsoAction')

/*
 * Passkeys: registering one, listing them, removing one.
 *
 * Signing in with one is on the login route beside the TOTP code, because it is
 * the same question at the same moment. Behind `auth` because every operation
 * here acts on the caller - an endpoint that could remove somebody else's
 * passkey would be an endpoint that removes a second factor.
 */
route.post('/user/passkeys', 'Actions/Auth/PasskeyAction').middleware('auth')

/*
 * Your own credential for an upstream forge, which is what makes write-through
 * review possible without a shared account posting on anybody's behalf.
 *
 * There is no admin form of this on purpose: a credential that acts as a person
 * is handed over by that person or the attribution it protects is a fiction.
 * Throttled because connecting calls out to the forge to verify the token.
 */
route.post('/user/forge-credentials', 'Actions/Mirror/ForgeCredentialAction').middleware('auth').middleware('throttle:20,5m')

/*
 * An AT Protocol identity on your own account.
 *
 * The whole of the federation surface, and its smallness is phase 10's decision
 * rather than an unfinished state: identity portability, no content federation,
 * so there is no inbox here to defend and nothing that replicates. Throttled
 * because linking resolves against a directory and a domain.
 */
route.post('/user/atproto', 'Actions/Atproto/AtprotoLinkAction').middleware('auth').middleware('throttle:20,5m')

/*
 * The signature step: an authorization at the person's own server.
 *
 * `POST /auth/atproto` starts it - resolve the identity, discover its
 * authorization server *from the identity*, push the request, and hand back a
 * URL. The callback checks that the account the server names is the account the
 * flow started as, which is the check the whole exchange exists for.
 *
 * Unauthenticated on purpose: this is how somebody signs in. Throttled harder
 * than the linking endpoint because each call resolves a handle and talks to
 * two of somebody else's servers.
 */
route.post('/auth/atproto', 'Actions/Atproto/AtprotoSignInAction').middleware('throttle:10,5m')
route.get('/auth/atproto/callback', 'Actions/Atproto/AtprotoCallbackAction').middleware('throttle:20,5m')

route.post('/user/keys', 'Actions/Keys/AddSshKeyAction').middleware('auth')
route.delete('/user/keys', 'Actions/Keys/DeleteSshKeyAction').middleware('auth')
route.post('/user/gpg-keys', 'Actions/Keys/AddGpgKeyAction').middleware('auth')
route.delete('/user/gpg-keys', 'Actions/Keys/DeleteGpgKeyAction').middleware('auth')

// The same two removals over POST, because an HTML form cannot send DELETE and
// every write on the settings page goes through one.
route.post('/user/keys/delete', 'Actions/Keys/DeleteSshKeyAction').middleware('auth')
route.post('/user/gpg-keys/delete', 'Actions/Keys/DeleteGpgKeyAction').middleware('auth')

// A key that reaches one repository rather than one person, for a machine.
// Behind the same gate as renaming or deleting the repository, because standing
// access to it is not a smaller thing than either.
route.post('/repos/deploy-keys', 'Actions/Keys/ManageDeployKeyAction').middleware('auth')

// Access tokens. Fine-grained is the only kind: every capability the product
// has maps to a scope in `app/TokenScopes.ts`, enforced by a test, so there is
// never a reason to reach for something broader.
route.get('/user/tokens', 'Actions/Tokens/ListTokensAction').middleware('auth')
route.post('/user/tokens', 'Actions/Tokens/CreateTokenAction').middleware('auth')
route.delete('/user/tokens', 'Actions/Tokens/RevokeTokenAction').middleware('auth')
// And over POST, for the same reason the key removals are: `settings/tokens.stx`
// revokes with a form, and a form cannot send DELETE.
route.post('/user/tokens/revoke', 'Actions/Tokens/RevokeTokenAction').middleware('auth')
// Replacing one without a gap. The old token keeps working for a day, so the
// deploy that picks up the new one does not have to happen the same minute.
route.post('/user/tokens/rotate', 'Actions/Tokens/RotateTokenAction').middleware('auth')

/*
 * The other question about tokens, and the one nobody builds: not "what are my
 * tokens" but "what can currently reach our code, and who is holding it".
 *
 * Not behind `orgCan`, because the refusal has to be a 404 rather than a 403 -
 * a forbidden here confirms the organization exists and that its token list is
 * worth asking about. The action does the check and answers accordingly.
 *
 * Revoking one of these goes through the same `/user/tokens/revoke` an owner
 * uses on their own, which grants an organization administrator the power for
 * exactly the tokens that reach them. One endpoint, so there is one place that
 * decides what revocation means.
 */
route.get('/orgs/tokens', 'Actions/Tokens/ListOrganizationTokensAction').middleware('auth')

// When notifications may interrupt, and what has been muted. Both are here
// rather than under a repository because they are decisions about a person.
route.put('/user/notifications/schedule', 'Actions/Notification/UpdateScheduleAction').middleware('auth')
route.post('/user/notifications/mutes', 'Actions/Notification/MuteAction').middleware('auth')

// The inbox itself. POST for marking read rather than PUT, because the page is
// a form and an HTML form can only GET or POST - and the page is the reason
// this endpoint exists at all.
route.get('/user/notifications', 'Actions/Notification/ListNotificationsAction').middleware('auth')
route.post('/user/notifications/read', 'Actions/Notification/MarkReadAction').middleware('auth')

// One cell of the preference grid. One at a time rather than a whole-grid
// submit, so a page left open in another tab cannot overwrite a change with
// values it read five minutes ago.
route.post('/user/notifications/preferences', 'Actions/Notification/UpdatePreferenceAction').middleware('auth')

// This browser, for push. One endpoint for register and unregister, because
// both turn on the same question - is this endpoint already ours - and
// splitting them is how that check ends up written twice.
route.post('/user/notifications/push', 'Actions/Notification/PushSubscribeAction').middleware('auth')

// Ring this browser now. The failure modes of web push are all invisible from
// both ends - a downgraded permission, a mismatched key, a worker that never
// activated - and a button that rings the browser in front of you is the only
// way to tell them apart.
route.post('/user/notifications/push/test', 'Actions/Notification/PushTestAction').middleware('auth')


// Teams. `members:manage` rather than `settings:manage`, because a team is how
// access is handed out - requiring the settings rung would mean an admin who
// can add people cannot put them in a team, which is the same job in two halves.
route.post('/orgs/teams', 'Actions/Team/ManageTeamAction').middleware('auth')
route.post('/orgs/teams/members', 'Actions/Team/ManageTeamMemberAction').middleware('auth')

// Granting a team a repository is an act on the *repository*, so it is
// authorized there. Checking the organization instead would let an admin grant
// access to a repository they cannot themselves administer.
route.post('/repos/teams', 'Actions/Team/GrantRepositoryAction').middleware('auth')

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

// Protected branch rules. Its own endpoint rather than a field on settings: a
// repository has many rules and one settings row, so they do not share a shape,
// and the rung they need is the same one only because removing a protection is
// as consequential as deleting the repository it protects.
//
// The enforcement has been in place since phase 2 and this is the half that
// lets anybody turn it on. A rule that can only be inserted by hand into the
// database is a feature that exists in the tests.
route.post('/repos/protected-branches', 'Actions/Repo/ManageProtectedBranchAction').middleware('auth')

// Direct collaborators. The team grant above only covers repositories an
// organization owns, which leaves out what a self-hosted instance is mostly
// made of: one person's repository and one other person who needs to push to
// it. `repo_collaborators` was read by the access checks and written by nothing.
route.post('/repos/collaborators', 'Actions/Repo/ManageCollaboratorAction').middleware('auth')

// Following a repository. Starring toggles, because the page cannot know
// whether the star it drew has been pressed since it was drawn. Watching does
// not, because it has three answers and the middle one is the one people want.
route.post('/repos/stars', 'Actions/Repo/StarAction').middleware('auth')
route.put('/repos/watches', 'Actions/Repo/WatchAction').middleware('auth')
// The same action under POST, because a browser form cannot send PUT and the
// watch control in the repository header is a form - this product's pages run
// no client-side JavaScript, so a form is the only control that can write
// without any. Not a second endpoint: one action, reachable by the one method
// HTML has.
route.post('/repos/watches', 'Actions/Repo/WatchAction').middleware('auth')

// Reading a repository. None of these carries `auth` middleware, and that is
// the point: a public repository is public, and `browseContext` inside each
// action answers 404 to anyone who cannot read a private one - the same answer
// a repository that does not exist gives, so a stranger learns nothing either
// way. A token still works, over Bearer or over the basic auth somebody clones
// with, because the same credential should read a file and a clone.
route.get('/repos/tree', 'Actions/Browse/TreeAction')
route.get('/repos/blob', 'Actions/Browse/BlobAction')

// A window of one file's lines, so a forty thousand line file is readable at
// all. The page renders its first window and asks for the rest as the reader
// moves, which is the same arrangement the diff surface uses on a large file.
route.get('/repos/blob/rows', 'Actions/Browse/BlobRowsAction')
route.get('/repos/commits', 'Actions/Browse/CommitsAction')
route.get('/repos/commit', 'Actions/Browse/CommitAction')
route.get('/repos/branches', 'Actions/Browse/BranchesAction')
route.get('/repos/tags', 'Actions/Browse/TagsAction')
route.get('/repos/blame', 'Actions/Browse/BlameAction')
/*
 * Code search, in one repository, at a ref.
 *
 * `git grep` against the tree, so the answer is the code as it is on that ref
 * rather than as it was when an indexer last ran - which for a review tool is
 * the difference between an answer and a plausible one. Instance-wide search
 * needs an index and is deliberately not this.
 */
route.get('/repos/search', 'Actions/Browse/SearchCodeAction')

/*
 * Code search across the instance.
 *
 * The trigram index narrows and `git grep` decides, so a result is the code as
 * it is on the ref rather than as it was when an indexer last ran. Scope is
 * decided before anything is searched: a repository the caller cannot read is
 * never searched, so it cannot contribute a match and its existence cannot be
 * inferred from one.
 *
 * Throttled, and it is the only *read* on this file that is. One request here
 * can start a git process per repository that survives the index, which makes
 * it the cheapest way to ask this instance to do a lot of work - and unlike a
 * clone, it needs no repository, no push and no size. Twenty a minute is
 * generous for somebody searching and useless for somebody grinding the box.
 */
route.get('/search/code', 'Actions/CodeIndex/SearchCodeInstanceAction').middleware('throttle:20,1m')

/*
 * What is happening on this instance: trending, recently active, and the
 * languages and topics to browse by. Public repositories only, enforced in the
 * reads - an explore page is the one surface where a visibility mistake is not
 * a leak to one person but a listing.
 */
route.get('/explore', 'Actions/Explore/ExploreAction')
// What the landing page shows, so a client does not have to scrape it.
route.get('/featured', 'Actions/Explore/FeaturedAction')
route.get('/discover', 'Actions/Feed/DiscoverFeedAction')
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

// The one exception, and it is narrow on purpose: an image, recognised by its
// bytes rather than by its name, off a closed list, under a CSP that makes the
// response inert. It exists because `nosniff` on raw is what stops a pushed
// `index.html` being a page here - and is also what stops a README's own
// diagrams from rendering. See app/Actions/Git/media.ts.
route.get('/repos/media', 'Actions/Git/MediaAction')

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
/*
 * Reading one pull request, and what is waiting on you.
 *
 * Both existed only as pages, which is the parity gap this project calls a bug
 * rather than a design decision: the interface reached something the API could
 * not, so an agent asking the most useful question a reviewing agent has - what
 * should I look at - had to scrape the page or reconstruct the ordering itself.
 *
 * The queue endpoint takes no user parameter. It is always the caller's own, so
 * there is no check to forget.
 */
route.get('/repos/pulls', 'Actions/Pull/ListPullRequestsAction')
route.get('/repos/pulls/show', 'Actions/Pull/ShowPullRequestAction')

/*
 * The stack, as data.
 *
 * Both of these exist because the CLI needed them and they did not, which is
 * the rule this phase set: an endpoint a client needs gets built rather than
 * worked around. Listing was reachable only by rendering a page, and a stack
 * only as a navigation strip - so a client would have had to fetch every pull
 * request and rebuild the chain, which is a second answer to what lands first.
 */
route.get('/repos/pulls/stack', 'Actions/Pull/StackAction')
route.get('/reviews/queue', 'Actions/Pull/ReviewQueueAction').middleware('auth')

route.post('/repos/pulls', 'Actions/Pull/OpenPullRequestAction').middleware('auth')
route.put('/repos/pulls', 'Actions/Pull/UpdatePullRequestAction').middleware('auth')
route.put('/repos/pulls/state', 'Actions/Pull/UpdatePullRequestStateAction').middleware('auth')
route.post('/repos/pulls/reviews', 'Actions/Pull/SubmitReviewAction').middleware('auth')
route.post('/repos/pulls/review-requests', 'Actions/Pull/RequestReviewAction').middleware('auth')
route.put('/repos/pulls/reviews/dismiss', 'Actions/Pull/DismissReviewAction').middleware('auth')
route.post('/repos/pulls/comments', 'Actions/Pull/CommentOnCodeAction').middleware('auth')
route.put('/repos/pulls/threads', 'Actions/Pull/ResolveThreadAction').middleware('auth')
route.post('/repos/pulls/mergeability', 'Actions/Pull/RefreshMergeabilityAction').middleware('auth')
// "I have read this round": advance last-looked without submitting a verdict.
route.post('/repos/pulls/last-look', 'Actions/Pull/AdvanceLastLookAction').middleware('auth')
route.post('/repos/pulls/merge', 'Actions/Pull/MergePullRequestAction').middleware('auth')
// Auto-merge: armed with a strategy, fired by whichever event satisfies the
// requirements. Arming when they are already met merges now.
route.post('/repos/pulls/auto-merge', 'Actions/Pull/EnableAutoMergeAction').middleware('auth')
route.post('/repos/pulls/auto-merge/disarm', 'Actions/Pull/DisableAutoMergeAction').middleware('auth')
// The branch a merge deleted, put back. A guarded create: it refuses rather
// than overwrite a branch that has since reappeared under the old name.
route.post('/repos/pulls/restore-branch', 'Actions/Pull/RestoreHeadBranchAction').middleware('auth')

// The file list of a diff, streamed as newline-delimited JSON while git is
// still writing the patch. No `auth` middleware: a public repository's pull
// request is public, and `authorizeRepository` inside the action answers 404 to
// anyone who cannot read a private one.
route.get('/repos/pulls/diff/manifest', 'Actions/Pull/DiffManifestAction')

// Rows for a named handful of files, for a diff too large to have been
// rendered inline. By path rather than by position, so `git diff` can be given
// a pathspec and the cost is the files asked for rather than the ones skipped.
route.get('/repos/pulls/diff/rows', 'Actions/Pull/DiffRowsAction')

/*
 * The same diff as data, for a caller that is not a browser.
 *
 * `/diff/rows` returns HTML because that is what a browser needs and rendering
 * it on the server is what makes a fifty-thousand line diff cheap. An agent
 * asking the same question would otherwise have to parse that HTML back into
 * hunks - re-implementing the parser, getting it subtly wrong, and breaking the
 * first time a class name changes. Scraping the rendered diff should never be
 * the only way to get one.
 *
 * Same `parseDiff` as the review screen, so the two cannot disagree about what
 * a hunk is. If they ever did, the diff a reviewer approved would not be the
 * diff an agent read.
 */
route.get('/repos/pulls/diff/structured', 'Actions/Pull/DiffStructuredAction')

// The lines between two hunks. Read from the blob at the head commit, because
// the patch does not contain them: not containing them is what makes them a gap.
route.get('/repos/pulls/diff/context', 'Actions/Pull/DiffContextAction')
// The interdiff: what changed in one file since the reader last looked, at
// line level, as the diff of the two patch texts.
route.get('/repos/pulls/diff/interdiff', 'Actions/Pull/DiffInterdiffAction')
// Why one context line is here: a single-line blame at the merge base, paid
// when a reader asks. authorizeRepository inside answers 404 for private
// repositories.
route.get('/repos/pulls/diff/blame', 'Actions/Pull/BlameLineAction')
// CI's coverage report, keyed to a commit like check runs are, so one report
// serves every pull request whose head is that commit.
route.post('/repos/coverage', 'Actions/Checks/UploadCoverageAction').middleware('auth')

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

// Which files changed since this reader last read this pull request. Paths
// rather than a diff: the viewer already holds the diff, and what it is missing
// is which of its files an earlier conclusion no longer covers.
route.get('/repos/pulls/review-state/since', 'Actions/Pull/SinceLastLookAction')

// Which of this reviewer's ticks have stopped being true. Per file rather than
// per push: the head is one sha for the whole pull request, so unmarking on any
// push would clear the ticks on the files it did not touch.
route.get('/repos/pulls/review-state/stale', 'Actions/Pull/StaleTicksAction')

// Who has worked on the files this pull request changes. A suggestion and never
// a request: asking somebody is a person's decision, and a queue filled with a
// heuristic's guesses is a queue people stop reading.
route.get('/repos/pulls/suggested-reviewers', 'Actions/Pull/SuggestReviewersAction')

/*
 * Checks: what CI says about a commit, and what it says back.
 *
 * The reporting endpoint is behind `check:report`, which maps to the `checks`
 * token scope rather than `contents` - reporting a verdict is not permission to
 * push code, and a CI token that could push is a CI token whose compromise is a
 * supply chain incident. CI credentials live in more places than any other an
 * organization has.
 */
route.get('/repos/checks', 'Actions/Checks/ShowChecksAction')
route.post('/repos/checks', 'Actions/Checks/ReportCheckAction').middleware('auth')
route.put('/repos/pulls/review-state/viewed', 'Actions/Pull/MarkFileViewedAction').middleware('auth')
route.put('/repos/pulls/review-state/draft', 'Actions/Pull/SaveReviewDraftAction').middleware('auth')

// What moved on a pull request, and who else is looking. POST because it is
// also the heartbeat - asking is how a reader says they are still here, and
// presence and freshness are one round trip so a page cannot report itself
// present while showing stale content.
route.post('/repos/pulls/live', 'Actions/Pull/LiveStateAction')

// Webhooks on a repository. `repository:settings` rather than
// `repository:push`: a webhook sends this repository's activity to a server
// somebody chooses, which is a decision about the project rather than a change
// to its code. One endpoint for create, update and delete, because all three
// share the rule that decides whether a URL may be called at all - and that
// rule is the security boundary of the whole feature.
/*
 * The dashboard feed, which existed as an action and was registered nowhere.
 *
 * `DashboardFeedAction` was written, keyset paginated, and unreachable - the
 * page rendered its own first page from the same module and nothing served the
 * second. Found by the parity check rather than by a person, which is the point
 * of having one.
 */
route.get('/feed', 'Actions/Feed/DashboardFeedAction').middleware('auth')

route.post('/repos/webhooks', 'Actions/Webhook/ManageWebhookAction').middleware('auth')

// Sending a recorded delivery again. The stored payload is replayed byte for
// byte rather than rebuilt: rebuilding would send today's state under
// yesterday's event name, and the receiver redelivering is doing it precisely
// to reprocess what they missed.
route.post('/repos/webhooks/redeliver', 'Actions/Webhook/RedeliverAction').middleware('auth')

// Mirrors. The webhook is deliberately unauthenticated at the route level: an
// upstream forge has no session here, and the request is verified instead by
// its signature against the mirror's own secret inside the action.
/*
 * `skipCsrf`, and throttled tighter than the API default.
 *
 * The exemption is required and was missing: an upstream forge posting a
 * delivery has no cookie and no way to carry a token, so every real delivery
 * was answered 403 - the endpoint had never worked for the only caller it
 * exists for. It is safe for the reason the other exemptions are: there is no
 * ambient credential here, and the signature over the body is the whole
 * authorization.
 *
 * The throttle is because this is the one unauthenticated endpoint that queues
 * work, and the work is a `git fetch` against somebody else's server. Sixty a
 * minute is far more than any real forge sends and far less than a loop needs
 * to be interesting.
 */
route.post('/mirrors/webhook', 'Actions/Mirror/MirrorWebhookAction').skipCsrf().middleware('throttle:60,1m')
// For the person who does not want to wait for the interval. Behind
// `repository:settings` in the action, because a sync spends somebody else's
// rate limit - a public mirror anybody could trigger is a way to get this
// instance's token banned by whoever it belongs to.
route.post('/mirrors/sync', 'Actions/Mirror/SyncNowAction').middleware('auth')

/*
 * Workflow runs.
 *
 * The control plane's read surface, and the one lifecycle action that already
 * has something to act on. No `auth` middleware on the reads, for the same
 * reason the diff endpoints have none: a public repository's runs are public,
 * and `authorizeRepository` inside each action answers 404 rather than 403 to
 * anybody who cannot read a private one - a 403 would confirm the repository
 * exists.
 *
 * `repository` and `workflow run` in the paths, not provider vocabulary. These
 * are the names the interface, the CLI and the API all use.
 */
route.get('/repos/workflow-runs', 'Actions/Workflow/ListWorkflowRunsAction')

/*
 * The badge a README carries. Anonymous by design - it is fetched by whoever is
 * reading somebody else's page - and it answers `unknown` rather than 404 for
 * everything it cannot show, so a private repository is not confirmed by a
 * broken image.
 */
route.get('/repos/badge', 'Actions/Workflow/BadgeAction')
route.get('/repos/workflow-runs/show', 'Actions/Workflow/ShowWorkflowRunAction')

// Write access, checked in the action: anybody who can see a run is not
// therefore somebody who can stop it.
route.post('/repos/workflow-runs/cancel', 'Actions/Workflow/CancelWorkflowRunAction').middleware('auth')
/*
 * Run a finished run again, as a new attempt of the same run.
 *
 * `scope` is `failed` (the default), `all`, or `job` with a `job` key. The
 * failed scope carries the jobs that were skipped because of the failures with
 * it - re-running only the failure would leave a run finishing green with half
 * its pipeline never having run.
 */
route.post('/repos/workflow-runs/rerun', 'Actions/Workflow/RerunWorkflowRunAction')
/*
 * Holding a run, and letting it go again.
 *
 * Between "let it finish" and "cancel it", which is the control people actually
 * want when a dependency looks wrong: cancelling to buy five minutes means
 * re-running everything that had already passed. Both directions through one
 * action, because they are one decision with a sign.
 */
route.post('/repos/workflow-runs/pause', 'Actions/Workflow/PauseWorkflowRunAction')
/*
 * Stop one job, leaving the rest of the run alone.
 *
 * The case cancelling a whole run cannot serve: one job stuck on a quiet
 * machine, and nine others nobody wants to throw away. Every row under the name
 * goes, because a matrix is several rows under one.
 */
route.post('/repos/workflow-runs/cancel-job', 'Actions/Workflow/CancelWorkflowJobAction')
// `workflow_dispatch`: the trigger with no event behind it. Write access, since
// starting a run spends the instance's runners.
/*
 * The workflows a repository has, and what one of them says.
 *
 * The listing that was missing from every other question this API can answer:
 * runs could be filtered by workflow with no way to find out which workflows
 * existed. `show` carries the versions and the named version's normalized graph
 * - the jobs, their dependencies, their kinds - rather than the file, because
 * re-serving YAML would make every client parse a format whose meaning lives
 * here.
 */
route.get('/repos/workflows', 'Actions/Workflow/ListWorkflowsAction')
/*
 * What this repository's CI has been doing, in aggregate.
 *
 * Every number here can be worked out by reading runs one at a time, which is
 * why nobody does: "is CI getting slower" is a question about a hundred runs
 * and the run screen answers one. So it is asked where the rows are.
 */
route.get('/repos/workflow-metrics', 'Actions/Workflow/MetricsAction')
route.get('/repos/workflows/show', 'Actions/Workflow/ShowWorkflowAction')
route.post('/repos/workflows/dispatch', 'Actions/Workflow/DispatchWorkflowAction').middleware('auth')
/*
 * `repository_dispatch`: the trigger for something that happened somewhere
 * else. The caller chooses a name and a payload and nothing else - the
 * definition is the registered one on the default branch, which is what makes
 * this safe to hand to a program with a narrow token.
 */
route.post('/repos/dispatches', 'Actions/Workflow/RepositoryDispatchAction').middleware('auth')

/*
 * Turning a workflow off without deleting it.
 *
 * `disabled` was a state every dispatch path already refused to run and nothing
 * could set - a check that was dead code and a state that was a lie. Deleting
 * is a commit, a review and a revert for something that is usually temporary.
 */
route.post('/repos/workflows/manage', 'Actions/Workflow/ManageWorkflowAction').middleware('auth')

/*
 * A small GitHub-shaped surface, at the paths Octokit builds.
 *
 * An action does not read this instance's reference: it posts to
 * `${GITHUB_API_URL}/repos/{owner}/{repo}/check-runs` and expects the shape
 * GitHub answers with. Three endpoints - what CI *writes* - and a 404 that
 * names them for everything else, because an action told "Not Found" retries,
 * blames the token, and eventually blames the forge.
 *
 * `{resource}` is the last segment, so one action serves all three and the
 * unsupported ones answer with the list rather than with nothing.
 */
route.post('/gh/repos/{owner}/{repo}/statuses/{sha}', 'Api/GitHubCompatAction').skipCsrf()
route.post('/gh/repos/{owner}/{repo}/issues/{number}/comments', 'Api/GitHubCompatAction').skipCsrf()
route.post('/gh/repos/{owner}/{repo}/{resource}', 'Api/GitHubCompatAction').skipCsrf()
/*
 * Opening a gate: a `reviewos.block:` job waiting for a person.
 *
 * Its own ability rather than `workflow:cancel`, because stopping a build is
 * safe and approving a release is not.
 */
route.post('/repos/workflow-runs/approve', 'Actions/Workflow/ApproveWorkflowJobAction').middleware('auth')
/*
 * Telling a waiting run that something happened.
 *
 * The other half of `await:`, and the same ability as opening a gate: an event
 * is what lets a held deployment through, which is approval wearing different
 * clothes. Idempotent on a key the sender chooses, because a sender that does
 * not hear the answer sends again.
 */
route.post('/repos/workflow-runs/event', 'Actions/Workflow/SendRunEventAction').middleware('auth')
/*
 * And the other approval: letting a fork's pull request run at all.
 *
 * A different question from opening a deployment gate, and the same ability -
 * stopping a run is safe, starting a stranger's code is not.
 */
route.post('/repos/workflow-runs/approve-fork', 'Actions/Workflow/ApproveForkRunAction').middleware('auth')

/*
 * Deployment environments and their rules.
 *
 * Deliberately not in the workflow file: a rule a workflow author can edit is
 * a rule they can remove on the afternoon they are in a hurry. The file says
 * where a job deploys, and this says what that costs.
 */
route.post('/repos/environments', 'Actions/Workflow/EnvironmentsAction').middleware('auth')

/*
 * Variables at four levels, and where each effective value came from.
 *
 * The listing is the reason it exists: a value can be wrong at a level nobody
 * is looking at, and "it is us-east-1" is not the answer somebody needs then.
 */
route.post('/repos/variables', 'Actions/Workflow/VariablesAction').middleware('auth')

/*
 * Who hears about a run, and when. A rule set rather than a switch: a
 * repository-wide "notify me" is an inbox nobody reads by the second week.
 */
route.post('/repos/workflow-notifications', 'Actions/Workflow/NotificationRulesAction').middleware('auth')

/*
 * What was put where. This instance never deploys anything: a job does, with
 * credentials the environment released to it, and records what happened here.
 * A preview is the same row with a pull request on it, which is what makes it
 * expire when the pull request does.
 */
route.post('/repos/deployments', 'Actions/Deploy/DeploymentsAction').middleware('auth')

/*
 * Secrets: set, removed, and listed by name.
 *
 * There is deliberately no endpoint that returns a value. A reveal button is
 * the feature that turns one compromised session into every credential an
 * organization has, and its absence costs somebody a trip to their password
 * manager on the day they need the value back.
 */
route.post('/repos/secrets', 'Actions/Workflow/SecretsAction').middleware('auth')

/*
 * Workflow templates an owner publishes, and applying one as a real commit.
 *
 * The governance side of reuse: a reusable workflow is called by a repository
 * that decided to call it, and a template is what an organization puts in front
 * of every repository that has not decided anything yet.
 */
route.post('/repos/workflow-templates', 'Actions/Workflow/WorkflowTemplatesAction').middleware('auth')

/*
 * Test intelligence: results from this instance's CI, or from anybody else's.
 *
 * Ingestion takes `check:report`, the ability a CI integration already needs to
 * say a commit passed - reporting *which* tests passed is the same act at a
 * finer grain, and a second scope would mean every existing integration asking
 * for one more permission to tell you more.
 */
/*
 * Reading the test intelligence: suites, runs, executions, and what this
 * instance believes about each test. A page is not an API - a release script
 * that refuses to ship while a suite is red had to scrape HTML.
 */
route.get('/repos/tests', 'Actions/Tests/ReadTestsAction')

route.post('/repos/tests/ingest', 'Actions/Tests/IngestTestsAction').middleware('auth')
route.post('/repos/tests/manage', 'Actions/Tests/ManageTestAction').middleware('auth')

/*
 * And the reason to report timings in the first place: a POST because the
 * client sends its file list, not because it changes anything. It reads
 * history and answers a question.
 */
route.post('/repos/tests/split', 'Actions/Tests/SplitTestsAction').middleware('auth')

/*
 * Rules that watch a suite over time.
 *
 * A monitor fires on the *transition* and nothing else, which is the whole
 * difference between a rule and a saved query: a condition that is true every
 * hour would otherwise be an alarm every hour, and the channel it arrives on is
 * the one that has to work the day it matters.
 */
route.post('/repos/tests/monitors', 'Actions/Tests/MonitorTestsAction').middleware('auth')

/**
 * The runner protocol.
 *
 * A machine an operator registered, not a person: authenticated by the runner's
 * own bearer credential, and `skipCsrf` because CSRF defends a browser carrying
 * a session cookie and there is no browser and no cookie here. Leaving the
 * check on would only mean a runner could never call these at all.
 *
 * Nothing on this surface executes anything. It hands out a description of work
 * and records what came back - the executing is done on the operator's machine,
 * which is the whole decision in `docs/ci-threat-model.md`.
 */
route.post('/runner/claim', 'Actions/Runner/ClaimJobAction').skipCsrf()
route.post('/runner/heartbeat', 'Actions/Runner/HeartbeatAction').skipCsrf()
route.post('/runner/report', 'Actions/Runner/ReportJobAction').skipCsrf()
route.post('/runner/logs', 'Actions/Runner/AppendLogAction').skipCsrf()
route.post('/runner/artifacts', 'Actions/Runner/UploadArtifactAction').skipCsrf()
/*
 * The dependency cache: a snapshot of a workspace after its install.
 *
 * Neither of these takes a scope. A runner asks for a key and the instance
 * decides what that key resolves to for the run it is holding - its own
 * branch's snapshot, or the default branch's, and never a fork's. Letting a
 * runner choose would make a pull request the shortest path to running code on
 * the default branch, since a cache is a directory one run writes and another
 * executes out of.
 */
/*
 * What a workflow program calls when it calls `step()`.
 *
 * The control plane never evaluates repository code: a code-first workflow runs
 * as a job like any other untrusted work, and its calls come back here. The job
 * token is the scoping - it names one run, so there is no run identifier in the
 * request to get wrong.
 */
route.post('/runner/orchestrator', 'Actions/Runner/OrchestratorCallAction').skipCsrf()
route.post('/runner/orchestrator/result', 'Actions/Runner/OrchestratorResultAction').skipCsrf()
route.post('/runner/caches', 'Actions/Runner/SaveCacheAction').skipCsrf()
route.get('/runner/caches/restore', 'Actions/Runner/RestoreCacheAction')
// What a job's steps said about the code: `::error file=...,line=...::` becomes
// a check annotation, which is what the diff renders in the gutter.
route.post('/runner/annotations', 'Actions/Runner/AnnotateAction').skipCsrf()
/*
 * The values one run's jobs pass to each other.
 *
 * `action` is `get`, `set` or `list`; `if_version` makes a write a
 * compare-and-set, which is what stops two parallel jobs losing each other's
 * contribution. The run comes from the job token rather than from the request.
 */
route.post('/runner/metadata', 'Actions/Runner/MetadataAction')
/*
 * An artifact from earlier in the same run, by name.
 *
 * The reason most artifacts exist: a build produces a binary and a deploy needs
 * it. The run comes from the job token, so a runner cannot fetch another run's
 * output - which on a fork's pull request belongs to somebody else's commit.
 */
route.post('/runner/artifacts/fetch', 'Actions/Runner/FetchArtifactAction')
/*
 * A short-lived identity token for the job this runner holds.
 *
 * How a deploy stops needing a long-lived cloud key. Every claim comes from the
 * run rather than the request - the only thing a caller chooses is the audience
 * - and an untrusted run gets nothing at all.
 */
route.post('/runner/oidc', 'Actions/Runner/OidcTokenAction')
/*
 * Steps a job generated, added to its own run.
 *
 * The job token names the job, so an uploaded document never gets to say which
 * run it belongs to - which is what makes "an upload cannot raise its own trust
 * level" enforceable rather than promised.
 */
route.post('/runner/upload', 'Actions/Runner/UploadStepsAction').skipCsrf()

/*
 * Which tests this node should run, for a job on this instance's own runner.
 *
 * The job token again: a job that already holds a credential naming it should
 * not also have to carry a repository token, which would be stored as a secret,
 * rotated by somebody, and far broader than "read the timings for this suite".
 */
route.post('/runner/split', 'Actions/Runner/SplitTestsForJobAction').skipCsrf()

// Reading is the repository's permission, not the runner's: a log is the
// repository's data, and somebody who cannot see the code cannot see what
// building it printed.
route.get('/repos/workflow-runs/log', 'Actions/Workflow/ShowJobLogAction')

// The same rule for what a run produced. An artifact is built from a
// repository's code and often contains it, so a private repository's build
// output is as private as the repository - and there is no separate artifact
// permission, because a second permission that has to be kept in step with the
// first is one that eventually is not.
/*
 * The bytes of an image a job printed into its log. Narrow on purpose: it is
 * the one path that renders a build's output in place rather than handing it
 * over as an attachment, so the policy for that lives in one file.
 */
route.get('/repos/workflow-runs/log-image', 'Actions/Workflow/LogImageAction')

route.get('/repos/workflow-runs/artifacts', 'Actions/Workflow/ListArtifactsAction')
route.get('/repos/workflow-runs/artifact', 'Actions/Workflow/DownloadArtifactAction')
/*
 * Everything a run produced, as one file.
 *
 * A tar, uncompressed: artifacts are usually compressed already, and every
 * machine that runs CI has `tar`. One download rather than fourteen
 * right-clicks, which is what somebody collecting evidence from a failed run
 * actually wants.
 */
route.get('/repos/workflow-runs/artifacts/archive', 'Actions/Workflow/DownloadArtifactSetAction')
