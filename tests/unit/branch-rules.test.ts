// What a protected branch rule may be set to.
//
// Every field here is a decision with a consequence outside its row, and two of
// them fail in directions worth stating: `enforce_admins` absent must not read
// as an exemption, and an empty restriction must not read as "nobody". Both are
// the kind of mistake that produces a branch which *looks* protected on the
// settings page, which is worse than one that looks unprotected.

import { describe, expect, test } from 'bun:test'
import { decideRule, parseRestrictions, readRestrictions, restrictionPermits, writeRestrictions } from '../../app/Actions/Repo/branchRules'

/** The smallest rule the endpoint accepts. */
const minimal = { pattern: 'main' }

describe('decideRule: the GitHub payload', () => {
  /**
   * The shape people arrive with. Every key in a
   * `PUT /repos/{owner}/{repo}/branches/{branch}/protection` call has somewhere
   * to land, because a forge that accepts most of that payload is one whose
   * users discover the missing part after they believed the branch was covered.
   */
  test('every knob in a branch protection call has a home', () => {
    const decided = decideRule({
      pattern: 'main',
      required_approvals: 1,
      dismiss_stale_reviews: true,
      required_checks: ['ci'],
      require_up_to_date: true,
      enforce_admins: true,
      allow_force_push: false,
      allow_deletion: false,
      push_restrictions: { users: ['ada'], teams: ['platform'] },
    })

    expect(decided.ok).toBe(true)
    if (!decided.ok)
      return

    expect(decided.rule).toMatchObject({
      pattern: 'main',
      required_approvals: 1,
      dismiss_stale_reviews: true,
      required_checks: '["ci"]',
      require_up_to_date: true,
      enforce_admins: true,
      allow_force_push: false,
      allow_deletion: false,
      push_restrictions: '{"users":["ada"],"teams":["platform"]}',
    })
  })
})

describe('decideRule: enforce_admins', () => {
  /**
   * The one field whose absent value is not false.
   *
   * A caller that leaves it out is not asking for an admin exemption, and
   * reading silence as one would unbind the rule from the people most able to
   * break it every time somebody saved an unrelated field from a client that
   * has never heard of the setting.
   */
  test('absent means enforced', () => {
    const decided = decideRule(minimal)

    expect(decided.ok && decided.rule.enforce_admins).toBe(true)
  })

  test('sent as off means off', () => {
    for (const value of ['0', 'false', '', 'no']) {
      const decided = decideRule({ ...minimal, enforce_admins: value })

      expect(decided.ok && decided.rule.enforce_admins).toBe(false)
    }
  })

  test('the shapes a form and a JSON client send for on', () => {
    for (const value of [true, '1', 'on', 'true']) {
      const decided = decideRule({ ...minimal, enforce_admins: value })

      expect(decided.ok && decided.rule.enforce_admins).toBe(true)
    }
  })
})

describe('readRestrictions', () => {
  test('GitHub\'s own shape', () => {
    expect(readRestrictions({ users: ['Ada'], teams: ['Platform'] }))
      .toEqual({ ok: true, value: { users: ['ada'], teams: ['platform'] } })
  })

  /** `restrictions: null` is how a branch protection call says "unrestricted". */
  test('null is unrestricted', () => {
    expect(readRestrictions(null)).toEqual({ ok: true, value: null })
    expect(readRestrictions(undefined)).toEqual({ ok: true, value: null })
    expect(readRestrictions('')).toEqual({ ok: true, value: null })
  })

  /**
   * There is no way to spell "nobody", and that is on purpose: a branch with an
   * empty allowlist would refuse every push including the one that fixes the
   * rule.
   */
  test('empty lists are unrestricted rather than a branch nobody can write', () => {
    expect(readRestrictions({ users: [], teams: [] })).toEqual({ ok: true, value: null })
    expect(readRestrictions({ users: ' , ,', teams: '' })).toEqual({ ok: true, value: null })
  })

  test('a form field is a comma separated list of handles', () => {
    expect(readRestrictions('ada, grace,'))
      .toEqual({ ok: true, value: { users: ['ada', 'grace'], teams: [] } })
  })

  test('a JSON string, which is what a text area sends', () => {
    expect(readRestrictions('{"users":["ada"],"teams":[]}'))
      .toEqual({ ok: true, value: { users: ['ada'], teams: [] } })
  })

  /**
   * A client that reads the rule before writing it sends back what it was
   * given, and what a forge answers with is objects.
   */
  test('objects with a login or a slug, as a round trip produces', () => {
    expect(readRestrictions({ users: [{ login: 'Ada' }], teams: [{ slug: 'Platform' }] }))
      .toEqual({ ok: true, value: { users: ['ada'], teams: ['platform'] } })
  })

  test('duplicates collapse and order is kept', () => {
    expect(readRestrictions({ users: ['ada', 'Ada', 'grace'] }))
      .toEqual({ ok: true, value: { users: ['ada', 'grace'], teams: [] } })
  })

  test('malformed JSON is refused rather than read as unrestricted', () => {
    expect(readRestrictions('{not json').ok).toBe(false)
  })

  /**
   * `String({})` is `'[object Object]'`, which a looser reader would accept as
   * a handle - and the branch would be restricted to a user who cannot exist.
   */
  test('a value that is not a list of names is refused', () => {
    expect(readRestrictions({ users: { login: 'ada' } }).ok).toBe(false)
    expect(readRestrictions(42).ok).toBe(false)
  })
})

describe('parseRestrictions', () => {
  /**
   * The stored side fails the other way from `required_checks`.
   *
   * An unreadable check list is treated as unsatisfiable, because reading it as
   * "no checks" would weaken a rule. An unreadable allowlist read as "nobody"
   * would lock every writer out of the branch, including whoever would fix the
   * row - so it is read as unrestricted and the rest of the rule still applies.
   */
  test('a column that will not parse does not lock the branch', () => {
    expect(parseRestrictions('{not json')).toBe(null)
    expect(parseRestrictions('')).toBe(null)
    expect(parseRestrictions(null)).toBe(null)
  })

  test('round trips through the column', () => {
    const value = { users: ['ada'], teams: ['platform'] }

    expect(parseRestrictions(writeRestrictions(value))).toEqual(value)
    expect(writeRestrictions(null)).toBe('')
  })
})

describe('restrictionPermits', () => {
  const rule = { users: ['ada'], teams: ['platform'] }

  test('by handle, and by any of the actor\'s teams', () => {
    expect(restrictionPermits(rule, { handle: 'ada', teams: [] })).toBe(true)
    expect(restrictionPermits(rule, { handle: 'grace', teams: ['design', 'platform'] })).toBe(true)
  })

  test('anybody else is refused', () => {
    expect(restrictionPermits(rule, { handle: 'mallory', teams: ['design'] })).toBe(false)
  })

  /** Nobody is refused. This is the one rule that fails closed. */
  test('an actor nobody could identify is refused', () => {
    expect(restrictionPermits(rule, null)).toBe(false)
    expect(restrictionPermits(rule, { handle: null, teams: [] })).toBe(false)
  })
})

describe('decideRule: the limits that were already there', () => {
  test('a pattern is required, and is not a branch name a branch cannot have', () => {
    expect(decideRule({}).ok).toBe(false)
    expect(decideRule({ pattern: 'a branch' }).ok).toBe(false)
    expect(decideRule({ pattern: 'refs/heads/../main' }).ok).toBe(false)
  })

  test('required approvals is a whole number nobody can typo an extra zero onto', () => {
    expect(decideRule({ ...minimal, required_approvals: 200 }).ok).toBe(false)
    expect(decideRule({ ...minimal, required_approvals: -1 }).ok).toBe(false)
    expect(decideRule({ ...minimal, required_approvals: 1.5 }).ok).toBe(false)
    expect(decideRule({ ...minimal, required_approvals: 20 }).ok).toBe(true)
  })
})
