// Where Gitea and Forgejo differ from GitHub, and where they do not.
//
// The importer treats them as one API shape, which is very nearly true and
// dangerous where it is not. An importer written as though they were identical
// works against whatever fixture it was built with and then loses data on a
// real instance - and that is the worst outcome available, because the
// migration looks like it worked.
//
// So each difference is asserted rather than assumed.

import { describe, expect, test } from 'bun:test'
import { apiBase, FORGES, forgeFor, pullNumber } from '../../app/Actions/Import/forges'

describe('the number a pull request has', () => {
  test('GitHub calls it number', () => {
    expect(pullNumber({ number: 12 })).toBe(12)
  })

  test('Gitea calls it index, and means the same thing', () => {
    /*
     * The one that would be silent. Reading `number` off a Gitea pull request
     * gives `undefined`, which becomes `NaN`, which becomes a pull request
     * numbered zero - and nothing fails, because a zero is a number.
     */
    expect(pullNumber({ index: 12 })).toBe(12)
  })

  test('and a row with neither is refused rather than numbered zero', () => {
    expect(pullNumber({})).toBe(0)
    expect(pullNumber(null)).toBe(0)
    expect(pullNumber({ number: 'nonsense' })).toBe(0)
  })
})

describe('where the API is', () => {
  test('GitHub is at the root', () => {
    expect(apiBase('https://api.github.com', 'github')).toBe('https://api.github.com')
  })

  test('Gitea is under /api/v1, which people do not paste', () => {
    // People paste the address of the web interface, because that is the
    // address they know.
    expect(apiBase('https://codeberg.org', 'gitea')).toBe('https://codeberg.org/api/v1')
    expect(apiBase('https://codeberg.org/', 'gitea')).toBe('https://codeberg.org/api/v1')
  })

  test('and pasting the API address does not double it', () => {
    // `/api/v1/api/v1` answers 404, and a 404 from a path the operator did not
    // type reads as "the importer is broken".
    expect(apiBase('https://codeberg.org/api/v1', 'gitea')).toBe('https://codeberg.org/api/v1')
  })
})

describe('how the token is presented', () => {
  test('GitHub wants Bearer', () => {
    expect(FORGES.github.authorization('abc')).toBe('Bearer abc')
  })

  test('Gitea wants token, and being wrong is silent', () => {
    /*
     * Gitea answers a wrong scheme as *unauthenticated* rather than rejecting
     * it, so a private repository imports as empty and reports success. That is
     * why this is a parameter rather than a line of code somebody assumed.
     */
    expect(FORGES.gitea.authorization('abc')).toBe('token abc')
  })
})

describe('what each forge can be asked for at once', () => {
  test('GitHub lists a repository review comments in one call', () => {
    expect(FORGES.github.hasRepositoryWideReviewComments).toBe(true)
  })

  test('Gitea has no such endpoint, so reviews cost a call per pull request', () => {
    // A different cost model rather than a different field name, and the import
    // asks the shape rather than assuming.
    expect(FORGES.gitea.hasRepositoryWideReviewComments).toBe(false)
  })
})

describe('guessing which forge a host is', () => {
  test('github.com is GitHub', () => {
    expect(forgeFor('https://github.com')).toBe('github')
    expect(forgeFor('')).toBe('github')
  })

  test('and anything self-hosted has to be said', () => {
    /*
     * `git.example.com` could be any of them, and guessing wrong produces an
     * import that fetches nothing and reports success on an empty repository.
     * Refusing to guess is what makes the command ask.
     */
    expect(forgeFor('https://git.example.com')).toBeNull()
    expect(forgeFor('https://codeberg.org')).toBeNull()
  })
})
