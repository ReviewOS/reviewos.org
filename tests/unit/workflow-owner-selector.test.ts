// Which repositories an organization's own workflow covers.
//
// The point of the feature is that a licence check lands on two hundred
// repositories without two hundred commits and cannot be removed by editing a
// file in one of them - so the selector is the whole of the blast radius, and
// every case here is one where getting it wrong means running somewhere nobody
// meant to, or not running where somebody did.

import { describe, expect, test } from 'bun:test'
import { coversRepository, matchesName } from '../../app/Actions/Workflow/ownerWorkflows'

const web = { name: 'web', visibility: 'public' }
const secret = { name: 'payroll', visibility: 'private' }

describe('a selector nobody wrote', () => {
  test('covers everything under the owner, which is what "owned by the organization" means', () => {
    expect(coversRepository(null, web)).toBe(true)
    expect(coversRepository('', web)).toBe(true)
    expect(coversRepository('   ', web)).toBe(true)
  })
})

describe('names and patterns', () => {
  test('an exact name covers that repository and no other', () => {
    expect(coversRepository('web', web)).toBe(true)
    expect(coversRepository('web', { name: 'website' })).toBe(false)
  })

  test('a `*` covers a run of characters', () => {
    expect(coversRepository('svc-*', { name: 'svc-billing' })).toBe(true)
    expect(coversRepository('svc-*', { name: 'billing' })).toBe(false)
  })

  test('and a dot is a dot rather than a wildcard', () => {
    // A pattern language whose dots are wildcards is one that silently covers
    // more than it says, which for this feature means running somewhere nobody
    // asked it to.
    expect(matchesName('a.b', 'a.b')).toBe(true)
    expect(matchesName('a.b', 'axb')).toBe(false)
  })

  test('several terms are alternatives, comma or newline separated', () => {
    expect(coversRepository('api, web', web)).toBe(true)
    expect(coversRepository('api\nweb', web)).toBe(true)
    expect(coversRepository('api, mobile', web)).toBe(false)
  })
})

describe('exclusions', () => {
  test('win over the includes, so `*, !sandbox-*` reads the way it looks', () => {
    expect(coversRepository('*, !sandbox-*', { name: 'sandbox-web' })).toBe(false)
    expect(coversRepository('*, !sandbox-*', web)).toBe(true)
  })

  test('and on their own cover everything else', () => {
    // Requiring `*, !sandbox-*` would be a rule whose only purpose is catching
    // people out.
    expect(coversRepository('!sandbox-*', web)).toBe(true)
    expect(coversRepository('!sandbox-*', { name: 'sandbox-web' })).toBe(false)
  })
})

describe('visibility', () => {
  test('is the one term that is not a name, because "every private repository" is the second thing anybody asks for', () => {
    expect(coversRepository('visibility:private', secret)).toBe(true)
    expect(coversRepository('visibility:private', web)).toBe(false)
    expect(coversRepository('visibility:public', web)).toBe(true)
  })

  test('and combines with the rest', () => {
    expect(coversRepository('visibility:private, !payroll', secret)).toBe(false)
    expect(coversRepository('visibility:private, !legacy', secret)).toBe(true)
  })
})

describe('an archived repository', () => {
  test('is covered by nothing, whatever the selector says', () => {
    /*
     * Not a rule about selectors - a rule about archives. Archiving says "this
     * is finished", and a nightly scan that keeps starting runs on it is a
     * promise broken by a feature that was not thinking about the case.
     */
    expect(coversRepository(null, { name: 'old', archived: true })).toBe(false)
    expect(coversRepository('old', { name: 'old', archived: true })).toBe(false)
  })
})
