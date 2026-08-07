// What a token is allowed to do.
//
// The first block is the important one. It is the mechanical form of the rule
// the roadmap states in prose: every capability is grantable on a fine-grained
// token, because there is no second kind of token to fall back to. A capability
// that ships without a way to grant it fails here rather than being noticed
// later by somebody reaching for a credential that carries everything.

import { describe, expect, test } from 'bun:test'
import { ORGANIZATION_ABILITIES, REPOSITORY_ABILITIES } from '../../app/Permissions'
import {
  effectiveCan,
  levelFor,
  levelSatisfies,
  MAXIMUM_TOKEN_LIFETIME_MS,
  normalizeGrants,
  ORGANIZATION_ABILITY_SCOPES,
  REPOSITORY_ABILITY_SCOPES,
  resolveExpiry,
  tokenAllows,
  tokenAllowsInOrganization,
  tokenReaches,
  tokenState,
} from '../../app/TokenScopes'

describe('the permission surface is complete', () => {
  test('every repository ability is grantable on a token', () => {
    const missing = Object.keys(REPOSITORY_ABILITIES)
      .filter(ability => !(ability in REPOSITORY_ABILITY_SCOPES))

    expect(missing).toEqual([])
  })

  test('every organization ability is grantable on a token', () => {
    const missing = Object.keys(ORGANIZATION_ABILITIES)
      .filter(ability => !(ability in ORGANIZATION_ABILITY_SCOPES))

    expect(missing).toEqual([])
  })

  test('no scope mapping names an ability that does not exist', () => {
    // The other direction: a mapping left behind after an ability is renamed
    // grants nothing and hides the fact that the real ability is unmapped.
    const stale = Object.keys(REPOSITORY_ABILITY_SCOPES)
      .filter(ability => !(ability in REPOSITORY_ABILITIES))

    expect(stale).toEqual([])
  })

  test('a token granted everything can do everything a user can', () => {
    const everything = [
      { scope: 'contents' as const, level: 'admin' as const },
      { scope: 'issues' as const, level: 'admin' as const },
      { scope: 'pull_requests' as const, level: 'admin' as const },
      { scope: 'webhooks' as const, level: 'admin' as const },
      { scope: 'administration' as const, level: 'admin' as const },
      { scope: 'checks' as const, level: 'write' as const },
    ]

    for (const ability of Object.keys(REPOSITORY_ABILITIES) as Array<keyof typeof REPOSITORY_ABILITIES>)
      expect(tokenAllows(everything, ability)).toBe(true)
  })
})

describe('tokenAllows', () => {
  const readOnly = [{ scope: 'contents' as const, level: 'read' as const }]

  test('reading code needs contents at read', () => {
    expect(tokenAllows(readOnly, 'repository:read')).toBe(true)
  })

  test('pushing needs contents at write', () => {
    expect(tokenAllows(readOnly, 'repository:push')).toBe(false)
  })

  test('merging is a write to contents, not just to pull requests', () => {
    // A token that may open and review pull requests but not write code should
    // not be able to land one.
    const reviewer = [{ scope: 'pull_requests' as const, level: 'admin' as const }]

    expect(tokenAllows(reviewer, 'pull:review')).toBe(true)
    expect(tokenAllows(reviewer, 'pull:merge')).toBe(false)
  })

  test('a scope grants nothing outside itself', () => {
    const issuesOnly = [{ scope: 'issues' as const, level: 'admin' as const }]

    expect(tokenAllows(issuesOnly, 'issue:close')).toBe(true)
    expect(tokenAllows(issuesOnly, 'pull:close')).toBe(false)
    expect(tokenAllows(issuesOnly, 'repository:read')).toBe(false)
  })

  test('deleting a repository needs administration at admin, not write', () => {
    const settings = [{ scope: 'administration' as const, level: 'write' as const }]

    expect(tokenAllows(settings, 'repository:settings')).toBe(true)
    expect(tokenAllows(settings, 'repository:delete')).toBe(false)
  })

  test('no grants means no', () => {
    expect(tokenAllows([], 'repository:read')).toBe(false)
  })

  test('organization abilities are separate from repository ones', () => {
    const members = [{ scope: 'members' as const, level: 'write' as const }]

    expect(tokenAllowsInOrganization(members, 'members:manage')).toBe(true)
    expect(tokenAllowsInOrganization(members, 'billing:manage')).toBe(false)
  })
})

describe('levels', () => {
  test('a higher level covers a lower requirement', () => {
    expect(levelSatisfies('admin', 'read')).toBe(true)
    expect(levelSatisfies('read', 'admin')).toBe(false)
    expect(levelSatisfies(null, 'read')).toBe(false)
  })

  test('the most permissive duplicate wins', () => {
    const grants = [
      { scope: 'issues' as const, level: 'read' as const },
      { scope: 'issues' as const, level: 'write' as const },
    ]

    expect(levelFor(grants, 'issues')).toBe('write')
  })
})

describe('effectiveCan', () => {
  const grants = [{ scope: 'contents' as const, level: 'write' as const }]

  test('a token grant is an upper bound, never a widening', () => {
    // The user cannot push, so neither can their token, whatever it was granted.
    expect(effectiveCan({ grants, userCan: false }, 'repository:push')).toBe(false)
  })

  test('both sides have to agree', () => {
    expect(effectiveCan({ grants, userCan: true }, 'repository:push')).toBe(true)
    expect(effectiveCan({ grants: [], userCan: true }, 'repository:push')).toBe(false)
  })
})

describe('tokenReaches', () => {
  const repository = { id: 7, owner_type: 'organization' as const, owner_id: 3 }

  test('an all-repositories token reaches anything', () => {
    expect(tokenReaches({ selection: 'all' }, repository)).toBe(true)
  })

  test('an organization token reaches that organization only', () => {
    expect(tokenReaches({ selection: 'organization', organizationId: 3 }, repository)).toBe(true)
    expect(tokenReaches({ selection: 'organization', organizationId: 4 }, repository)).toBe(false)
  })

  test('an organization token does not reach a personal repository', () => {
    const personal = { id: 7, owner_type: 'user' as const, owner_id: 3 }

    expect(tokenReaches({ selection: 'organization', organizationId: 3 }, personal)).toBe(false)
  })

  test('a selected token reaches exactly what was listed', () => {
    expect(tokenReaches({ selection: 'selected', repositoryIds: [7, 9] }, repository)).toBe(true)
    expect(tokenReaches({ selection: 'selected', repositoryIds: [9] }, repository)).toBe(false)
  })

  test('a selected token with an empty list reaches nothing', () => {
    expect(tokenReaches({ selection: 'selected', repositoryIds: [] }, repository)).toBe(false)
  })
})

describe('tokenState', () => {
  const now = 1_700_000_000_000

  test('a token with time left is active', () => {
    expect(tokenState({ expiresAtMs: now + 1000, revokedAtMs: null }, now)).toBe('active')
  })

  test('an expired token is expired', () => {
    expect(tokenState({ expiresAtMs: now - 1, revokedAtMs: null }, now)).toBe('expired')
  })

  test('expiry is inclusive, so a token dies on the second it names', () => {
    expect(tokenState({ expiresAtMs: now, revokedAtMs: null }, now)).toBe('expired')
  })

  test('a revoked token reports revoked even after it would have expired', () => {
    // The fact somebody reading an audit log needs is that it was revoked.
    expect(tokenState({ expiresAtMs: now - 1000, revokedAtMs: now - 2000 }, now)).toBe('revoked')
  })

  test('a revocation scheduled in the future has not happened yet', () => {
    expect(tokenState({ expiresAtMs: null, revokedAtMs: now + 1000 }, now)).toBe('active')
  })
})

describe('resolveExpiry', () => {
  const now = 1_700_000_000_000

  test('no requested expiry gets the ninety day default', () => {
    const result = resolveExpiry(null, now)

    expect(result.ok && result.expiresAtMs).toBe(now + 90 * 24 * 60 * 60 * 1000)
  })

  test('an expiry in the past is refused', () => {
    expect(resolveExpiry(now - 1, now).ok).toBe(false)
  })

  test('an expiry beyond the instance maximum is refused', () => {
    expect(resolveExpiry(now + MAXIMUM_TOKEN_LIFETIME_MS + 1, now).ok).toBe(false)
  })

  test('an instance can lower the maximum', () => {
    const week = 7 * 24 * 60 * 60 * 1000

    expect(resolveExpiry(now + 2 * week, now, week).ok).toBe(false)
    expect(resolveExpiry(now + week, now, week).ok).toBe(true)
  })
})

describe('normalizeGrants', () => {
  test('an unknown scope is dropped rather than refused', () => {
    // A client built against a newer version still gets a working token, and
    // can tell from the response what it actually got.
    const grants = normalizeGrants([
      { scope: 'contents', level: 'read' },
      { scope: 'packages', level: 'read' },
    ])

    expect(grants).toEqual([{ scope: 'contents', level: 'read' }])
  })

  test('an unknown level is dropped', () => {
    expect(normalizeGrants([{ scope: 'contents', level: 'superuser' }])).toEqual([])
  })

  test('a repeated scope collapses to the most permissive', () => {
    const grants = normalizeGrants([
      { scope: 'issues', level: 'read' },
      { scope: 'issues', level: 'write' },
    ])

    expect(grants).toEqual([{ scope: 'issues', level: 'write' }])
  })

  test('the result is ordered, so two identical grants compare equal', () => {
    const one = normalizeGrants([{ scope: 'issues', level: 'read' }, { scope: 'contents', level: 'read' }])
    const two = normalizeGrants([{ scope: 'contents', level: 'read' }, { scope: 'issues', level: 'read' }])

    expect(one).toEqual(two)
  })
})
