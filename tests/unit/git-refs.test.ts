// The ref ledger's rules.
//
// After phase 18c the database is the truth about where a repository's refs
// point, and a node whose disk disagrees is serving a stale cache. That makes
// two things worth pinning hard: what counts as an acceptable ref transaction
// at all, and what counts as divergence - because the second decides whether a
// node is quietly wrong, and the first is the guard in front of it.
//
// The compare-and-swap itself is exercised end to end in
// tests/e2e/git-wal-push.test.ts, where a real push moves a real ledger.

import { describe, expect, test } from 'bun:test'
import { acceptable, divergence, isCreation, isDeletion, ZERO_SHA } from '../../app/Actions/Git/refs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('isCreation and isDeletion', () => {
  test('the zero sha is what git means by absent, on either side', () => {
    expect(isCreation({ before: ZERO_SHA })).toBe(true)
    expect(isDeletion({ after: ZERO_SHA })).toBe(true)
    expect(isCreation({ before: A })).toBe(false)
    expect(isDeletion({ after: A })).toBe(false)
  })

  test('an empty string is treated as absent too, not as a sha', () => {
    expect(isCreation({ before: '' })).toBe(true)
    expect(isDeletion({ after: '' })).toBe(true)
  })
})

describe('acceptable', () => {
  test('takes the transactions a push actually produces', () => {
    expect(acceptable({ ref: 'refs/heads/main', before: A, after: B })).toBe(true)
    expect(acceptable({ ref: 'refs/heads/main', before: ZERO_SHA, after: B })).toBe(true)
    expect(acceptable({ ref: 'refs/tags/v1.0.0', before: A, after: ZERO_SHA })).toBe(true)
  })

  /**
   * Refused with a reason rather than turned into a conflict. A sha that is
   * not a sha is a bug or an attempt, and reporting it as "somebody else moved
   * the ref" would send whoever investigates in the wrong direction entirely.
   */
  test('refuses anything that is not a full sha on either side', () => {
    expect(acceptable({ ref: 'refs/heads/main', before: A, after: 'abc' })).toBe(false)
    expect(acceptable({ ref: 'refs/heads/main', before: 'HEAD', after: B })).toBe(false)
    expect(acceptable({ ref: 'refs/heads/main', before: A, after: `${B} extra` })).toBe(false)
  })

  test('refuses a ref name git would not accept', () => {
    expect(acceptable({ ref: 'main', before: A, after: B })).toBe(false)
    expect(acceptable({ ref: 'refs/heads/../../etc', before: A, after: B })).toBe(false)
    expect(acceptable({ ref: 'refs/heads/with space', before: A, after: B })).toBe(false)
  })
})

describe('divergence', () => {
  const ledger = [
    { ref: 'refs/heads/main', sha: A, sequence: 4 },
    { ref: 'refs/tags/v1', sha: B, sequence: 2 },
  ]

  test('agreement is no divergence', () => {
    const found = divergence(ledger, new Map([['refs/heads/main', A], ['refs/tags/v1', B]]))

    expect(found.stale).toEqual([])
    expect(found.extra).toEqual([])
  })

  test('a ref pointing somewhere else on disk is stale, with both values', () => {
    const found = divergence(ledger, new Map([['refs/heads/main', B], ['refs/tags/v1', B]]))

    expect(found.stale).toEqual([{ ref: 'refs/heads/main', ledger: A, disk: B }])
  })

  test('a ref the ledger has and disk does not is stale, not missing', () => {
    const found = divergence(ledger, new Map([['refs/tags/v1', B]]))

    expect(found.stale).toEqual([{ ref: 'refs/heads/main', ledger: A, disk: null }])
  })

  /**
   * The rule that keeps this from destroying data. A repository legitimately
   * carries refs no push created - notes, a mirror's remotes, a stash - and a
   * ledger that treated them as garbage would delete somebody's work to make
   * an index look tidy. They are reported, never acted on.
   */
  test('refs the ledger does not track are reported as extra, never as wrong', () => {
    const found = divergence(ledger, new Map([
      ['refs/heads/main', A],
      ['refs/tags/v1', B],
      ['refs/notes/commits', A],
      ['refs/stash', B],
    ]))

    expect(found.stale).toEqual([])
    expect(found.extra.map(entry => entry.ref).sort()).toEqual(['refs/notes/commits', 'refs/stash'])
  })

  test('an empty ledger diverges from nothing, so a fresh instance is quiet', () => {
    const found = divergence([], new Map([['refs/heads/main', A]]))

    expect(found.stale).toEqual([])
    expect(found.extra).toHaveLength(1)
  })
})
