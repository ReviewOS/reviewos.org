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
