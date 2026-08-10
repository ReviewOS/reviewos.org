// Who wrote an imported comment, and what a link in it should point at.
//
// The two decisions an importer makes thousands of times and cannot revisit.
// Getting attribution wrong puts a real person's name on words they did not
// write; getting references wrong leaves a repository quietly telling its
// readers that the real conversation is still on GitHub.

import { describe, expect, test } from 'bun:test'
import { buildLinkMap, parseClaims, rewriteReferences } from '../../app/Actions/Import/attribution'

const ACCOUNTS = [
  { id: 1, handle: 'alice', email: 'alice@acme.example' },
  { id: 2, handle: 'robert', email: 'bob@acme.example' },
  { id: 3, handle: 'carol', email: null },
]

describe('who gets attributed', () => {
  test('a matching handle alone is not evidence', () => {
    /*
     * The mistake every importer makes. `alice` on GitHub and `alice` on a
     * private instance are the same string and usually different people, and
     * two thousand comments is a lot of words to put in a stranger's mouth.
     */
    const map = buildLinkMap({
      linked: new Map(),
      accounts: ACCOUNTS,
      claims: new Map(),
      authors: [{ login: 'alice' }],
    })

    expect(map.has('alice')).toBe(false)
  })

  test('a matching email is', () => {
    // The same person by construction rather than by coincidence.
    const map = buildLinkMap({
      linked: new Map(),
      accounts: ACCOUNTS,
      claims: new Map(),
      authors: [{ login: 'someone-else', email: 'alice@acme.example' }],
    })

    expect(map.get('someone-else')).toBe(1)
  })

  test('and so is an operator saying so', () => {
    // A human assertion, recorded once, rather than a guess made per row. The
    // handles differ deliberately: `bob` upstream is `robert` here, which is
    // exactly the case a handle match would miss and a claim gets right.
    const map = buildLinkMap({
      linked: new Map(),
      accounts: ACCOUNTS,
      claims: parseClaims('bob=robert'),
      authors: [{ login: 'bob' }],
    })

    expect(map.get('bob')).toBe(2)
  })

  test('an account that linked itself outranks anything inferred', () => {
    /*
     * Somebody who said "this is my GitHub identity" has made a stronger claim
     * than an email match, and a claim file that disagreed with them would
     * otherwise silently win.
     */
    const map = buildLinkMap({
      linked: new Map([['alice', 3]]),
      accounts: ACCOUNTS,
      claims: parseClaims('alice=alice'),
      authors: [{ login: 'alice', email: 'alice@acme.example' }],
    })

    expect(map.get('alice')).toBe(3)
  })

  test('a claim naming an account that does not exist maps nobody', () => {
    // Rather than throwing, and rather than falling back to a handle match: a
    // typo in a mapping should leave the row honestly unattributed.
    const map = buildLinkMap({
      linked: new Map(),
      accounts: ACCOUNTS,
      claims: parseClaims('bob=nobody-here'),
      authors: [{ login: 'bob' }],
    })

    expect(map.has('bob')).toBe(false)
  })

  test('claims are read the way somebody types them', () => {
    expect([...parseClaims('alice=alice, Bob=Robert').entries()]).toEqual([['alice', 'alice'], ['bob', 'robert']])
    expect(parseClaims('').size).toBe(0)
    expect(parseClaims('nonsense').size).toBe(0)
  })
})

describe('cross references', () => {
  const imported = new Map([['acme/api', 'acme/api']])

  test('a bare number is left alone, because the number is preserved', () => {
    // The whole reason for preserving numbers: `#123` resolves here to the same
    // issue it resolved to there, so there is nothing to rewrite.
    expect(rewriteReferences('A follow-up to #7.', imported)).toBe('A follow-up to #7.')
  })

  test('an absolute link to an imported repository comes home', () => {
    expect(rewriteReferences('See https://github.com/acme/api/issues/3 please', imported))
      .toBe('See /acme/api/issues/3 please')
  })

  test('a pull request link keeps its path', () => {
    expect(rewriteReferences('https://github.com/acme/api/pull/12', imported)).toBe('/acme/api/pull/12')
  })

  test('a link to a repository this instance does not have stays a link', () => {
    /*
     * Making it relative would point at a page that does not exist, which is
     * worse than an external link that works - the reader ends up on a 404 with
     * no way to find what was meant.
     */
    const body = 'Compare https://github.com/someone/else/issues/1'

    expect(rewriteReferences(body, imported)).toBe(body)
  })

  test('an empty body is not a problem', () => {
    expect(rewriteReferences('', imported)).toBe('')
  })
})
