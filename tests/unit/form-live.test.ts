// A form that answers without replacing the page.
//
// Imported from `public/js/form-live.js`, the file the layout serves, so these
// are the rules that ship. Importing it installs nothing: it only attaches
// itself when there is a `document`, and there is not one here.

import { describe, expect, test } from 'bun:test'
import { liveDecision, liveMessage, movedAway } from '../../public/js/form-live.js'

describe('which submits are handled here', () => {
  test('a posting form that asked to be', () => {
    expect(liveDecision({ live: true, method: 'post', defaultPrevented: false })).toBe(true)
    expect(liveDecision({ live: true, method: 'POST', defaultPrevented: false })).toBe(true)
  })

  test('and no other form, because the full round trip is still the default', () => {
    // Opt-in matters more here than in `form-busy.js`. That one adds a
    // spinner; this one changes what a submit does, and a form that was
    // written expecting a new page would be left sitting on the old one.
    expect(liveDecision({ live: false, method: 'post', defaultPrevented: false })).toBe(false)
  })

  test('nor a get, which is a query and already repaints', () => {
    expect(liveDecision({ live: true, method: 'get', defaultPrevented: false })).toBe(false)
  })

  test('nor one something else already cancelled', () => {
    expect(liveDecision({ live: true, method: 'post', defaultPrevented: true })).toBe(false)
  })
})

describe('what it tells somebody', () => {
  test('the server\'s own words when it refused', () => {
    // The one field the actions agree on, because it is what the redirect
    // carries into `?error=` today.
    expect(liveMessage(false, { error: 'That handle is taken.' }))
      .toEqual({ ok: false, message: 'That handle is taken.' })
  })

  test('and something sayable when it refused without saying why', () => {
    for (const body of [{}, null, { error: '' }, { error: 42 }])
      expect(liveMessage(false, body).message.length).toBeGreaterThan(0)
  })

  test('a plain confirmation on success, since no action sends one', () => {
    expect(liveMessage(true, { ok: true })).toEqual({ ok: true, message: 'Saved.' })
    expect(liveMessage(true, { ok: true, unchanged: true }).ok).toBe(true)
  })

  test('but the server\'s sentence wins if it ever has one', () => {
    expect(liveMessage(true, { message: 'Saved, and the mirror was queued.' }).message)
      .toBe('Saved, and the mirror was queued.')
  })
})

describe('when staying on the page would be the wrong answer', () => {
  /*
   * The profile form can rename the account, and this page is full of the old
   * handle: the heading link, and every repository URL under it. Staying would
   * leave somebody reading a page that says `/old` while they are `/new`.
   */
  test('a rename moves the page out from under the reader', () => {
    expect(movedAway('chris', { ok: true, handle: 'chris-b' })).toBe(true)
  })

  test('and saving anything else does not', () => {
    expect(movedAway('chris', { ok: true, handle: 'chris' })).toBe(false)
    expect(movedAway('chris', { ok: true, unchanged: true })).toBe(false)
    expect(movedAway('chris', {})).toBe(false)
  })

  test('and a form that never had a handle is never moved by one', () => {
    // Every other form that might opt in later. `data-live-was` is absent,
    // so there is nothing for a response to differ from.
    expect(movedAway(undefined, { handle: 'anything' })).toBe(false)
    expect(movedAway('', { handle: 'anything' })).toBe(false)
  })
})
