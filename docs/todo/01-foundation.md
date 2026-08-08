# 01 - Foundation

Identity: who is using this, what they belong to, and how machines authenticate as them. Everything
in later phases hangs an owner or an author off these models.

Stacks ships `User` and `PersonalAccessToken` defaults. Override a default by creating the same path
under `app/Models/`; `./buddy publish:model User` copies it across as a starting point.

## Users

- [x] `app/Models/User.ts` overriding the framework default: `handle` (unique, the URL segment),
      `name`, `email`, `bio`, `avatar_url`, `location`, `website`, `is_admin`
- [x] Traits: `useAuth` with passkeys, `useUuid`, `useTimestamps`, `useSearch` on handle and name,
      `useSeeder`. All present on `app/Models/User.ts` and left unticked, which is the failure
      [the index](./index.md) opens by warning about
- [x] Handle validation: lowercase alphanumeric and hyphens, 1-39 characters, cannot collide with a
      reserved route segment (`explore`, `settings`, `new`, `login`, `register`, `docs`, `api`)
- [x] `app/Actions/Auth/RegisterAction.ts`, `LoginAction.ts`, `LogoutAction.ts`

  The framework ships all of these and they answer with JSON and set no cookie - right for an API
  client reading `access_token`, wrong for a form, because every page here identifies its reader
  from the session cookie. A browser shown JSON is a browser still signed out. So these override the
  defaults, and one endpoint serves both: an `Accept` of `text/html` gets a redirect and a cookie,
  anything else gets the token pack the framework's clients already expect.

  `MeAction` is deliberately not among them. Every page reads its viewer through
  `viewerFromCookies` on the server; an endpoint that answers "who am I" exists for a client that
  renders on its own, and this product does not have one. Adding it would be a second answer to a
  question already answered.

  **Registration asks for a handle**, because a handle is the URL segment rather than a profile
  field: `/{handle}` is the profile and the first segment of every repository under it. An account
  without one has no page, and picking it later means the page moves. It goes through
  `checkHandle`, so an account can never be created at a name that would shadow `/settings` or
  `/explore` - which would make part of the product unreachable and hand whoever registered it a
  page every reader trusts.

  The row is written here rather than through the framework's `register`, and only because
  `users.handle` is NOT NULL: `register` inserts without one and fails before there is a row to
  update. The **hash is still the framework's** `makeHash`, which is what `Auth.attempt` verifies
  against - the same implementation, not a second one.

  Login gives one answer for "no such account" and "wrong password". They are different facts and
  the same message, because distinguishing them turns the endpoint into a way to test whether an
  address is registered here, which is the first step of every credential-stuffing run.

  Logout **revokes the token** rather than only clearing the cookie. Clearing it leaves a live
  credential in a proxy log, a synced profile, a shared machine - and a shared machine is the reason
  anybody presses it. It revokes *that* token, not all of them: signing out at the office should not
  sign somebody out on their phone. POST rather than GET, because `<img src="/logout">` in a comment
  would sign every reader out.

  `next` accepts only a path on this host, including refusing `//evil.example` and a backslash. An
  open redirect on a sign-in page is the good one for an attacker: somebody is sent to their site in
  the second after typing a password, on a link that genuinely started here.
- [x] `app/Actions/Profile/UpdateProfileAction.ts`

  Only your own, and there is no parameter that could say otherwise. An endpoint that takes a user
  id and checks it against the caller is one where the check can be forgotten; one with no id
  cannot be.

  A website must start with `http` or `https`. The field is rendered as an anchor on a page every
  reader visits, and `javascript:` in that anchor is stored XSS with a form in front of it.

  `UpdateAvatarAction` is not built. Avatars need the storage decisions in phase 11 - where files
  live, what is served from disk versus S3, how a self-hosted instance without object storage
  behaves - and a profile without one is a profile; a half-wired upload is a broken page.
- [x] Email verification, and password reset using the framework's token table

  The token machinery is entirely `@stacksjs/auth`'s - hashing before storage, expiry, rotating an
  outstanding token, revoking every session on success, mailing a notice that the password changed.
  None of it is reimplemented. What is here is the browser: the framework's actions answer JSON, and
  a link clicked in a mail client is a browser, which has verified nothing as far as its reader can
  tell. `config/auth.ts` points both mail templates at these pages, since the framework's defaults
  are `/password/reset/{token}` and `/verify-email/{id}/{token}` - two URLs this product does not
  have, so the mail would have gone out pointing at a 404.

  **The reset request answers identically for an address with an account and one without**, and
  `/forgot-password` says so in those words so the flat answer reads as deliberate rather than as
  the page failing to notice. Reporting the difference turns a public form into a way to test who
  has an account here, which on a forge also answers "does this person work here". A send that
  throws is swallowed for the same reason: an unknown address and a dead mail transport must look
  identical from outside.

  Nobody is signed in as a side effect of either. Clicking a link in an email proves reaching a
  mailbox and nothing else, and a mailbox somebody else is reading is the case verification exists
  to notice. The reset deliberately leaves every session revoked, including this one: the usual
  reason to reset a password is that somebody else may have had it.

  Three upstream gaps came out of building it, all of the same shape - the framework shipping a
  feature and not the thing it needs:

  - `email_verifications` did not exist. `core/auth/src/email-verification.ts` had been writing to
    it since it was written, `password_resets` was created beside it, and this one never was, so the
    framework's own verification flow answered a 500 naming a relation nobody's code mentions. Fixed
    in Stacks 0.70.315.
  - `useRoute().query` was always `{}` on the boot a production server and the e2e suite use. It
    read a raw search string that only the dev server sets, while bun-router's file-based `serve()`
    supplies the query already parsed - the same way it supplies `params`, which the same function
    was already reading correctly. **Eleven pages here were reading a query string that was always
    empty**, silently: a page keyed on `?token=` rendered its no-token branch, which is a real
    branch that looks entirely right. Fixed in stx 0.2.159.
  - `.middleware(['auth', 'orgCan:…'])` pushed the array in whole and failed at boot with
    `input.split is not a function` from inside a case converter. Fixed in Stacks 0.70.314.
- [x] `resources/views/[owner]/index.stx` - profile: repositories, activity, contribution summary

  **Fourteen links in this product already pointed here and there was no page.** Every commit
  author, every issue author, every reviewer - all of them rendered `/{handle}` and all of them
  404'd. That is the whole reason this came ahead of anything prettier.

  One route for two kinds of owner, because a repository's URL does not distinguish them either:
  `acme/api` is the same shape whoever owns it, and a product where you must know which before you
  can link to somebody is one where people link to nothing.

  The contribution summary is three counts, not a year of coloured squares. A grid rewards showing
  up daily rather than doing anything, and on a self-hosted forge for one team it is mostly empty
  boxes.

  Private repositories and private activity show only to the owner. There is deliberately no middle
  case where a collaborator sees a colleague's private activity: a profile whose contents depend on
  a permission graph has a disclosure for its first bug.
- [x] `resources/views/settings/profile.stx`, and `login.stx` and `register.stx`

  Six pages linked to `/login` and there was no page there - the review queue, the inbox, three
  settings screens and the new-repository form all told a signed-out reader to sign in, at a URL
  that answered nothing.

  The profile form says what changing a handle costs at the point of changing it - it moves the page
  and every repository URL under it - rather than in a confirmation dialog people click through.
- [x] Tests: handle uniqueness, reserved handles, registration, login

  `tests/e2e/auth.test.ts` against the real routes, and `tests/unit/auth-session.test.ts` for the
  cookie flags - which are the whole security surface of being signed in and every one of which
  fails invisibly. A missing `HttpOnly` shows up when an injection reads the token; a wrongly-set
  `Secure` shows up as logging in appearing not to work.

  `SameSite=Lax` rather than `Strict`, and it is asserted so nobody "tightens" it: `Strict`
  withholds the cookie on a top-level navigation from another site, so following a link to a pull
  request from a chat message lands signed out, which reads as being logged out at random.

  Session expiry is not tested here. The token's life is the framework's, the cookie is set to match
  it, and a test that waits for one to lapse is a slow test asserting somebody else's clock.

- [x] **Every form in this product was refused for a first-time visitor.** Fixed in two places, and
      either half alone leaves it broken.

  The CSRF check is double-submit: a value from the request against the `X-CSRF-Token` cookie. Both
  halves of the seeding existed in the router and both hung off the *route handler* pipeline - one
  puts a token on the incoming request so a template can embed it, the other puts the matching
  cookie on the response. **A file-based view takes neither**, so a visitor who landed on `/login`,
  `/new` or a repository page got no cookie at all. Fixed in Stacks 0.70.312 by wrapping
  `handleRequest`, which is the only seam that sees a view: a middleware runs on the pipeline a view
  does not take, and the serve options are discarded because bun-router overwrites `fetch` with its
  own bound handler.

  `seedCsrfCookieIfMissing` also ignored the token it was handed and minted a fresh one, so even
  where both halves ran the page and the browser held different values - which fails exactly the way
  no token at all does.

  The second half was here. `CsrfField` read the token from `__stxServeContext`, which is
  **undefined under `route.serve()`**, and rendered an empty value. Every other view in this
  codebase already falls back to the raw `Cookie` header for that reason; this component was the one
  that did not.

  **It never showed up in a test, and that is the part worth remembering.** Every write in this suite
  authenticates with a bearer token, and a bearer bypasses the check by design - so a hundred tests
  passed while nobody could open an issue, create a repository, comment, or sign up.
  `tests/e2e/csrf-forms.test.ts` now does what none of them could: GET a page, keep the cookie, read
  the token out of the rendered HTML, and post the form. It also asserts that a missing or
  mismatched token is still refused, so a future "fix" cannot be to turn the check off.

  Third instance of the pattern in [the index](./index.md) under "A signed-in browser is not a
  signed-in test client". All three were found by opening a page rather than by running anything.

- [x] `app/Actions/Org/UpdateOrganizationAction.ts`, `DeleteOrganizationAction.ts`

  Deleting is **refused while the organization still owns a repository, and the repositories come
  back named**. A cascade there would take every repository and with them every issue, pull request
  and review anybody ever wrote - and a confirmation box does not make that safe, because the person
  clicking it is thinking about the organization, not about the seventeen repositories underneath
  it. They have to be transferred or deleted one at a time, each with its own confirmation and its
  own recoverable copy on disk. Slower on purpose. The refusal is a to-do list rather than a wall.

  The handle has to be typed back, exactly, for the same reason `DeleteRepositoryAction` asks: a
  misdirected click, a stale tab and a script pointed at the wrong organization all produce a
  correctly authorized request for the wrong thing, which is what the permission check cannot catch.

  Updating is gated on `settings:manage`, which the abilities table puts at owner. There is
  deliberately no lower rung for the profile fields - an organization's name is what every reader
  sees above its repositories, and an admin appointed to manage members has not been given that. A
  website must start with `http`, the same rule the user profile applies and for the same reason:
  the field renders as an anchor, and `javascript:` in one is stored XSS with a form in front of it.
- [x] `app/Actions/Org/InviteMemberAction.ts`, `AcceptInviteAction.ts`, `RemoveMemberAction.ts`,
      `ChangeMemberRoleAction.ts`

  **A pending invitation is now a real thing, and it grants nothing.** It is an `org_members` row
  carrying the role it will have with a null `joined_at`, and `organizationRoleOf` answers null
  until that fills in. The filter lives there rather than at each call site because there are dozens
  of those and one of them will be written without it; that function is the only thing in the
  codebase that turns a membership row into an answer about what somebody may do. Before this,
  inviting somebody *was* adding them - the action wrote `joined_at` immediately, so the access the
  invitation offered arrived at the moment it was offered.

  `organizationOwnerCount` counts accepted owners only, or the last real owner could demote
  themselves on the strength of an invitee who never arrives.

  Accepting takes no id but the organization's, so there is no parameter that could accept on
  somebody else's behalf. Accepting twice is success, not a conflict: the usual way to reach it is a
  second click on a notification still sitting in the inbox.
- [x] Transferring a repository between owners, including handle collision handling

  Built with the rest of `app/Actions/Repo/TransferRepositoryAction.ts` and left unticked. Two
  permissions rather than one - admin on the repository is the right to give it away, and the right
  to receive it belongs to the target - and `decideTransfer` refuses a name already taken there
  rather than picking a silent answer.
- [x] `resources/views/settings/organizations.stx`, `[owner]/people.stx`

  Invitations are in the same list as the organizations, marked, rather than in a section of their
  own: the unanswered thing is what the reader came for, and the notification points here.

  The people page is **not public**. Somebody outside the organization gets the same answer they
  would get for an organization that does not exist, because a page saying "you cannot see this" has
  already confirmed the interesting half, and a membership list is a target list.

  While building these it turned out **six settings pages existed and nothing in the chrome pointed
  at any of them** - profile, keys, tokens, notifications, and the two new ones, reachable only by
  typing the URL. The same failure as fourteen links to a profile page that did not exist, from the
  other end. `SettingsLink` puts one item in the header for somebody signed in, and `SettingsNav`
  links the pages to each other.
- [x] Tests: the last owner cannot be removed or demoted, and `tests/e2e/organizations.test.ts` for
      the invitation, the pages and the two deletes that refuse

## Teams

- [x] `app/Models/Team.ts`: `organization_id`, `name`, `slug`, `description`, `parent_team_id`
- [x] `app/Models/TeamMember.ts`: `team_id`, `user_id`, `role`
- [x] `app/Models/TeamRepository.ts`: the grant itself, `team_id` + `repository_id` + `permission`.
      Its absence was why the rule below read as done and was not: `permissionOn` passed an empty
      array for team permissions because there was no table for a team to be granted anything from,
      so the team branch of the resolver had never once been reached with a value in it
- [x] Teams grant repository access as a unit; permission resolution is user, then team, then
      organization role, with the most permissive winning
- [x] `app/Actions/Team/` - create, update, delete, add member, remove member
- [x] Inheritance runs downward - a child team gets what its parent was granted, and the parent gets
      nothing from the child. `app/Actions/Team/resolve.ts` walks the chain with a visited set,
      because `parent_team_id` is a plain column and two writes can close a loop; walking that
      without one is an infinite loop inside a permission check
- [x] Cascades on `team_members` and `teams`. `team_members.team_id` had a foreign key without one,
      so a team that had members could not be deleted at all - which made the delete operation in
      `ManageTeamAction` broken in production, not only in the test that found it
- [x] Tests: nested team inheritance, and that a user in two teams gets the union of access
      (`tests/unit/team-resolve.test.ts` against literals, `tests/e2e/team-access.test.ts` through
      the database and the real resolver)

## Permissions

- [x] `app/Permissions.ts`: repository permissions (read, triage, write, maintain, admin) and
      organization permissions (members:view, members:manage, repositories:create, settings:manage,
      billing:manage)
- [x] `app/Middleware/OrgRole.ts` and `OrgCan.ts`, registered in `app/Middleware.ts` as `orgRole`
      and `orgCan:<permission>`

  `orgCan:<ability>` is the one to reach for, and the organization routes use it. It names what the
  endpoint is *for*, so when a rung moves in `ORGANIZATION_ABILITIES` - and that is a table
  precisely so it can - every route named by ability follows, while every route named by role has
  to be found and edited. `orgRole:<role>` is ranked rather than matched, so `orgRole:admin` admits
  an owner; comparing for equality would lock owners out of every admin endpoint, which is the kind
  of bug that gets fixed by giving somebody two rows.

  **Both are a convenience, not the boundary.** Every action behind them checks again, because a
  route registered without the middleware would otherwise be unguarded and look exactly like one
  that is. What they buy is the failure arriving before the action loads anything, and a route file
  that says what it requires.

  A request that names no organization is refused rather than waved through: a gate whose subject is
  missing has not passed, it has failed to run. An unknown ability is a 500 rather than a 403, since
  a typo in a route file is a server fault and should not send somebody looking at their own
  permissions.
- [x] `app/Gates.ts` entries for the checks that are not simple role comparisons

  Deliberately thin, and each one delegates. Every rule that decides access is a pure function in
  `app/Permissions.ts` and the actions call it directly; a gate that re-derived one would be a
  second place that decides, and the one that disagrees quietly is the one that ships. So what is
  there is the questions that are not role comparisons - would this leave an organization with no
  owner, does this ability survive the repository being archived - each with a name and no logic.

  The framework's default `access-admin` gate checked whether the email ends in a particular domain.
  On a self-hosted forge that means whoever controls the mail domain in `.env` controls the
  instance, and that anybody who can register an address there administers it. It reads `is_admin`
  now.
- [x] One resolver every action calls, rather than permission logic inline per action
- [x] Tests covering the full matrix. This is the security boundary of the product, so exhaustive
      beats representative.

## Access tokens

There is one kind of token here, and it is fine-grained.

GitHub has two, and the split is worth naming because it is the reason this section is written the
way it is. Some permissions there can only be granted by a classic token, and `packages:read` is the
one people hit: read a package from a script or an agent and the fine-grained token cannot express
it, so you fall back to a classic token that carries every scope on the account, across every
repository, with no per-resource selection. The narrow path is the one that does not work, so the
wide one gets used. That is a security hole produced by a gap in a permission list.

So the rule for this codebase, and it is a rule rather than a preference:

- [x] **The permission surface is complete.** Every capability the product exposes is grantable on a
      fine-grained token, at the narrowest level that expresses it. A capability that ships without
      a matching token permission is not finished, and there is no second token type to escape into.
      `packages:read` is the worked example: if a registry ever lands (it is on the deferred list in
      the index), its permissions are fine-grained from the first commit or it does not land.
- [x] The rule is mechanical, not cultural: `app/TokenScopes.ts` maps every ability to a scope and a
      level with `satisfies Record<RepositoryAbility, ...>`, so an unmapped ability fails the build,
      and a test restates it in the words of the rule and checks the reverse direction too (a
      mapping left behind after a rename grants nothing and hides the real gap)

### Model

- [x] `app/Models/AccessToken.ts`: `user_id`, `name`, `prefix`, `token_hash`, `expires_at`,
      `last_used_at`, `last_used_ip`, `revoked_at`, `revoked_by_id`, and the resource selection:
      every repository the user can reach, every repository in one organization, or a chosen list
      held in `AccessTokenRepository`
- [x] `app/Models/AccessTokenPermission.ts`: one row per granted permission. Rows rather than a
      bitfield or a comma-joined string, so adding one is an insert and not a migration over every
      token ever issued.
- [x] Permissions reuse the vocabulary in `app/Permissions.ts` instead of inventing a second one. A
      token grant is an upper bound on what the user could already do, never a widening: the
      effective permission is the intersection of the token's grant and the user's own access,
      recomputed per request (`authenticate.ts`, `effectiveCan`), so removing someone from a
      repository revokes their token there too and revoking a token stops it on the next request.
- [x] Token shown once at creation, stored as a SHA-256 hash. The prefix stays in cleartext (`ros_`
      plus a short public id) so a leaked token is identifiable in a log, revocable without
      guessing, and findable by an indexed read rather than a scan that hashes every row.
- [x] Expiry required. No unlimited option, a maximum an instance can lower, and a default of 90
      days.
- [x] `app/Actions/Tokens/` and `GET`/`POST`/`DELETE /api/user/tokens`. Unknown scopes are dropped
      rather than refused, and the response says what was actually recorded, so a client built
      against a newer instance still gets a working token and can see what it got.
- [x] Rotation: issue a replacement with the same grants and a short overlap, so a token can be
      changed without a window where the old one is dead and the new one is not deployed

### Living with tokens

The half of this nobody builds, and the half that decides whether an instance is safe two years in.

- [x] `settings/tokens.stx` lists tokens with what each one can actually do, in the same words as
      the permission checks, not as a scope string the reader has to decode
- [x] Last used, from where, and against which repositories, so an unused token is visible as unused
- [x] Expiry warnings by email before a token dies, because a token that expires silently in CI at
      2am teaches people to set no expiry at all
- [x] Organization owners can list every token with access to their repositories, and revoke one.

  `/api/orgs/tokens`, and the hard part is the third case. A token reaches an organization by being
  scoped to it, by being scoped to one of its repositories, **or by being scoped to nothing in
  particular while its owner happens to be a member** - and that last one is what gets missed,
  because nothing joins it to the organization. The link is the membership, not a row about the
  token. A listing built by querying the token tables finds the first two and reports a clean answer
  that is wrong, which is worse than not having the page.

  `/{owner}/tokens` is the page, owner-only and refusing with a 404 for the same reason the people
  page does. It leads with the two counts worth acting on: how many tokens were never scoped to this
  organization at all, and how many nobody has ever used.

  Revocation goes through the same endpoint an owner uses on their own token, so there is one place
  that decides what revoking means. An organization administrator may stop a token that reaches
  them and no other, and the refusal is a 404 rather than a 403 so token ids cannot be enumerated by
  an administrator of anywhere.

  Owner approval before an organization token works is **not** built, and the roadmap said
  "optionally". It is the feature that turns every new contributor's first day into a ticket, and
  the listing above answers the same question after the fact without that cost. Reconsider if
  somebody asks for it.
- [x] Every token action lands in the audit log: created, used the first time, revoked

  `app/Actions/Tokens/audit.ts`, one wrapper rather than three call sites building their own rows -
  an audit log is worth exactly as much as its consistency. **The secret is never in it in any
  form**: not the token, not a truncated token, not a hash. A log is the thing most likely to be
  shipped somewhere central and read by people who are not administrators.

  The first use is an event and every use after it is a column. A token's first use is the moment it
  stopped being a string in a clipboard and became a credential in something, which is often the
  only record of *where* it went; a log with a row per clone is a log nobody reads.

  There is deliberately no `permissions-changed`. A token's grants cannot be edited in place here -
  the path is to rotate - because a token whose abilities change under a client is a token that
  starts failing at 3am for a reason nobody connects to a settings page. A rotation records
  `token:created` on the replacement carrying `replaces`. An event nothing can emit would leave a
  reader believing the log answers a question it never will.
- [x] Machine accounts: an account that exists to hold tokens, owned by an organization, with no
      password and no session login.

  **Not signing in is enforced by the password, not by a flag.** The row gets a hash of 64 random
  bytes generated at creation, never returned and never written down, so `Auth.attempt` fails for it
  through the code that already exists rather than through a branch somebody could forget to add to
  a new sign-in path. A flag checked in one of three entry points is how these become back doors.
  The address is under `.invalid`, reserved by RFC 2606, so a password reset - the one route back
  into an account with no way in - cannot be delivered either.

  It joins its organization at `member`, which grants no repository access on its own. Whatever it
  should reach is granted deliberately, like anybody else: a machine that can read everything by
  existing is the shared account again with a better name.

  It appears in its own section of the people page rather than among the people, because it is not
  one - mixed in it reads as a colleague who never logs in, and every count on the page is then
  wrong. Its tokens are issued *for* it by somebody who administers its organization, because it
  cannot ask for one itself. Narrow on purpose - only a machine account, only for its own organization, only by
  an administrator of that organization - since relaxing any of the three turns it into a general
  "issue a token as another user".

  Three more missing cascades came out of testing this, all the same shape as the team ones:
  `access_token_permissions` and `access_token_repositories` had no rule onto `access_tokens`, so a
  token could not be deleted at all. `audit_events.actor_id` is now `SET NULL` rather than a
  cascade, which is the interesting one: deleting the audit trail along with the account is
  precisely backwards, since the records that matter most are the ones about somebody who is gone.
- [x] A per-request resolver that validates the token, checks expiry and revocation, intersects with
      live access, and records the use. Recording is not awaited on the critical path: an unused
      token being visible as unused is worth a write, but not worth failing a clone over.
- [x] Tests: the stored form never contains the secret, a truncated or tampered token is rejected
      before any query, the cleartext prefix authenticates nothing on its own, a revoked token
      reports revoked even after it would have expired, and a grant cannot widen what its owner can
      do
- [x] Tests against the database rather than the rules: a revoked token stops working on the very
      next request, and losing repository access revokes the token's reach into it

## Keys

- [x] `app/Models/SshKey.ts`: `user_id`, `title`, `key_type`, `public_key`, `fingerprint`,
      `last_used_at`. Fingerprint unique across all users.
- [x] Reject keys that are too weak, and duplicate keys already registered to another account.
      `app/Actions/Keys/ssh.ts` holds the policy - which types, how small an RSA key may be, and
      what to tell somebody who pasted a private key - and `ts-ssh` reads the format
- [x] `app/Models/GpgKey.ts` for commit signature verification (verification itself is phase 2)
- [x] Reading a pasted GPG key, in `app/Actions/Keys/gpg.ts`. **gpg reads it, this does not** - the
      same rule the signature work follows, and it runs against a throwaway `GNUPGHOME` every time
      because `show-only` does not import but gpg still writes a trustdb wherever it is pointed.
      What is left is policy: a key with no address on it is refused, because the address is what
      ties a signature to a commit's author and storing one only produces "Unverified" later with
      no explanation; expired and revoked keys likewise; a private key is refused by name
- [x] `app/Actions/Keys/` - list, create, revoke, for both kinds
- [x] `resources/views/settings/keys.stx`, which the clone box and the commit page both link to and
      which until now did not exist. Nobody could clone over SSH or earn a verified badge, because
      there was nowhere to register the key that makes either work
- [x] The public key body is never sent to the page. It is public, so nothing leaks by it - but six
      keys listed in full is unreadable, and the fingerprint is what a person compares against what
      `ssh-keygen -l` prints
- [x] **Clicking it found an stx bug.** Both sections carried `x-data="{ adding: false }"`, and stx
      assigned scope ids by matching the state expression, so two elements with identical state
      shared one scope: opening the SSH form opened the GPG one, and only the first was ever
      initialised. Fixed upstream by assigning positionally, released in stx 0.2.156; the names
      here are distinct anyway, so the page never depended on that fix
- [x] Deploy keys: a key scoped to one repository, read-only by default, for the case where a token
      is the wrong shape. `app/Models/DeployKey.ts` has no `user_id` on purpose - a deploy key
      authenticates as the *repository's*, so there is no account to intersect with and nothing to
      inherit. The row cascades with the repository rather than the application remembering to
      remove it
- [x] **One fingerprint, one identity.** The SSH transport picks who is connecting from the
      fingerprint alone - there is nothing else on the wire - so a fingerprint matching both an
      account key and a deploy key would make "who pushed this" depend on which query ran first.
      A key already registered to an account is refused, and so is one already deployed elsewhere;
      the database enforces uniqueness within `deploy_keys` and `app/Actions/Keys/deploy.ts`
      enforces the half that spans two tables. Both refusals name the fix, because it is one
      `ssh-keygen` away
- [x] `identifyKey` in `app/Actions/Git/ssh.ts` returns a person or a repository's key, and the
      authorisation branches on which. **A deploy key must not go through `mayUseService`**: that
      function answers what an *account* may do, has no account here, and would fall through to the
      anonymous answer - which for a public repository is "yes, read", quietly making every deploy
      key a key to every public repository on the instance. `tests/e2e/git-ssh.test.ts` clones the
      private repository with a deploy key and is refused the public one, which is the assertion
      that would have caught it
- [x] Read-only is the default and holds: a read-only key is refused `receive-pack`, one granted
      write pushes, and neither reaches another repository. Checked by breaking `deployKeyMay` and
      watching both cases fail
- [x] `last_used_at`, written without being awaited and never allowed to fail a clone. The only way
      to tell a key doing a job from one added for a machine that no longer exists
- [x] On the repository's settings page, behind `repository:settings` - the same gate as renaming or
      deleting it, because standing access to a repository is not a smaller thing than either

## Activity

- [x] `app/Models/ActivityEvent.ts`: `actor_id`, `verb`, polymorphic subject, `repository_id`,
      `organization_id`, `is_public`, `created_at`

  Distinct from a notification, and the difference is who it is for. A notification is addressed -
  it exists because *you* should know. An event is a matter of record: it exists because it
  happened, and who may read it is decided at query time. Conflating them is why forges end up with
  feeds that read like somebody else's inbox.

  **`is_public` is written, not derived.** Deriving it would mean a repository going private
  retroactively erases its history from the people who were there, and a repository going *public*
  retroactively exposes activity from when it was not. Only one of those is ever noticed.

  `repository_id` and `organization_id` are denormalized beside the polymorphic subject, because
  the feed asks "what happened in the repositories I watch" and answering through the subject would
  need a union across every subject table on every page load.
- [x] Written by listeners on domain events rather than inline at each call site

  `RecordActivity`, the third listener on the same nine events beside `Notify` and
  `DispatchWebhooks`. Separate for the reason those two are separate from each other: they answer
  different questions and fail differently, and the record is the one that should survive the other
  two being misconfigured.

  `review:requested` is deliberately not among its events. Asking somebody for a review is a
  message to that person, and a feed listing it reports who is behind on what to anybody who
  scrolls.
- [x] Composite index on `(actor_id, created_at)` and `(repository_id, created_at)`; the feed query
      is the one that will hurt first at scale

  Both end on `created_at`, which is the part that matters. An index on `actor_id` alone lets
  Postgres find the rows and then sort them - on a prolific account, reading every event they ever
  produced to return twenty. Ending on the ordered column turns that into a range scan that stops.

  Both feeds are keyset paginated rather than offset paginated for the same reason: `OFFSET 2000`
  reads and discards two thousand rows to return twenty, and a feed is the one page people actually
  page through.
- [x] `app/Actions/Feed/DashboardFeedAction.ts` - what the repositories you watch did

  `all`, not every row in `watches`. `participating` means "tell me about threads I am in", which
  the inbox already does, and `ignore` is an explicit no - treating either as watching fills a
  dashboard with the repositories somebody deliberately turned down.

  **A watch row outlives access.** Somebody watches a private repository as a collaborator, is
  removed from it, and the row stays - nothing deletes it and nothing should, because access is
  often restored. So the watched set is filtered through `permissionOn` before the feed query, once
  per request rather than per row, and through the same resolver the git wire uses. A second
  implementation of "may this person read this" is how a feed ends up more generous than the
  repository page.

  A reader watching nothing gets their own activity rather than an empty page. "Following people" is
  deliberately not a thing here, and a feed built on a relationship the product does not have is a
  feed that is always empty.
- [x] `resources/components/ActivityFeed.stx`

  The third rendering of the same nine events, and deliberately separate from the other two. A
  notification says "chris requested your review" - second person, because it is addressed to you. A
  webhook payload is a contract another program parses. A feed says "chris opened acme/api#12" -
  third person, about somebody else. Merging them makes the notification's "your" a lie the moment
  a bystander reads it.

  A row naming a verb this version does not know renders as nothing rather than as an error. A feed
  that refused to load because one row named a verb a later deploy removed is one a single revert
  can take down.
