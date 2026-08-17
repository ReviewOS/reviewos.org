/**
 * Who can do what.
 *
 * This is the security boundary of the product, so it lives in one file with no
 * database access: every function here is a pure decision over values the
 * caller already loaded. That keeps it exhaustively testable, and it means a
 * new action cannot accidentally invent its own rule.
 *
 * Two ladders, deliberately separate:
 *
 *   repository  read < triage < write < maintain < admin
 *   organization  member < admin < owner
 *
 * They meet in `repositoryPermissionFor`, which takes the most permissive grant
 * a user has from any source. Access can only widen as you add teams or roles,
 * never narrow, which is the only rule that stays understandable once a user is
 * in four teams and an organization.
 */

export const REPOSITORY_LEVELS = ['read', 'triage', 'write', 'maintain', 'admin'] as const
export type RepositoryPermission = typeof REPOSITORY_LEVELS[number]

export const ORGANIZATION_ROLES = ['member', 'admin', 'owner'] as const
export type OrganizationRole = typeof ORGANIZATION_ROLES[number]

export type TeamRole = 'maintainer' | 'member'
export type RepositoryVisibility = 'public' | 'private' | 'internal'

/** What each repository action needs. */
export const REPOSITORY_ABILITIES = {
  'repository:read': 'read',
  'issue:comment': 'read',
  // Reacting sits with commenting, not with triage. It is the cheapest way to
  // say "me too" without writing a comment nobody wants to read, and anybody
  // held back from it writes the comment instead.
  'issue:react': 'read',
  'issue:open': 'read',
  // Attaching a screenshot is part of writing the report, and a screenshot is
  // usually the most useful thing in one. Reading an attachment needs no
  // ability of its own: it is `repository:read`, checked against the repository
  // the attachment belongs to.
  'attachment:upload': 'read',
  'pull:open': 'read',
  'pull:review': 'read',
  'issue:label': 'triage',
  'issue:assign': 'triage',
  'issue:milestone': 'triage',
  'issue:close': 'triage',
  // Locking ends a conversation for everyone else, so it sits with the other
  // triage powers rather than with editing.
  'issue:lock': 'triage',
  'pull:close': 'triage',
  'pull:request-review': 'triage',
  'repository:push': 'write',
  // Reporting facts about a commit - a check, a coverage report - is a
  // write, and phase 09 wants it separate from permission to push code: a
  // reporter that can only report cannot also rewrite history.
  'check:report': 'write',
  // Stopping a run is a separate power from reporting one. A CI integration
  // that publishes results has no business cancelling somebody's build, and a
  // person who can cancel one need not be able to report a passing check -
  // which is the more dangerous of the two, because it satisfies a branch
  // protection rule.
  'workflow:cancel': 'write',
  // Starting one by hand is write for the same reason as cancelling, and a
  // little more so: a `workflow_dispatch` run spends the instance's runners and
  // can touch anything the workflow can touch. Anybody who may *see* a workflow
  // is not therefore somebody who may run it.
  'workflow:dispatch': 'write',
  /*
   * Opening a gate is its own power, and the most consequential of the three.
   *
   * A `block:` job is what a deployment approval *is*: whoever opens it is
   * saying the change may go to production. Folding it into `workflow:cancel`
   * would mean anybody who can stop a build can also approve a release, which
   * is exactly backwards - stopping is safe and approving is not.
   */
  'workflow:approve': 'write',
  // Managing the label and milestone *sets* is a heavier power than applying
  // them: deleting a label strips it from every issue that carried it, and
  // deleting a milestone empties it. Applying one stays at triage above.
  'label:manage': 'write',
  'milestone:manage': 'write',
  'issue:edit-any': 'write',
  'pull:edit-any': 'write',
  'pull:dismiss-review': 'write',
  'pull:merge': 'write',
  'repository:settings': 'maintain',
  'branch:protect': 'maintain',
  'webhook:manage': 'maintain',
  'collaborator:manage': 'admin',
  'repository:delete': 'admin',
  'repository:transfer': 'admin',
} as const satisfies Record<string, RepositoryPermission>

export type RepositoryAbility = keyof typeof REPOSITORY_ABILITIES

/**
 * What is still allowed on an archived repository.
 *
 * Archived means readable and frozen: no push, no new issue, no comment on an
 * old one. Stating it as an allowlist rather than a denylist is the point - a
 * new ability added to the table above is frozen by default, and an ability
 * that should survive archiving has to be argued for here.
 *
 * Four survive. Reading, because that is what archiving is for. Settings,
 * because otherwise archiving is irreversible and nobody means that. Delete and
 * transfer, because the whole reason a repository is archived is that somebody
 * is deciding what to do with it, and both of those are answers.
 */
export const ARCHIVE_EXEMPT_ABILITIES = new Set<RepositoryAbility>([
  'repository:read',
  'repository:settings',
  'repository:delete',
  'repository:transfer',
])

export function allowedOnArchivedRepository(ability: RepositoryAbility): boolean {
  return ARCHIVE_EXEMPT_ABILITIES.has(ability)
}

/** What each organization action needs. */
export const ORGANIZATION_ABILITIES = {
  'members:view': 'member',
  'repositories:create': 'member',
  'teams:view': 'member',
  'members:manage': 'admin',
  'teams:manage': 'admin',
  'settings:manage': 'owner',
  'billing:manage': 'owner',
  'organization:delete': 'owner',
} as const satisfies Record<string, OrganizationRole>

export type OrganizationAbility = keyof typeof ORGANIZATION_ABILITIES

function repositoryRank(permission: RepositoryPermission): number {
  return REPOSITORY_LEVELS.indexOf(permission)
}

function organizationRank(role: OrganizationRole): number {
  return ORGANIZATION_ROLES.indexOf(role)
}

/** The more permissive of two repository permissions. */
export function highestRepositoryPermission(
  a: RepositoryPermission | null,
  b: RepositoryPermission | null,
): RepositoryPermission | null {
  if (!a)
    return b
  if (!b)
    return a
  return repositoryRank(a) >= repositoryRank(b) ? a : b
}

/** Whether `held` covers `required`. */
export function repositoryPermissionSatisfies(
  held: RepositoryPermission | null,
  required: RepositoryPermission,
): boolean {
  if (!held)
    return false

  const requiredRank = repositoryRank(required)

  // A level this module does not recognise is refused rather than allowed.
  // `repositoryRank` returns -1 for one, and every real permission outranks -1,
  // so the comparison below would have granted it to anybody holding anything.
  // Types are supposed to make that unreachable, and did not: an ability named
  // `repository:write` (the real one is `repository:push`) reached this from a
  // caller TypeScript was not checking, and read as granted.
  if (requiredRank < 0)
    return false

  return repositoryRank(held) >= requiredRank
}

/** Whether `held` covers `required`. */
export function organizationRoleSatisfies(held: OrganizationRole | null, required: OrganizationRole): boolean {
  // The same refusal as above, for the same reason.
  if (organizationRank(required) < 0)
    return false

  if (!held)
    return false
  return organizationRank(held) >= organizationRank(required)
}

/**
 * What an organization role grants on that organization's repositories.
 *
 * An owner or admin administers every repository the organization holds. A
 * plain member gets nothing implicitly: membership is not access, or every new
 * hire would silently gain write on everything.
 */
export function organizationRoleGrants(role: OrganizationRole | null): RepositoryPermission | null {
  if (role === 'owner' || role === 'admin')
    return 'admin'
  return null
}

export interface RepositoryAccessInput {
  /** Null for an anonymous request. */
  userId: number | null
  visibility: RepositoryVisibility
  /** The user who owns the repository, when an individual owns it. */
  ownerUserId?: number | null
  /** Whether the viewer is a member of the owning organization, and as what. */
  organizationRole?: OrganizationRole | null
  /** A direct grant on this repository. */
  collaboratorPermission?: RepositoryPermission | null
  /** Grants from every team the user belongs to that can reach this repository. */
  teamPermissions?: RepositoryPermission[]
  /** Site administrators can always read; they still need a grant to write. */
  isSiteAdmin?: boolean
}

/**
 * The permission a user holds on a repository, or null for no access at all.
 *
 * Order matters only in that everything is combined: the answer is the most
 * permissive of the owner, organization, collaborator, and team grants, plus a
 * baseline `read` when the repository is visible to the viewer.
 */
export function repositoryPermissionFor(input: RepositoryAccessInput): RepositoryPermission | null {
  const {
    userId,
    visibility,
    ownerUserId = null,
    organizationRole = null,
    collaboratorPermission = null,
    teamPermissions = [],
    isSiteAdmin = false,
  } = input

  // The owner of a personal repository administers it, always.
  if (userId !== null && ownerUserId !== null && userId === ownerUserId)
    return 'admin'

  let permission: RepositoryPermission | null = null

  if (visibility === 'public')
    permission = 'read'

  // `internal` means visible to anyone signed in, which is what it is for.
  if (visibility === 'internal' && userId !== null)
    permission = highestRepositoryPermission(permission, 'read')

  if (isSiteAdmin)
    permission = highestRepositoryPermission(permission, 'read')

  if (userId !== null) {
    permission = highestRepositoryPermission(permission, organizationRoleGrants(organizationRole))
    permission = highestRepositoryPermission(permission, collaboratorPermission)
    for (const team of teamPermissions)
      permission = highestRepositoryPermission(permission, team)
  }

  return permission
}

/** Whether a user may perform `ability` on a repository. */
export function canOnRepository(input: RepositoryAccessInput, ability: RepositoryAbility): boolean {
  // An anonymous visitor can read a public repository and do nothing else,
  // whatever the rest of the input says.
  if (input.userId === null && REPOSITORY_ABILITIES[ability] !== 'read')
    return false

  // An archived repository is readable but frozen. Callers pass visibility, so
  // this check belongs with the caller that knows the archive flag.
  return repositoryPermissionSatisfies(repositoryPermissionFor(input), REPOSITORY_ABILITIES[ability])
}

/** Whether a member may perform `ability` in an organization. */
export function canInOrganization(role: OrganizationRole | null, ability: OrganizationAbility): boolean {
  return organizationRoleSatisfies(role, ORGANIZATION_ABILITIES[ability])
}

/**
 * Whether removing or demoting this member would leave the organization with no
 * owner.
 *
 * An organization with no owner cannot be repaired from the interface: nobody
 * can add one. Both the remove and the role-change action ask this first.
 */
export function wouldOrphanOrganization(input: {
  memberRole: OrganizationRole
  /** Owners in the organization, including this member. */
  ownerCount: number
  /** The role after the change, or null when the member is being removed. */
  nextRole: OrganizationRole | null
}): boolean {
  if (input.memberRole !== 'owner')
    return false
  if (input.nextRole === 'owner')
    return false
  return input.ownerCount <= 1
}
