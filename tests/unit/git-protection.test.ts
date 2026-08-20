// Whether a push may land, decided before git writes the ref.
//
// Receive time is the only moment where refusing is worth anything. Once the
// ref is written the old commits are unreachable and everybody who fetches has
// the rewritten history - "this branch was force pushed" is a notification,
// refusing it is a protection. So these rules are pure and exhaustively tested,
// including the cases nobody wants to reproduce against a real repository.

import { describe, expect, test } from 'bun:test'
import { allowsUpdate, branchMatches, decidePush, rulesFor } from '../../app/Actions/Git/protection'
import { parseRefUpdate, ZERO_SHA } from '../../app/Actions/Git/push'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const move = (branch: string) => parseRefUpdate(`${A} ${B} refs/heads/${branch}`)!
const remove = (branch: string) => parseRefUpdate(`${A} ${ZERO_SHA} refs/heads/${branch}`)!
const create = (branch: string) => parseRefUpdate(`${ZERO_SHA} ${B} refs/heads/${branch}`)!
const tag = (name: string) => parseRefUpdate(`${A} ${B} refs/tags/${name}`)!

const locked = { pattern: 'main' }

describe('branchMatches', () => {
  test('matches a literal name', () => {
    expect(branchMatches('main', 'main')).toBe(true)
    expect(branchMatches('main', 'develop')).toBe(false)
  })

  test('a single star stays inside one path segment', () => {
    expect(branchMatches('release/*', 'release/1.0')).toBe(true)
    expect(branchMatches('release/*', 'release/1.0/hotfix')).toBe(false)
  })

  test('a double star crosses them', () => {
    expect(branchMatches('release/**', 'release/1.0/hotfix')).toBe(true)
    expect(branchMatches('**', 'anything/at/all')).toBe(true)
  })

  /**
   * A pattern language where `v1.0` also matches `v1x0` protects the wrong
   * branch, and does it silently.
   */
  test('a dot is a dot, not a wildcard', () => {
    expect(branchMatches('v1.0', 'v1x0')).toBe(false)
    expect(branchMatches('v1.0', 'v1.0')).toBe(true)
  })

  test('regular expression syntax in a pattern is literal', () => {
    expect(branchMatches('feat(ure)', 'feature')).toBe(false)
    expect(branchMatches('a+b', 'aab')).toBe(false)
    expect(branchMatches('a+b', 'a+b')).toBe(true)
  })
})

describe('rulesFor', () => {
  test('finds every rule that covers a branch', () => {
    const rules = [{ pattern: 'main' }, { pattern: '*' }, { pattern: 'develop' }]

    expect(rulesFor(rules, 'main')).toHaveLength(2)
    expect(rulesFor(rules, 'topic')).toHaveLength(1)
  })
})

describe('allowsUpdate', () => {
  test('lets an ordinary push through', () => {
    expect(allowsUpdate([locked], move('main'), false)).toEqual({ ok: true })
  })

  test('lets anything through on a branch nothing covers', () => {
    expect(allowsUpdate([locked], move('topic'), true)).toEqual({ ok: true })
    expect(allowsUpdate([], remove('main'), false)).toEqual({ ok: true })
  })

  test('refuses to delete a protected branch, and says which', () => {
    const decision = allowsUpdate([locked], remove('main'), false)

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('main')
    expect(decision.reason).toContain('cannot be deleted')
  })

  test('refuses a force push, and says which', () => {
    const decision = allowsUpdate([locked], move('main'), true)

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('cannot be force pushed')
  })

  test('allows both when the rule says so', () => {
    const open = { pattern: 'main', allow_force_push: true, allow_deletion: true }

    expect(allowsUpdate([open], move('main'), true).ok).toBe(true)
    expect(allowsUpdate([open], remove('main'), false).ok).toBe(true)
  })

  /**
   * Two patterns covering one branch is ordinary - `main` and `*`. Taking the
   * permissive answer would mean adding a broad rule quietly weakens a narrow
   * one, which is the opposite of what somebody adding a rule expects.
   */
  test('the most restrictive matching rule wins', () => {
    const rules = [{ pattern: '*', allow_force_push: true }, { pattern: 'main', allow_force_push: false }]

    expect(allowsUpdate(rules, move('main'), true).ok).toBe(false)
    expect(allowsUpdate(rules, move('topic'), true).ok).toBe(true)
  })

  test('creating a protected branch is not a force push', () => {
    expect(allowsUpdate([locked], create('main'), false).ok).toBe(true)
  })

  /** A tag is a name for a commit, not a line of history. */
  test('leaves tags alone', () => {
    expect(allowsUpdate([{ pattern: '**' }], tag('v1.0.0'), true).ok).toBe(true)
  })
})

describe('decidePush', () => {
  test('passes a push where everything is allowed', () => {
    const decision = decidePush([locked], [
      { update: move('topic'), isForced: true },
      { update: move('main'), isForced: false },
    ])

    expect(decision).toEqual({ ok: true, refused: [] })
  })

  /**
   * Every update is judged, not just the first. A report that stops at the
   * first problem makes the pusher push again to discover the next one.
   */
  test('reports every refusal rather than the first', () => {
    const decision = decidePush([{ pattern: '*' }], [
      { update: remove('main'), isForced: false },
      { update: move('develop'), isForced: true },
    ])

    expect(decision.ok).toBe(false)
    expect(decision.refused.map(one => one.ref))
      .toEqual(['refs/heads/main', 'refs/heads/develop'])
  })
})

/**
 * A mirrored repository refuses pushes to the refs it tracks.
 *
 * The failure this prevents is silent and total: the next sync is a
 * `git fetch --prune` that rewrites these refs to match upstream, so a commit
 * pushed here does not join the repository - it disappears within the hour with
 * nothing recording why. Refusing at receive time is the only moment the pusher
 * can be told, and losing somebody's work quietly is worse than refusing it.
 */
describe('a mirrored repository', () => {
  const mirrored = { mirror: { enabled: true, allow_local_pushes: false } }

  test('refuses a push to a mirrored branch', () => {
    const decision = decidePush([], [{ update: move('main'), isForced: false }], mirrored)

    expect(decision.ok).toBe(false)
    // The reason says what will happen rather than "forbidden", because the
    // pusher's next question is why, and "it would be overwritten" answers it.
    expect(decision.refused[0].reason).toContain('overwritten by the next sync')
  })

  test('and a tag, which a sync rewrites too', () => {
    expect(decidePush([], [{ update: tag('v1.0'), isForced: false }], mirrored).ok).toBe(false)
  })

  test('allows it once somebody has said so deliberately', () => {
    // A real choice with a real cost: the repository then has two sources of
    // truth for the same refs and the sync picks one without asking.
    const allowed = { mirror: { enabled: true, allow_local_pushes: true } }

    expect(decidePush([], [{ update: move('main'), isForced: false }], allowed).ok).toBe(true)
  })

  test('and does not refuse when the mirror is switched off', () => {
    const off = { mirror: { enabled: false, allow_local_pushes: false } }

    expect(decidePush([], [{ update: move('main'), isForced: false }], off).ok).toBe(true)
  })

  test('leaves an ordinary repository alone', () => {
    // The default argument, which is what every existing caller passes.
    expect(decidePush([], [{ update: move('main'), isForced: false }]).ok).toBe(true)
  })

  test('reports the mirror rather than the branch rule when both would refuse', () => {
    /*
     * Being told "main is protected" on a repository where no push can survive
     * would send somebody to ask for a permission that would not help them.
     */
    const locked = { pattern: 'main', allow_force_push: false, allow_deletion: false }
    const decision = decidePush([locked], [{ update: remove('main'), isForced: false }], mirrored)

    expect(decision.refused[0].reason).toContain('overwritten by the next sync')
  })
})

/**
 * Who may write to the branch at all.
 *
 * Unlike deletion and force push, this covers an ordinary fast-forward too:
 * "only the release team lands on `release/*`" is a statement about people, and
 * a rule that let anybody append to the branch would not be one.
 */
describe('allowsUpdate: restricted branches', () => {
  const restricted = [{ pattern: 'main', push_restrictions: '{"users":["ada"],"teams":["platform"]}' }]

  const ada = { userId: 1, handle: 'ada', isAdmin: false, teams: [] as string[] }
  const grace = { userId: 2, handle: 'grace', isAdmin: false, teams: ['platform'] }
  const mallory = { userId: 3, handle: 'mallory', isAdmin: false, teams: ['design'] }

  test('a named user may push', () => {
    expect(allowsUpdate(restricted, move('main'), false, ada).ok).toBe(true)
  })

  test('a member of a named team may push', () => {
    expect(allowsUpdate(restricted, move('main'), false, grace).ok).toBe(true)
  })

  test('anybody else is refused, by name', () => {
    const decision = allowsUpdate(restricted, move('main'), false, mallory)

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('mallory')
  })

  /**
   * Fails closed, and this is the one rule in the file that does.
   *
   * Everywhere else, guessing wrong means a protection that does not apply for
   * a moment. Here it would mean "anybody whose identity we could not read may
   * write to the release branch", which is not a weakened protection but the
   * absence of one.
   */
  test('a pusher with no identity is refused', () => {
    expect(allowsUpdate(restricted, move('main'), false, null).ok).toBe(false)
    expect(allowsUpdate(restricted, move('main'), false).ok).toBe(false)
  })

  test('an unrestricted rule lets anybody with push access through', () => {
    expect(allowsUpdate([{ pattern: 'main' }], move('main'), false, mallory).ok).toBe(true)
    expect(allowsUpdate([{ pattern: 'main', push_restrictions: '' }], move('main'), false, null).ok).toBe(true)
  })

  /**
   * A restriction that will not parse is read as no restriction, which is the
   * opposite of how an unreadable required-check list is read - and the reason
   * is the direction each one fails in. An unreadable allowlist read as
   * "nobody" would lock every writer out of the branch, including whoever would
   * fix the row.
   */
  test('an unreadable restriction does not lock the branch', () => {
    const broken = [{ pattern: 'main', push_restrictions: '{not json' }]

    expect(allowsUpdate(broken, move('main'), false, mallory).ok).toBe(true)
  })

  test('the restriction is reported before the force push, being the broader refusal', () => {
    const both = [{ pattern: 'main', push_restrictions: '{"users":["ada"],"teams":[]}' }]
    const decision = allowsUpdate(both, move('main'), true, mallory)

    expect(decision.reason).toContain('restricted')
  })

  test('tags are not branches, so a restriction does not reach them', () => {
    expect(allowsUpdate(restricted, tag('v1.0'), false, mallory).ok).toBe(true)
  })
})

/**
 * Whether a rule binds the people who could remove it.
 *
 * The default is bound. That is the opposite of GitHub's default and is
 * deliberate: every rule written before the column existed reads as bound, so
 * the migration cannot hand an exemption to anybody.
 */
describe('allowsUpdate: enforce_admins', () => {
  const admin = { userId: 1, handle: 'ada', isAdmin: true, teams: [] as string[] }
  const writer = { userId: 2, handle: 'grace', isAdmin: false, teams: [] as string[] }

  test('an admin is bound by a rule that says nothing about it', () => {
    expect(allowsUpdate([locked], remove('main'), false, admin).ok).toBe(false)
    expect(allowsUpdate([{ ...locked, enforce_admins: true }], remove('main'), false, admin).ok).toBe(false)
  })

  test('turning it off lets an admin delete and force push', () => {
    const waived = [{ ...locked, enforce_admins: false }]

    expect(allowsUpdate(waived, remove('main'), false, admin).ok).toBe(true)
    expect(allowsUpdate(waived, move('main'), true, admin).ok).toBe(true)
  })

  test('and past a restriction they are not named in', () => {
    const waived = [{ pattern: 'main', enforce_admins: false, push_restrictions: '{"users":["grace"],"teams":[]}' }]

    expect(allowsUpdate(waived, move('main'), false, admin).ok).toBe(true)
  })

  test('the exemption is for admins, not for everybody', () => {
    const waived = [{ ...locked, enforce_admins: false }]

    expect(allowsUpdate(waived, remove('main'), false, writer).ok).toBe(false)
    expect(allowsUpdate(waived, remove('main'), false, null).ok).toBe(false)
  })

  /**
   * Every matching rule has to grant it, for the same reason the most
   * restrictive rule wins elsewhere: adding a broad `**` rule must not quietly
   * hand out an exemption on the narrow branch somebody protected on purpose.
   */
  test('one rule that still binds admins is enough to bind them', () => {
    const mixed = [
      { pattern: 'main', enforce_admins: false },
      { pattern: '**', enforce_admins: true },
    ]

    expect(allowsUpdate(mixed, remove('main'), false, admin).ok).toBe(false)
  })
})

describe('decidePush with an actor', () => {
  test('carries the actor to every update it judges', () => {
    const rules = [{ pattern: 'main', push_restrictions: '{"users":["ada"],"teams":[]}' }]
    const mallory = { userId: 3, handle: 'mallory', isAdmin: false, teams: [] as string[] }

    const judged = [
      { update: move('main'), isForced: false },
      { update: move('topic'), isForced: false },
    ]

    const decision = decidePush(rules, judged, { mirror: null }, mallory)

    expect(decision.ok).toBe(false)
    expect(decision.refused).toHaveLength(1)
    expect(decision.refused[0]!.ref).toBe('refs/heads/main')
  })
})

/**
 * The rules read a row, and a row's booleans depend on the engine.
 *
 * MySQL has no boolean type - `BOOLEAN` is a spelling of `TINYINT(1)` - so a
 * column Postgres hands back as `true` arrives as `1`, and `x === true` is
 * false of it. Two comparisons here were written that way, which on MySQL made
 * `allow_force_push` and `allow_deletion` unsettable: the branch refuses
 * whatever the row says. It fails in the safe direction, which is exactly why
 * nobody would have found it from a bug report.
 */
describe('reading a row on either engine', () => {
  test('1 and 0 mean what true and false mean', () => {
    expect(allowsUpdate([{ pattern: 'main', allow_force_push: 1 as any }], move('main'), true).ok).toBe(true)
    expect(allowsUpdate([{ pattern: 'main', allow_force_push: 0 as any }], move('main'), true).ok).toBe(false)

    expect(allowsUpdate([{ pattern: 'main', allow_deletion: 1 as any }], remove('main'), false).ok).toBe(true)
    expect(allowsUpdate([{ pattern: 'main', allow_deletion: 0 as any }], remove('main'), false).ok).toBe(false)
  })

  test('an admin exemption stored as 0 is still an exemption', () => {
    const admin = { userId: 1, handle: 'ada', isAdmin: true, teams: [] as string[] }

    expect(allowsUpdate([{ pattern: 'main', enforce_admins: 0 as any }], remove('main'), false, admin).ok).toBe(true)
    expect(allowsUpdate([{ pattern: 'main', enforce_admins: 1 as any }], remove('main'), false, admin).ok).toBe(false)
  })

  /** Null is a row written before the column existed. It is not an exemption. */
  test('a null flag is bound, not exempt', () => {
    const admin = { userId: 1, handle: 'ada', isAdmin: true, teams: [] as string[] }

    expect(allowsUpdate([{ pattern: 'main', enforce_admins: null }], remove('main'), false, admin).ok).toBe(false)
  })
})
