// Whether a page may render a repository.
//
// The pages had been deciding this by not asking: every repository-scoped view
// queried the table directly and rendered whatever came back, so a private
// repository's pull requests, issues and code were readable by anyone with the
// URL. The rule was never wrong, it was never consulted.

import { describe, expect, test } from 'bun:test'
import { type RepositoryAccessFacts, repositoryViewAccess } from '../../app/Actions/Repo/forView'

const NO_GRANTS = {
  collaboratorPermission: null,
  organizationRole: null,
  teamPermissions: [],
  isSiteAdmin: false,
} as const

const publicRepo: RepositoryAccessFacts = { visibility: 'public', owner_type: 'user', owner_id: 7 }
const privateRepo: RepositoryAccessFacts = { visibility: 'private', owner_type: 'user', owner_id: 7 }
const orgPrivate: RepositoryAccessFacts = { visibility: 'private', owner_type: 'organization', owner_id: 3 }

describe('repositoryViewAccess', () => {
  test('a stranger may read a public repository', () => {
    expect(repositoryViewAccess(publicRepo, null, { ...NO_GRANTS }).readable).toBe(true)
  })

  test('a stranger may not read a private one', () => {
    expect(repositoryViewAccess(privateRepo, null, { ...NO_GRANTS }).readable).toBe(false)
  })

  test('somebody signed in but unrelated may not read a private one', () => {
    expect(repositoryViewAccess(privateRepo, 99, { ...NO_GRANTS }).readable).toBe(false)
  })

  test('the owner may read their own private repository', () => {
    expect(repositoryViewAccess(privateRepo, 7, { ...NO_GRANTS }).readable).toBe(true)
  })

  test('a collaborator may read it', () => {
    const access = repositoryViewAccess(privateRepo, 99, { ...NO_GRANTS, collaboratorPermission: 'read' })

    expect(access.readable).toBe(true)
  })

  test('plain membership of the owning organization grants nothing on its own', () => {
    // Deliberate: access to an organization's private repository comes from a
    // collaborator or team grant, not from being in the organization. Owners
    // and admins are the exception, because they administer it.
    expect(repositoryViewAccess(orgPrivate, 99, { ...NO_GRANTS, organizationRole: 'member' }).readable).toBe(false)
    expect(repositoryViewAccess(orgPrivate, 99, { ...NO_GRANTS, organizationRole: 'owner' }).readable).toBe(true)
  })

  test('an organization member with a team grant may read it', () => {
    const access = repositoryViewAccess(orgPrivate, 99, {
      ...NO_GRANTS,
      organizationRole: 'member',
      teamPermissions: ['read'],
    })

    expect(access.readable).toBe(true)
  })

  test('the owner id of an organization repository is not read as a user id', () => {
    // User 3 is not the organization with id 3. Conflating them would hand a
    // stranger every repository owned by the organization whose id happens to
    // match their own user id.
    expect(repositoryViewAccess(orgPrivate, 3, { ...NO_GRANTS }).readable).toBe(false)
  })

  test('a site admin may read anything', () => {
    expect(repositoryViewAccess(privateRepo, 99, { ...NO_GRANTS, isSiteAdmin: true }).readable).toBe(true)
  })
})

describe('what a reader may do beyond reading', () => {
  test('reading a public repository does not imply pushing to it', () => {
    const access = repositoryViewAccess(publicRepo, null, { ...NO_GRANTS })

    expect(access.readable).toBe(true)
    expect(access.can('repository:push')).toBe(false)
  })

  test('a signed-in stranger cannot push to a public repository either', () => {
    expect(repositoryViewAccess(publicRepo, 99, { ...NO_GRANTS }).can('repository:push')).toBe(false)
  })

  test('an ability this module does not know is refused, not granted', () => {
    // It was granted. `repositoryRank` returns -1 for an unrecognised level and
    // every real permission outranks -1, so a misspelled ability read as
    // allowed to anybody holding anything. Found by writing `repository:write`
    // in this file, which is not an ability; the real one is `repository:push`.
    const access = repositoryViewAccess(publicRepo, 99, { ...NO_GRANTS, collaboratorPermission: 'admin' })

    expect(access.can('repository:write' as never)).toBe(false)
  })

  test('a collaborator with write access can write', () => {
    const access = repositoryViewAccess(publicRepo, 99, { ...NO_GRANTS, collaboratorPermission: 'write' })

    expect(access.can('repository:push')).toBe(true)
  })

  test('read access alone does not carry push', () => {
    const access = repositoryViewAccess(privateRepo, 99, { ...NO_GRANTS, collaboratorPermission: 'read' })

    expect(access.readable).toBe(true)
    expect(access.can('repository:push')).toBe(false)
  })

  test('a team grant counts the same as a direct one', () => {
    const access = repositoryViewAccess(orgPrivate, 99, { ...NO_GRANTS, teamPermissions: ['write'] })

    expect(access.readable).toBe(true)
    expect(access.can('repository:push')).toBe(true)
  })
})
