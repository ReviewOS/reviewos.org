/**
 * The reader's display choices.
 *
 * Worth testing because every value here arrives from somewhere untrusted: a
 * string in local storage that a previous version of this code wrote, or an
 * attribute in a template somebody typed. A viewer that renders nothing
 * because one stored key changed shape would be a bad trade for remembering a
 * setting, so the rule is that anything unrecognised falls back rather than
 * propagating.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_PREFERENCES, readPreferences, writePreferences } from '../../resources/functions/diffprefs'

/** A local storage that behaves, so the reading and writing can be exercised. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))

  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

function withStorage(storage: Storage | (() => never)): void {
  ;(globalThis as { window?: unknown }).window = {
    get localStorage() {
      if (typeof storage === 'function')
        return storage()
      return storage
    },
  }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('readPreferences', () => {
  test('a browser with no storage at all still gets a working set', () => {
    // No `window` bound, which is what the server sees and what a bundle
    // evaluated before the DOM would see.
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES)
  })

  test('storage that throws on access is the same as no storage', () => {
    // Safari in private browsing, and any browser with third-party storage
    // blocked in a frame. It throws on the property access, not on the call.
    withStorage(() => { throw new Error('denied') })

    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES)
  })

  test('reads back what was written', () => {
    withStorage(fakeStorage())

    const chosen = { ...DEFAULT_PREFERENCES, layout: 'split' as const, indicators: 'bar' as const, wrap: true }
    writePreferences(chosen)

    expect(readPreferences()).toEqual(chosen)
  })

  test('a value outside the union falls back to the default for that key alone', () => {
    withStorage(fakeStorage({
      'reviewos:diff': JSON.stringify({ layout: 'sideways', indicators: 'bar', wrap: 'yes' }),
    }))

    const preferences = readPreferences()

    expect(preferences.layout).toBe('unified')
    expect(preferences.wrap).toBe(false)
    // The one recognisable value in the object is still honoured. A single bad
    // key must not cost the reader the rest of their settings.
    expect(preferences.indicators).toBe('bar')
  })

  test('unparseable storage is not an error, it is the defaults', () => {
    withStorage(fakeStorage({ 'reviewos:diff': '{oh no' }))

    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES)
  })

  test('a stored value that is not an object at all is ignored', () => {
    withStorage(fakeStorage({ 'reviewos:diff': '"split"' }))

    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES)
  })

  /**
   * The layout used to live under its own key. A reader who had already chosen
   * split should not silently get unified back the first time they load a page
   * after the settings were gathered into one.
   */
  test('picks up a layout chosen before the keys were merged', () => {
    withStorage(fakeStorage({ 'reviewos:diff-layout': 'split' }))

    expect(readPreferences().layout).toBe('split')
  })

  test('the old key loses to the new one rather than overriding it', () => {
    withStorage(fakeStorage({
      'reviewos:diff-layout': 'split',
      'reviewos:diff': JSON.stringify({ layout: 'unified' }),
    }))

    expect(readPreferences().layout).toBe('unified')
  })
})
