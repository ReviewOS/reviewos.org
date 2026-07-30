import { canOnRepository, type RepositoryPermission, type RepositoryVisibility } from '../../Permissions'
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
  owner_type: 'user' | 'organization'
  owner_id: number
  visibility: RepositoryVisibility
  is_archived: boolean
  disk_path: string
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
    .select(['id', 'owner_type', 'owner_id', 'visibility', 'is_archived', 'disk_path'])
    .where('owner_type', '=', ownerType)
    .where('owner_id', '=', ownerId)
    .where('name', '=', name)
    .executeTakeFirst()

  if (!repository)
    return null

  return {
    id: Number(repository.id),
    owner_type: repository.owner_type as 'user' | 'organization',
    owner_id: Number(repository.owner_id),
    visibility: repository.visibility as RepositoryVisibility,
    is_archived: Boolean(repository.is_archived),
    disk_path: String(repository.disk_path),
  }
}

/**
 * Authenticate an HTTP basic header against a personal access token.
 *
 * Password login is deliberately not accepted over git: a password typed into a
 * git remote ends up in shell history, in `.git/config`, and in whatever
 * credential helper is installed. A token can be scoped and revoked.
 */
export async function userFromBasicAuth(header: string | null): Promise<number | null> {
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

  const token = decoded.slice(separator + 1)
  if (!token)
    return null

  const row = await db
    .selectFrom('personal_access_tokens')
    .select(['user_id'])
    .where('token', '=', token)
    .executeTakeFirst()

  return row ? Number(row.user_id) : null
}

/** The permissions a user holds on a repository, from every source. */
export async function permissionOn(repository: GitRepositoryRow, userId: number | null): Promise<{
  collaboratorPermission: RepositoryPermission | null
  organizationRole: 'owner' | 'admin' | 'member' | null
  teamPermissions: RepositoryPermission[]
  isSiteAdmin: boolean
}> {
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

  return {
    collaboratorPermission: (collaborator?.permission as RepositoryPermission | undefined) ?? null,
    organizationRole,
    teamPermissions: [],
    isSiteAdmin: Boolean(user?.is_admin),
  }
}

/** Whether this request may run this git service. */
export async function mayUseService(
  repository: GitRepositoryRow,
  userId: number | null,
  service: 'upload-pack' | 'receive-pack',
): Promise<boolean> {
  // An archived repository is readable and frozen. Refusing the push here means
  // the client is told, rather than the hook rejecting every ref one by one.
  if (service === 'receive-pack' && repository.is_archived)
    return false

  const grants = await permissionOn(repository, userId)

  return canOnRepository({
    userId,
    visibility: repository.visibility,
    ownerUserId: repository.owner_type === 'user' ? repository.owner_id : null,
    ...grants,
  }, service === 'upload-pack' ? 'repository:read' : 'repository:push')
}

/** Absolute path to a repository on disk, or null if it does not resolve. */
export function diskPathFor(owner: string, name: string): string | null {
  const resolved = repositoryPath(owner, name)
  return resolved.ok ? resolved.path! : null
}
