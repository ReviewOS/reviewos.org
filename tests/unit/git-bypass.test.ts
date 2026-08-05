// Overriding a push-protection finding.
//
// The bypass exists because a scanner people cannot get past is a scanner
// people turn off - a false positive at six in the evening with a release
// waiting ends either with somebody writing a sentence, or with somebody
// setting `enabled: false` forever. So it has to be easy to use and impossible
// to use quietly, and both halves are tested here.

import { describe, expect, test } from 'bun:test'
import { decideBypass, readBypass } from '../../app/Actions/Git/bypass'
import { compilePattern, PATTERN_BUDGET_MS } from '../../app/Actions/Git/patterns'
import { safeQuarantine } from '../../app/Actions/Git/scan'

const settings = { allowBypass: true, minimumReasonLength: 12 }

describe('readBypass', () => {
  test('reads the documented spelling', () => {
    expect(readBypass(['secret-scan=bypass', 'reason=this is a test fixture']))
      .toEqual({ requested: true, reason: 'this is a test fixture' })
  })

  /** People do not read the documentation twice, so the near-misses work too. */
  test('reads the spellings somebody would guess', () => {
    expect(readBypass(['secret_scan=skip']).requested).toBe(true)
    expect(readBypass(['skip-secret-scan']).requested).toBe(true)
    expect(readBypass(['SECRET-SCAN=BYPASS']).requested).toBe(true)
  })

  test('reads the reason whichever order the options come in', () => {
    expect(readBypass(['reason=a good long reason', 'secret-scan=bypass']).reason)
      .toBe('a good long reason')
  })

  test('keeps a reason containing an equals sign whole', () => {
    expect(readBypass(['reason=the fixture is api_key=example']).reason)
      .toBe('the fixture is api_key=example')
  })

  test('finds nothing in an ordinary push', () => {
    expect(readBypass([])).toEqual({ requested: false, reason: '' })
    expect(readBypass(['ci.skip']).requested).toBe(false)
  })
})

describe('decideBypass', () => {
  test('allows an override with a real reason', () => {
    const outcome = decideBypass({ requested: true, reason: 'fixture, not a real key' }, settings)

    expect(outcome).toEqual({ allowed: true, reason: 'fixture, not a real key' })
  })

  test('a push that did not ask is not a bypass, and says nothing', () => {
    expect(decideBypass({ requested: false, reason: '' }, settings))
      .toEqual({ allowed: false, message: '' })
  })

  /**
   * Every refusal has to say what the override needs. One that does not is the
   * refusal that turns into "just disable the scanner".
   */
  test('refuses without a reason, and says how to give one', () => {
    const outcome = decideBypass({ requested: true, reason: '' }, settings)

    expect(outcome.allowed).toBe(false)
    expect((outcome as any).message).toContain('secret-scan=bypass')
    expect((outcome as any).message).toContain('reason=')
  })

  test('refuses a reason too short to be one, and says how short', () => {
    const outcome = decideBypass({ requested: true, reason: 'x' }, settings)

    expect(outcome.allowed).toBe(false)
    expect((outcome as any).message).toContain('12')
    expect((outcome as any).message).toContain('audit log')
  })

  test('refuses when the instance does not allow bypassing at all', () => {
    const outcome = decideBypass(
      { requested: true, reason: 'a perfectly good reason' },
      { allowBypass: false, minimumReasonLength: 12 },
    )

    expect(outcome.allowed).toBe(false)
    expect((outcome as any).message).toContain('cannot be bypassed')
  })

  test('bounds a reason before it reaches a column and a terminal', () => {
    const outcome = decideBypass({ requested: true, reason: 'a'.repeat(2000) }, settings)

    expect((outcome as any).reason.length).toBe(500)
  })
})

describe('compilePattern', () => {
  test('compiles a configured pattern', () => {
    const pattern = compilePattern({ name: 'an Acme token', pattern: 'acme_[A-Za-z0-9]{32}' })

    expect(pattern?.name).toBe('an Acme token')
    expect(pattern?.confidence).toBe('likely')
    expect(pattern?.test.test(`acme_${'a'.repeat(32)}`)).toBe(true)
  })

  test('an instance pattern is likely unless it says otherwise', () => {
    expect(compilePattern({ name: 'x', pattern: 'abc', confidence: 'certain' })?.confidence).toBe('certain')
  })

  test('drops anything that is not a usable pattern', () => {
    expect(compilePattern(null)).toBeNull()
    expect(compilePattern({ name: '', pattern: 'abc' })).toBeNull()
    expect(compilePattern({ name: 'x' })).toBeNull()
    expect(compilePattern({ name: 'x', pattern: '([' })).toBeNull()
  })

  /**
   * A regular expression is a program, and one written carelessly takes
   * exponential time. A scanner that hangs is a push that hangs, which is
   * indistinguishable from the forge being down - so a pattern that cannot
   * answer quickly is dropped rather than trusted.
   */
  test('drops a pattern that cannot answer quickly', () => {
    const started = performance.now()
    const pattern = compilePattern({ name: 'catastrophic', pattern: '(a+)+$' })
    const elapsed = performance.now() - started

    expect(pattern).toBeNull()
    // It has to *return*, not hang - the budget is what makes that true.
    expect(elapsed).toBeLessThan(PATTERN_BUDGET_MS * 40)
  })
})

/**
 * The quarantine paths arrive over HTTP, which means they arrive from whatever
 * can reach the endpoint. Handing an arbitrary string to git as an object
 * directory is handing it a filesystem read.
 */
describe('safeQuarantine', () => {
  const root = '/srv/repos/acme/app.git'

  test('keeps the paths git actually sets', () => {
    expect(safeQuarantine({
      GIT_OBJECT_DIRECTORY: `${root}/objects/tmp_objdir-incoming-8kyWBa`,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: `${root}/objects`,
    }, root)).toEqual({
      GIT_OBJECT_DIRECTORY: `${root}/objects/tmp_objdir-incoming-8kyWBa`,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: `${root}/objects`,
    })
  })

  test('drops a path outside the repository', () => {
    expect(safeQuarantine({ GIT_OBJECT_DIRECTORY: '/etc' }, root)).toEqual({})
    expect(safeQuarantine({ GIT_OBJECT_DIRECTORY: '../../etc' }, root)).toEqual({})
  })

  test('drops a colon list where any entry escapes', () => {
    expect(safeQuarantine({ GIT_ALTERNATE_OBJECT_DIRECTORIES: `${root}/objects:/etc` }, root)).toEqual({})
  })

  test('drops anything that is not a string path', () => {
    expect(safeQuarantine({ GIT_OBJECT_DIRECTORY: 42 }, root)).toEqual({})
    expect(safeQuarantine({ GIT_OBJECT_DIRECTORY: `${root}/a\0b` }, root)).toEqual({})
    expect(safeQuarantine(null, root)).toEqual({})
    expect(safeQuarantine('nope', root)).toEqual({})
  })
})
