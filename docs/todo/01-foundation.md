# 01 - Foundation

Identity: who is using this, what they belong to, and how machines authenticate as them. Everything
in later phases hangs an owner or an author off these models.

Stacks ships `User` and `PersonalAccessToken` defaults. Override a default by creating the same path
under `app/Models/`; `./buddy publish:model User` copies it across as a starting point.

## Users

- [ ] `app/Models/User.ts` overriding the framework default: `handle` (unique, the URL segment),
      `name`, `email`, `bio`, `avatar_url`, `location`, `website`, `is_admin`
- [ ] Traits: `useAuth` with passkeys, `useUuid`, `useTimestamps`, `useSearch` on handle and name,
      `useSeeder`
- [ ] Handle validation: lowercase alphanumeric and hyphens, 1-39 characters, cannot collide with a
      reserved route segment (`explore`, `settings`, `new`, `login`, `register`, `docs`, `api`)
- [ ] `app/Actions/Auth/RegisterAction.ts`, `LoginAction.ts`, `LogoutAction.ts`, `MeAction.ts`
- [ ] `app/Actions/Profile/UpdateProfileAction.ts`, `UpdateAvatarAction.ts`
- [ ] Email verification, and password reset using the framework's token table
- [ ] `resources/views/[owner]/index.stx` - profile: repositories, activity, contribution summary
- [ ] `resources/views/settings/profile.stx`
- [ ] Tests: handle uniqueness, reserved handles, registration, login, session expiry

## Organizations

- [ ] `app/Models/Organization.ts`: `handle`, `name`, `description`, `avatar_url`, `website`,
      `billing_email`
- [ ] `app/Models/OrgMember.ts`: `organization_id`, `user_id`, `role` (owner, admin, member),
      `invited_by`, `joined_at`
- [ ] Handles share one namespace with users; one uniqueness check covers both
- [ ] `app/Actions/Org/CreateOrganizationAction.ts` - creates the organization and its owner
      membership atomically, cleaning up the organization row if the membership insert fails
- [ ] `app/Actions/Org/UpdateOrganizationAction.ts`, `DeleteOrganizationAction.ts`
- [ ] `app/Actions/Org/InviteMemberAction.ts`, `AcceptInviteAction.ts`, `RemoveMemberAction.ts`,
      `ChangeMemberRoleAction.ts`
- [ ] Transferring a repository between owners, including handle collision handling
- [ ] `resources/views/settings/organizations.stx`, `[owner]/people.stx`
- [ ] Tests: the last owner cannot be removed or demoted

## Teams

- [ ] `app/Models/Team.ts`: `organization_id`, `name`, `slug`, `description`, `parent_team_id`
- [ ] `app/Models/TeamMember.ts`: `team_id`, `user_id`, `role`
- [ ] Teams grant repository access as a unit; permission resolution is user, then team, then
      organization role, with the most permissive winning
- [ ] `app/Actions/Team/` - create, update, delete, add member, remove member
- [ ] Tests: nested team inheritance, and that a user in two teams gets the union of access

## Permissions

- [ ] `app/Permissions.ts`: repository permissions (read, triage, write, maintain, admin) and
      organization permissions (members:view, members:manage, repositories:create, settings:manage,
      billing:manage)
- [ ] `app/Middleware/OrgRole.ts` and `OrgCan.ts`, registered in `app/Middleware.ts` as `orgRole`
      and `orgCan:<permission>`
- [ ] `app/Gates.ts` entries for the checks that are not simple role comparisons
- [ ] One resolver every action calls, rather than permission logic inline per action
- [ ] Tests covering the full matrix. This is the security boundary of the product, so exhaustive
      beats representative.

## Machine credentials

- [ ] Personal access tokens using the framework model: scopes (repo:read, repo:write, repo:admin,
      user:read, admin), expiry, last-used tracking, revocation
- [ ] Token shown once at creation, stored hashed
- [ ] `app/Models/SshKey.ts`: `user_id`, `title`, `key_type`, `public_key`, `fingerprint`,
      `last_used_at`. Fingerprint unique across all users.
- [ ] Reject keys that are too weak, and duplicate keys already registered to another account
- [ ] `app/Models/GpgKey.ts` for commit signature verification (verification itself is phase 2)
- [ ] `app/Actions/Keys/` and `app/Actions/Tokens/` - list, create, revoke
- [ ] `resources/views/settings/keys.stx`, `settings/tokens.stx`
- [ ] Tests: a revoked token stops working immediately, expiry is enforced, scopes are honored

## Activity

- [ ] `app/Models/ActivityEvent.ts`: `actor_id`, `verb`, polymorphic subject, `repository_id`,
      `organization_id`, `is_public`, `created_at`
- [ ] Written by listeners on domain events rather than inline at each call site
- [ ] Composite index on `(actor_id, created_at)` and `(repository_id, created_at)`; the feed query
      is the one that will hurt first at scale
- [ ] `app/Actions/Feed/DashboardFeedAction.ts` - what the people and repositories you watch did
- [ ] `resources/components/ActivityFeed.stx`
