# 01 - Foundation

Identity: who is using this, what they belong to, and how machines authenticate as them. Everything
in later phases hangs an owner or an author off these models.

Stacks ships `User` and `PersonalAccessToken` defaults. Override a default by creating the same path
under `app/Models/`; `./buddy publish:model User` copies it across as a starting point.

## Users

- [x] `app/Models/User.ts` overriding the framework default: `handle` (unique, the URL segment),
      `name`, `email`, `bio`, `avatar_url`, `location`, `website`, `is_admin`
- [ ] Traits: `useAuth` with passkeys, `useUuid`, `useTimestamps`, `useSearch` on handle and name,
      `useSeeder`
- [x] Handle validation: lowercase alphanumeric and hyphens, 1-39 characters, cannot collide with a
      reserved route segment (`explore`, `settings`, `new`, `login`, `register`, `docs`, `api`)
- [ ] `app/Actions/Auth/RegisterAction.ts`, `LoginAction.ts`, `LogoutAction.ts`, `MeAction.ts`
- [ ] `app/Actions/Profile/UpdateProfileAction.ts`, `UpdateAvatarAction.ts`
- [ ] Email verification, and password reset using the framework's token table
- [ ] `resources/views/[owner]/index.stx` - profile: repositories, activity, contribution summary
- [ ] `resources/views/settings/profile.stx`
- [ ] Tests: handle uniqueness, reserved handles, registration, login, session expiry

## Organizations

- [x] `app/Models/Organization.ts`: `handle`, `name`, `description`, `avatar_url`, `website`,
      `billing_email`
- [x] `app/Models/OrgMember.ts`: `organization_id`, `user_id`, `role` (owner, admin, member),
      `invited_by`, `joined_at`
- [x] Handles share one namespace with users; one uniqueness check covers both
- [x] `app/Actions/Org/CreateOrganizationAction.ts` - creates the organization and its owner
      membership atomically, cleaning up the organization row if the membership insert fails
- [ ] `app/Actions/Org/UpdateOrganizationAction.ts`, `DeleteOrganizationAction.ts`
- [ ] `app/Actions/Org/InviteMemberAction.ts`, `AcceptInviteAction.ts`, `RemoveMemberAction.ts`,
      `ChangeMemberRoleAction.ts`
- [ ] Transferring a repository between owners, including handle collision handling
- [ ] `resources/views/settings/organizations.stx`, `[owner]/people.stx`
- [x] Tests: the last owner cannot be removed or demoted

## Teams

- [x] `app/Models/Team.ts`: `organization_id`, `name`, `slug`, `description`, `parent_team_id`
- [x] `app/Models/TeamMember.ts`: `team_id`, `user_id`, `role`
- [ ] Teams grant repository access as a unit; permission resolution is user, then team, then
      organization role, with the most permissive winning
- [ ] `app/Actions/Team/` - create, update, delete, add member, remove member
- [ ] Tests: nested team inheritance, and that a user in two teams gets the union of access

## Permissions

- [x] `app/Permissions.ts`: repository permissions (read, triage, write, maintain, admin) and
      organization permissions (members:view, members:manage, repositories:create, settings:manage,
      billing:manage)
- [ ] `app/Middleware/OrgRole.ts` and `OrgCan.ts`, registered in `app/Middleware.ts` as `orgRole`
      and `orgCan:<permission>`
- [ ] `app/Gates.ts` entries for the checks that are not simple role comparisons
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
- [ ] Rotation: issue a replacement with the same grants and a short overlap, so a token can be
      changed without a window where the old one is dead and the new one is not deployed

### Living with tokens

The half of this nobody builds, and the half that decides whether an instance is safe two years in.

- [ ] `settings/tokens.stx` lists tokens with what each one can actually do, in the same words as
      the permission checks, not as a scope string the reader has to decode
- [ ] Last used, from where, and against which repositories, so an unused token is visible as unused
- [ ] Expiry warnings by email before a token dies, because a token that expires silently in CI at
      2am teaches people to set no expiry at all
- [ ] Organization owners can list every token with access to their repositories, and revoke one.
      Optionally, tokens against an organization require owner approval before they work.
- [ ] Every token action lands in the audit log: created, used the first time, permission changed,
      revoked
- [ ] Machine accounts: an account that exists to hold tokens, owned by an organization, with no
      password and no session login. Better than a human account shared by a team, which is what
      happens when the product does not offer this.
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

- [ ] `app/Models/ActivityEvent.ts`: `actor_id`, `verb`, polymorphic subject, `repository_id`,
      `organization_id`, `is_public`, `created_at`
- [ ] Written by listeners on domain events rather than inline at each call site
- [ ] Composite index on `(actor_id, created_at)` and `(repository_id, created_at)`; the feed query
      is the one that will hurt first at scale
- [ ] `app/Actions/Feed/DashboardFeedAction.ts` - what the people and repositories you watch did
- [ ] `resources/components/ActivityFeed.stx`
