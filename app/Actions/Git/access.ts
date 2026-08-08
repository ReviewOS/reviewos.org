import type { AuthenticatedToken } from '../Tokens/authenticate'
import { canOnRepository, type RepositoryPermission, type RepositoryVisibility } from '../../Permissions'
import { tokenAllows, tokenReaches } from '../../TokenScopes'
import { authenticateToken } from '../Tokens/authenticate'
import { effectiveTeamsFor, teamPermissionsOn } from '../Team/resolve'
import { repositoryPath } from './storage'

/**
 * Deciding whether a git request may proceed.
 *
 * The wire protocol has no session: a client sends HTTP basic auth with a
 * personal access token, or nothing at all. So this is separate from the
 * session-based checks the JSON API uses, even though both end at the same
 * permission functions.
 */

export interface GitRepositoryRow {
  id: number
  name: string
  owner_type: 'user' | 'organization'
  owner_id: number
  visibility: RepositoryVisibility
  is_archived: boolean
  default_branch: string
  disk_path: string
  /** Carried so a fork can inherit it. Never used by the wire protocol. */
  description: string
  /** The repository this one was forked from, when it was. */
  parent_id: number | null
  /**
   * The merge settings, carried because everything that merges reads its
   * repository through here. They were once left off this row, and the merge
   * action read `undefined` for all of them - which `allowedStrategies` and
   * `deleteOnMerge` treat as permissive, so the per-repository strategy
   * restrictions and delete-on-merge were configurable and silently inert.
   */
  allow_merge_commit: boolean | null
  allow_squash_merge: boolean | null
  allow_rebase_merge: boolean | null
  default_merge_strategy: string | null
  delete_branch_on_merge: boolean | null
  /**
   * Whether a machine account's approval counts toward required approvals.
   *
   * On this row for exactly the reason the comment above describes: the merge
   * action reads its repository through here, and a column left off reads as
   * `undefined`, which the approval rule would treat as "do not count" - the
   * safe direction, but silently inert for a repository that had opted in.
   */
  count_machine_approvals: boolean | null
}

/** Look up a repository by the owner handle and name in a git URL. */
export async function findRepositoryByPath(owner: string, name: string): Promise<GitRepositoryRow | null> {
  const ownerRow = await db.selectFrom('users').select(['id']).where('handle', '=', owner).executeTakeFirst()

  let ownerType: 'user' | 'organization' = 'user'
  let ownerId = ownerRow ? Number(ownerRow.id) : 0

  if (!ownerRow) {
    const org = await db.selectFrom('organizations').select(['id']).where('handle', '=', owner).executeTakeFirst()
    if (!org)
      return null
    ownerType = 'organization'
    ownerId = Number(org.id)
  }

  const repository = await db
    .selectFrom('repositories')
    .select([
      'id',
      'name',
      'owner_type',
      'owner_id',
      'visibility',
      'is_archived',
      'default_branch',
      'disk_path',
      'description',
      'parent_id',
      'allow_merge_commit',
      'allow_squash_merge',
      'allow_rebase_merge',
      'default_merge_strategy',
      'delete_branch_on_merge',
      'count_machine_approvals',
    ])
    .where('owner_type', '=', ownerType)
    .where('owner_id', '=', ownerId)
    .where('name', '=', name)
    .executeTakeFirst()

  if (!repository)
    return null

  return {
    id: Number(repository.id),
    name: String(repository.name),
    owner_type: repository.owner_type as 'user' | 'organization',
    owner_id: Number(repository.owner_id),
    visibility: repository.visibility as RepositoryVisibility,
    is_archived: Boolean(repository.is_archived),
    default_branch: String(repository.default_branch),
    disk_path: String(repository.disk_path),
    description: repository.description ? String(repository.description) : '',
    parent_id: repository.parent_id === null || repository.parent_id === undefined ? null : Number(repository.parent_id),
    // Nulls pass through: a row written before the columns existed reads as
    // allowing everything, and `allowedStrategies` knows that rule.
    allow_merge_commit: repository.allow_merge_commit ?? null,
    allow_squash_merge: repository.allow_squash_merge ?? null,
    allow_rebase_merge: repository.allow_rebase_merge ?? null,
    default_merge_strategy: repository.default_merge_strategy ? String(repository.default_merge_strategy) : null,
    delete_branch_on_merge: repository.delete_branch_on_merge ?? null,
    count_machine_approvals: repository.count_machine_approvals ?? null,
  }
}

/**
 * Authenticate an HTTP basic header against an access token.
 *
 * Password login is deliberately not accepted over git: a password typed into a
 * git remote ends up in shell history, in `.git/config`, and in whatever
 * credential helper is installed. A token can be scoped and revoked.
 *
 * Returns the token rather than only the user, because a token's own grants
 * decide whether it may fetch or push, and answering with a user id alone would
 * hand a read-only token push access as soon as its owner had it.
 */
export async function tokenFromBasicAuth(header: string | null): Promise<AuthenticatedToken | null> {
  if (!header?.startsWith('Basic '))
    return null

  let decoded: string
  try {
    decoded = atob(header.slice('Basic '.length))
  }
  catch {
    return null
  }

  const separator = decoded.indexOf(':')
  if (separator === -1)
    return null

  // git sends the token as the password, with any username. The username is
  // conventionally the handle or a placeholder and is not checked: the token
  // already names its owner, and treating the username as meaningful would let
  // a correct token fail for a cosmetic reason.
  const token = decoded.slice(separator + 1)
  if (!token)
    return null

  const result = await authenticateToken(token)

  return result.ok ? result.token : null
}

/** The user behind a basic auth header, when only the identity is needed. */
export async function userFromBasicAuth(header: string | null): Promise<number | null> {
  const token = await tokenFromBasicAuth(header)

  return token ? token.userId : null
}

/** Every grant a user holds on a repository, before they are combined. */
export interface RepositoryGrants {
  collaboratorPermission: RepositoryPermission | null
  organizationRole: 'owner' | 'admin' | 'member' | null
  teamPermissions: RepositoryPermission[]
  isSiteAdmin: boolean
}

/** The permissions a user holds on a repository, from every source. */
export async function permissionOn(repository: GitRepositoryRow, userId: number | null): Promise<RepositoryGrants> {
  if (userId === null)
    return { collaboratorPermission: null, organizationRole: null, teamPermissions: [], isSiteAdmin: false }

  const collaborator = await db
    .selectFrom('repo_collaborators')
    .select(['permission'])
    .where('repository_id', '=', repository.id)
    .where('user_id', '=', userId)
    .executeTakeFirst()

  let organizationRole: 'owner' | 'admin' | 'member' | null = null
  if (repository.owner_type === 'organization') {
    const membership = await db
      .selectFrom('org_members')
      .select(['role'])
      .where('organization_id', '=', repository.owner_id)
      .where('user_id', '=', userId)
      .executeTakeFirst()
    organizationRole = (membership?.role as 'owner' | 'admin' | 'member' | undefined) ?? null
  }

  const user = await db.selectFrom('users').select(['is_admin']).where('id', '=', userId).executeTakeFirst()

  /*
   * What this person's teams reach.
   *
   * This was hard-coded to `[]`. `repositoryPermissionFor` has always unioned
   * these into its answer, so the rule existed and the branch had never once
   * been reached with a value in it - a team was a list of names with no effect
   * on access at all.
   *
   * Teams are scoped to the organization that owns the repository. A team
   * elsewhere cannot grant anything here, and a personal repository has no
   * organization, so it has no team grants either.
   */
  const teamIds = repository.owner_type === 'organization'
    ? await effectiveTeamsFor(userId, Number(repository.owner_id))
    : []

  const teamPermissions = await teamPermissionsOn(Number(repository.id), teamIds)

  return {
    collaboratorPermission: (collaborator?.permission as RepositoryPermission | undefined) ?? null,
    organizationRole,
    teamPermissions,
    isSiteAdmin: Boolean(user?.is_admin),
  }
}

/**
 * Whether this request may run this git service.
 *
 * When a token authenticated the request, the answer is the intersection of what
 * its owner may do and what the token was granted. A token is an upper bound and
 * never a widening, so a read-only token belonging to a maintainer still cannot
 * push, and a token scoped to two repositories cannot touch a third.
 */
export async function mayUseService(
  repository: GitRepositoryRow,
  userId: number | null,
  service: 'upload-pack' | 'receive-pack',
  token?: AuthenticatedToken | null,
): Promise<boolean> {
  // An archived repository is readable and frozen. Refusing the push here means
  // the client is told, rather than the hook rejecting every ref one by one.
  if (service === 'receive-pack' && repository.is_archived)
    return false

  const ability = service === 'upload-pack' ? 'repository:read' : 'repository:push'

  if (token) {
    if (token.userId !== userId)
      return false

    if (!tokenReaches(token.reach, repository))
      return false

    if (!tokenAllows(token.grants, ability))
      return false
  }

  const grants = await permissionOn(repository, userId)

  return canOnRepository({
    userId,
    visibility: repository.visibility,
    ownerUserId: repository.owner_type === 'user' ? repository.owner_id : null,
    ...grants,
  }, ability)
}

/** Absolute path to a repository on disk, or null if it does not resolve. */
export function diskPathFor(owner: string, name: string): string | null {
  const resolved = repositoryPath(owner, name)
  return resolved.ok ? resolved.path! : null
}
