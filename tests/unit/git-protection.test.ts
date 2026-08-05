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
