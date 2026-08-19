// Redaction that says so.
//
// The rule phase 9 asks for is that the API returns redaction *metadata* rather
// than silently omitting data: a reader who cannot see a value should still be
// able to see that a value was there. A log with a gap in it and no explanation
// reads as a bug in the runner, and the person debugging goes looking in the
// wrong place entirely.

import { describe, expect, test } from 'bun:test'
import { countRedactions, MARKER, redactSecrets, redactWithCount } from '../../app/Actions/Runner/redact'

describe('counting what was taken out', () => {
  test('one occurrence of one value is one redaction', () => {
    const found = redactWithCount('token=hunter2-hunter2 ok', ['hunter2-hunter2'])

    expect(found.text).toBe(`token=${MARKER} ok`)
    expect(found.count).toBe(1)
  })

  test('every occurrence counts, not every value', () => {
    // A failed request that printed the token twice hid two of them, and a
    // client saying "1 value hidden" beside two markers is a client nobody
    // trusts the second time.
    const found = redactWithCount('a=secretvalue b=secretvalue', ['secretvalue'])

    expect(found.count).toBe(2)
  })

  test('text with nothing to remove is returned untouched and uncounted', () => {
    const found = redactWithCount('a perfectly ordinary line', ['secretvalue'])

    expect(found.text).toBe('a perfectly ordinary line')
    expect(found.count).toBe(0)
  })

  test('a value too short to redact is not counted either', () => {
    // Redacting `dev` would blank a word everywhere it appears and turn every
    // log on the instance into a puzzle. It is refused, and the count agrees
    // with what the text shows rather than with what was asked for.
    const found = redactWithCount('running in dev mode', ['dev'])

    expect(found.text).toBe('running in dev mode')
    expect(found.count).toBe(0)
  })

  test('redactSecrets is the same pass, without the count', () => {
    const line = 'auth: Bearer ghp_supersecretvalue'

    expect(redactSecrets(line, ['ghp_supersecretvalue'])).toBe(redactWithCount(line, ['ghp_supersecretvalue']).text)
  })
})

describe('counting text that was redacted already', () => {
  /**
   * The case that decides the design. Logs are redacted on the way in, so every
   * chunk stored before any count existed carries its markers and no number
   * beside them. Reading the markers back out is the only method that cannot
   * report "nothing was hidden" about text where something was - and a stored
   * count would report exactly that, for every log this instance already holds.
   */
  test('markers in stored text are what the count is read from', () => {
    expect(countRedactions(`a=${MARKER} b=${MARKER}`)).toBe(2)
    expect(countRedactions('a=1 b=2')).toBe(0)
    expect(countRedactions('')).toBe(0)
  })

  test('a page redacted on the way in reports the same count when read back', () => {
    const stored = redactWithCount('one=secretvalue two=secretvalue', ['secretvalue'])

    expect(countRedactions(stored.text)).toBe(stored.count)
  })
})
