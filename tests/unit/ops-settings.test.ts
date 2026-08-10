// The instance settings catalogue.
//
// Two things are worth pinning here, and neither is the parsing. The first is
// that **every setting is enforced somewhere** - a switch that does nothing is
// worse than no switch, because an administrator turns registration off, sees
// it off, and finds out otherwise from a stranger's account. The second is that
// a bad value is refused with a sentence naming the key, since a settings API
// that answers "invalid" to a script is one whose author has to read the source.

import { describe, expect, test } from 'bun:test'
import { decideSetting, isSettingKey, SETTINGS } from '../../app/Ops/settings'

describe('the catalogue', () => {
  test('every setting says where it is enforced, and that file exists', async () => {
    /*
     * The rule this file is written around. `enforcedIn` is prose, so it cannot
     * prove the value is read - but a path that does not exist proves it is
     * not, and that is the failure mode worth catching: a setting whose
     * enforcement was moved, renamed, or never written.
     */
    for (const [key, definition] of Object.entries(SETTINGS)) {
      expect(definition.describes.length).toBeGreaterThan(10)

      // Some entries name more than one place, comma separated.
      for (const path of definition.enforcedIn.split(',').map(one => one.trim())) {
        const exists = await Bun.file(path).exists()
          // A directory rather than a file, for the entries that name one.
          || await Bun.file(`${path}/index.ts`).exists()
          || [...new Bun.Glob(`${path}/**/*`).scanSync({ cwd: process.cwd(), onlyFiles: true })].length > 0

        expect({ key, path, exists }).toEqual({ key, path, exists: true })
      }
    }
  })

  test('every default is a value the setting would accept', () => {
    // A fallback that fails its own validation is an instance that cannot be
    // saved on the settings page until somebody changes an unrelated field.
    for (const [key, definition] of Object.entries(SETTINGS))
      expect(decideSetting(key, definition.fallback).ok).toBe(true)
  })
})

describe('deciding a value', () => {
  test('an unknown key is a 404, not a 422', () => {
    // The key does not exist, rather than the value being wrong, and a script
    // told 422 will keep trying different values.
    const decision = decideSetting('registration_mode', 'open')

    expect(decision).toEqual({ ok: false, error: 'No such setting: registration_mode', status: 404 })
  })

  test('an enum lists what it will take', () => {
    const decision = decideSetting('registration', 'invite')

    expect(decision.ok).toBe(false)
    expect(decision.ok === false && decision.error).toBe('registration is one of open, closed')
  })

  test('there is deliberately no invite mode', () => {
    // This product has no invitation flow for registration - organization
    // invites need an account to accept - so an `invite` option would be a mode
    // nobody could use.
    expect(SETTINGS.registration.allowed).toEqual(['open', 'closed'])
  })

  test('a number is bounded and whole', () => {
    expect(decideSetting('max_repositories_per_user', '10')).toEqual({
      ok: true,
      key: 'max_repositories_per_user',
      value: '10',
    })

    expect(decideSetting('max_repositories_per_user', '1.5').ok).toBe(false)
    expect(decideSetting('max_repositories_per_user', '-1').ok).toBe(false)
    // Zero is unlimited, and has to be reachable.
    expect(decideSetting('max_repositories_per_user', '0').ok).toBe(true)
  })

  test('an empty string is refused rather than stored', () => {
    // An instance whose name is the empty string renders a page with no title,
    // and the read falls back anyway - so storing one would be a value that
    // does nothing and looks like it did something.
    expect(decideSetting('instance_name', '   ').ok).toBe(false)
  })

  test('a name too long for a page title is refused', () => {
    expect(decideSetting('instance_name', 'x'.repeat(101)).ok).toBe(false)
    expect(decideSetting('instance_name', 'x'.repeat(100)).ok).toBe(true)
  })

  test('isSettingKey does not answer true for a prototype property', () => {
    // `'constructor' in SETTINGS` is true, and a settings endpoint that
    // believed it would write a row nothing reads under a key nothing owns.
    expect(isSettingKey('constructor')).toBe(false)
    expect(isSettingKey('toString')).toBe(false)
    expect(isSettingKey('registration')).toBe(true)
  })
})
