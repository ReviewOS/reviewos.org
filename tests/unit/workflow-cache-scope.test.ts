// Who may read a cache, and who may write one.
//
// This is the one cache property that is a security boundary rather than an
// optimisation, and it is worth being blunt about why: a cache is a directory
// one run writes and another run executes out of. If a fork's pull request can
// put bytes where the default branch will later restore them, then opening a
// pull request is how you run code on the default branch - and every check that
// would have caught it is being run by the thing it was meant to catch.

import { describe, expect, test } from 'bun:test'
import { canRestore, canSave, defaultRef, readableScopes, writableScope } from '../../app/Actions/Workflow/cacheScope'

const main = { ref: 'refs/heads/main', defaultBranch: 'main', trusted: true }
const feature = { ref: 'refs/heads/feature', defaultBranch: 'main', trusted: true }
const fork = { ref: 'refs/pull/12/head', defaultBranch: 'main', trusted: false, pullRequestNumber: 12 }

describe('what a run may write', () => {
  test('a trusted run writes to its own ref, and only that', () => {
    expect(writableScope(feature)).toBe('refs/heads/feature')
    expect(canSave(feature, 'refs/heads/feature')).toBe(true)
    expect(canSave(feature, 'refs/heads/main')).toBe(false)
  })

  /**
   * The boundary. A fork run's scope is not a ref at all, so it cannot collide
   * with one by accident and cannot be mistaken for one by somebody reading a
   * row.
   */
  test('a fork run writes to a namespace of its own, never to a branch', () => {
    expect(writableScope(fork)).toBe('fork/12')
    expect(canSave(fork, 'refs/heads/main')).toBe(false)
    expect(canSave(fork, 'refs/pull/12/head')).toBe(false)
    expect(canSave(fork, 'fork/12')).toBe(true)
  })

  test('two pull requests from the same fork do not share a scope', () => {
    // Two people's code as often as one person's, and a shared scope between
    // them is the same poisoning problem one step further from anybody looking.
    expect(writableScope({ ...fork, pullRequestNumber: 13 })).toBe('fork/13')
  })

  test('a fork run with no pull request number lands somewhere nothing reads', () => {
    const orphan = writableScope({ ...fork, pullRequestNumber: null })

    expect(orphan).toBe('fork/unknown')
    expect(readableScopes(main)).not.toContain(orphan)
  })
})

describe('what a run may restore', () => {
  test('its own scope first, then the default branch', () => {
    expect(readableScopes(feature)).toEqual(['refs/heads/feature', 'refs/heads/main'])
  })

  test('a run on the default branch reads one scope, not the same one twice', () => {
    expect(readableScopes(main)).toEqual(['refs/heads/main'])
  })

  /**
   * Reading is allowed, and that is deliberate rather than an oversight: the
   * bytes in the default branch's cache came from code this repository already
   * trusts, and a pull request that cannot restore them is a pull request that
   * installs from scratch every time.
   */
  test('a fork run may restore the default branch, because reading is safe', () => {
    expect(canRestore(fork, 'refs/heads/main')).toBe(true)
    expect(readableScopes(fork)).toEqual(['fork/12', 'refs/heads/main'])
  })

  test('a protected branch never restores what a fork wrote', () => {
    expect(canRestore(main, 'fork/12')).toBe(false)
    expect(canRestore(feature, 'fork/12')).toBe(false)
  })

  test('one branch does not restore another branch', () => {
    // Not a trust rule - both are trusted. Two feature branches with different
    // lockfiles are the ordinary case, and a shared scope makes the second one
    // restore the first one's install and then build something wrong.
    expect(canRestore(feature, 'refs/heads/other')).toBe(false)
  })
})

describe('the default branch as a ref', () => {
  test('a short name becomes a full ref, and a full ref is left alone', () => {
    expect(defaultRef('main')).toBe('refs/heads/main')
    expect(defaultRef('refs/heads/trunk')).toBe('refs/heads/trunk')
    expect(defaultRef('')).toBe('refs/heads/main')
  })
})
