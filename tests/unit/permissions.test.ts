// The permission ladders.
//
// This is the security boundary of the product, so the matrix is covered
// exhaustively rather than representatively: a hole here is somebody reading a
// private repository, and a hole is exactly what a "representative" test misses.

import { describe, expect, test } from 'bun:test'
import {
  allowedOnArchivedRepository,
  canInOrganization,
  canOnRepository,
  highestRepositoryPermission,
  ORGANIZATION_ROLES,
  organizationRoleGrants,
  organizationRoleSatisfies,
  REPOSITORY_ABILITIES,
  REPOSITORY_LEVELS,
  repositoryPermissionFor,
  repositoryPermissionSatisfies,
  wouldOrphanOrganization,
} from '../../app/Permissions'

describe('repository ladder', () => {
  test('every level satisfies itself and everything below it', () => {
    REPOSITORY_LEVELS.forEach((held, heldIndex) => {
      REPOSITORY_LEVELS.forEach((required, requiredIndex) => {
        expect(repositoryPermissionSatisfies(held, required)).toBe(heldIndex >= requiredIndex)
      })
    })
  })

  test('no permission satisfies nothing', () => {
    for (const required of REPOSITORY_LEVELS)
      expect(repositoryPermissionSatisfies(null, required)).toBe(false)
  })

  test('the higher of two permissions wins, in either order', () => {
    expect(highestRepositoryPermission('read', 'admin')).toBe('admin')
    expect(highestRepositoryPermission('admin', 'read')).toBe('admin')
    expect(highestRepositoryPermission('write', 'triage')).toBe('write')
    expect(highestRepositoryPermission(null, 'read')).toBe('read')
    expect(highestRepositoryPermission('read', null)).toBe('read')
    expect(highestRepositoryPermission(null, null)).toBeNull()
  })
})

describe('organization ladder', () => {
  test('every role satisfies itself and everything below it', () => {
    ORGANIZATION_ROLES.forEach((held, heldIndex) => {
      ORGANIZATION_ROLES.forEach((required, requiredIndex) => {
        expect(organizationRoleSatisfies(held, required)).toBe(heldIndex >= requiredIndex)
      })
    })
  })

  test('owners and admins administer the organization repositories', () => {
    expect(organizationRoleGrants('owner')).toBe('admin')
    expect(organizationRoleGrants('admin')).toBe('admin')
  })

  test('plain membership grants nothing on its own', () => {
    // Otherwise every new member silently gains access to every repository.
    expect(organizationRoleGrants('member')).toBeNull()
    expect(organizationRoleGrants(null)).toBeNull()
  })
})

describe('repositoryPermissionFor', () => {
  test('a public repository is readable by anyone, including anonymously', () => {
    expect(repositoryPermissionFor({ userId: null, visibility: 'public' })).toBe('read')
    expect(repositoryPermissionFor({ userId: 7, visibility: 'public' })).toBe('read')
  })

  test('a private repository is invisible without a grant', () => {
    expect(repositoryPermissionFor({ userId: null, visibility: 'private' })).toBeNull()
    expect(repositoryPermissionFor({ userId: 7, visibility: 'private' })).toBeNull()
  })

  test('an internal repository is readable by anyone signed in, and nobody else', () => {
    expect(repositoryPermissionFor({ userId: 7, visibility: 'internal' })).toBe('read')
    expect(repositoryPermissionFor({ userId: null, visibility: 'internal' })).toBeNull()
  })

  test('the owner of a personal repository administers it', () => {
    expect(repositoryPermissionFor({ userId: 7, visibility: 'private', ownerUserId: 7 })).toBe('admin')
  })

  test('somebody else is not the owner', () => {
    expect(repositoryPermissionFor({ userId: 8, visibility: 'private', ownerUserId: 7 })).toBeNull()
  })

  test('a collaborator grant applies to a private repository', () => {
    expect(repositoryPermissionFor({
      userId: 8,
      visibility: 'private',
      collaboratorPermission: 'write',
    })).toBe('write')
  })

  test('the most permissive grant wins across sources', () => {
    expect(repositoryPermissionFor({
      userId: 8,
      visibility: 'public',
      collaboratorPermission: 'triage',
      teamPermissions: ['write', 'read'],
    })).toBe('write')
  })

  test('a second team can only widen access, never narrow it', () => {
    const withOneTeam = repositoryPermissionFor({
      userId: 8,
      visibility: 'private',
      teamPermissions: ['maintain'],
    })
    const withTwoTeams = repositoryPermissionFor({
      userId: 8,
      visibility: 'private',
      teamPermissions: ['maintain', 'read'],
    })

    expect(withOneTeam).toBe('maintain')
    expect(withTwoTeams).toBe('maintain')
  })

  test('a site administrator can read but does not gain write', () => {
    const permission = repositoryPermissionFor({
      userId: 99,
      visibility: 'private',
      isSiteAdmin: true,
    })

    expect(permission).toBe('read')
    expect(repositoryPermissionSatisfies(permission, 'write')).toBe(false)
  })

  test('an anonymous viewer gains nothing from grants that name a user', () => {
    // Nothing should be able to attach a grant to a request with no user.
    expect(repositoryPermissionFor({
      userId: null,
      visibility: 'private',
      collaboratorPermission: 'admin',
      teamPermissions: ['admin'],
      organizationRole: 'owner',
    })).toBeNull()
  })
})

describe('canOnRepository', () => {
  test('reading a public repository needs no account', () => {
    expect(canOnRepository({ userId: null, visibility: 'public' }, 'repository:read')).toBe(true)
  })

  test('an anonymous visitor can never write, whatever else is passed', () => {
    expect(canOnRepository({
      userId: null,
      visibility: 'public',
      collaboratorPermission: 'admin',
    }, 'repository:push')).toBe(false)
  })

  test('read does not carry triage, write, or admin', () => {
    const reader = { userId: 8, visibility: 'public' as const }

    expect(canOnRepository(reader, 'issue:comment')).toBe(true)
    expect(canOnRepository(reader, 'issue:label')).toBe(false)
    expect(canOnRepository(reader, 'repository:push')).toBe(false)
    expect(canOnRepository(reader, 'repository:delete')).toBe(false)
  })

  test('triage can label and close but not push', () => {
    const triager = { userId: 8, visibility: 'public' as const, collaboratorPermission: 'triage' as const }

    expect(canOnRepository(triager, 'issue:label')).toBe(true)
    expect(canOnRepository(triager, 'issue:close')).toBe(true)
    expect(canOnRepository(triager, 'repository:push')).toBe(false)
  })

  test('write can push and merge but not change settings', () => {
    const writer = { userId: 8, visibility: 'public' as const, collaboratorPermission: 'write' as const }

    expect(canOnRepository(writer, 'repository:push')).toBe(true)
    expect(canOnRepository(writer, 'pull:merge')).toBe(true)
    expect(canOnRepository(writer, 'repository:settings')).toBe(false)
  })

  test('maintain can change settings but not delete', () => {
    const maintainer = { userId: 8, visibility: 'public' as const, collaboratorPermission: 'maintain' as const }

    expect(canOnRepository(maintainer, 'repository:settings')).toBe(true)
    expect(canOnRepository(maintainer, 'branch:protect')).toBe(true)
    expect(canOnRepository(maintainer, 'repository:delete')).toBe(false)
    expect(canOnRepository(maintainer, 'collaborator:manage')).toBe(false)
  })

  test('admin can do everything', () => {
    const admin = { userId: 8, visibility: 'private' as const, collaboratorPermission: 'admin' as const }

    expect(canOnRepository(admin, 'repository:delete')).toBe(true)
    expect(canOnRepository(admin, 'repository:transfer')).toBe(true)
    expect(canOnRepository(admin, 'collaborator:manage')).toBe(true)
  })
})

describe('canInOrganization', () => {
  test('a member can view and create but not manage', () => {
    expect(canInOrganization('member', 'members:view')).toBe(true)
    expect(canInOrganization('member', 'repositories:create')).toBe(true)
    expect(canInOrganization('member', 'members:manage')).toBe(false)
    expect(canInOrganization('member', 'billing:manage')).toBe(false)
  })

  test('an admin can manage members and teams but not billing or deletion', () => {
    expect(canInOrganization('admin', 'members:manage')).toBe(true)
    expect(canInOrganization('admin', 'teams:manage')).toBe(true)
    expect(canInOrganization('admin', 'billing:manage')).toBe(false)
    expect(canInOrganization('admin', 'organization:delete')).toBe(false)
  })

  test('an owner can do everything', () => {
    expect(canInOrganization('owner', 'billing:manage')).toBe(true)
    expect(canInOrganization('owner', 'organization:delete')).toBe(true)
  })

  test('a non-member can do nothing', () => {
    expect(canInOrganization(null, 'members:view')).toBe(false)
  })
})

/**
 * Archiving, as an allowlist.
 *
 * The denylist version of this rule is the one that rots: somebody adds an
 * ability next year, nobody remembers this file exists, and an archived
 * repository quietly accepts the new kind of write. Stated as an allowlist, the
 * new ability is frozen by default and this test is what says so.
 */
describe('allowedOnArchivedRepository', () => {
  test('reading is what archiving is for', () => {
    expect(allowedOnArchivedRepository('repository:read')).toBe(true)
  })

  test('settings survive, or archiving would be irreversible', () => {
    expect(allowedOnArchivedRepository('repository:settings')).toBe(true)
  })

  test('deciding what to do with it survives', () => {
    expect(allowedOnArchivedRepository('repository:delete')).toBe(true)
    expect(allowedOnArchivedRepository('repository:transfer')).toBe(true)
  })

  test('every other ability is frozen', () => {
    const exempt = new Set(['repository:read', 'repository:settings', 'repository:delete', 'repository:transfer'])

    for (const ability of Object.keys(REPOSITORY_ABILITIES) as (keyof typeof REPOSITORY_ABILITIES)[]) {
      if (!exempt.has(ability))
        expect(allowedOnArchivedRepository(ability), ability).toBe(false)
    }
  })

  test('pushing, commenting and opening an issue are all refused', () => {
    expect(allowedOnArchivedRepository('repository:push')).toBe(false)
    expect(allowedOnArchivedRepository('issue:comment')).toBe(false)
    expect(allowedOnArchivedRepository('issue:open')).toBe(false)
    expect(allowedOnArchivedRepository('pull:merge')).toBe(false)
  })
})

describe('wouldOrphanOrganization', () => {
  test('removing the last owner is refused', () => {
    expect(wouldOrphanOrganization({ memberRole: 'owner', ownerCount: 1, nextRole: null })).toBe(true)
  })

  test('demoting the last owner is refused', () => {
    expect(wouldOrphanOrganization({ memberRole: 'owner', ownerCount: 1, nextRole: 'admin' })).toBe(true)
  })

  test('removing an owner when another remains is allowed', () => {
    expect(wouldOrphanOrganization({ memberRole: 'owner', ownerCount: 2, nextRole: null })).toBe(false)
  })

  test('an owner keeping the role is never orphaning', () => {
    expect(wouldOrphanOrganization({ memberRole: 'owner', ownerCount: 1, nextRole: 'owner' })).toBe(false)
  })

  test('removing a non-owner is never orphaning', () => {
    expect(wouldOrphanOrganization({ memberRole: 'admin', ownerCount: 1, nextRole: null })).toBe(false)
    expect(wouldOrphanOrganization({ memberRole: 'member', ownerCount: 1, nextRole: null })).toBe(false)
  })
})
