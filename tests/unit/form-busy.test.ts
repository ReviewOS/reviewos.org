// What a form does while it is submitting.
//
// Imported from `public/js/form-busy.js` rather than a copy, so these are the
// rules that ship. Importing it in a test installs nothing: the module only
// attaches itself when there is a `document`, and there is not one here.

import { describe, expect, test } from 'bun:test'
import { busyDecision, busyLabel } from '../../public/js/form-busy.js'

describe('what to do with a submit', () => {
  test('a post is marked busy, which is the whole point', () => {
    expect(busyDecision({ method: 'post', busy: false, defaultPrevented: false }))
      .toEqual({ mark: true, cancel: false })
  })

  test('and the method is read in whatever case the markup wrote it', () => {
    // `form.method` reports lowercase, but the attribute is written POST in
    // several of these templates and this should not depend on which.
    for (const method of ['POST', 'Post', 'post'])
      expect(busyDecision({ method, busy: false, defaultPrevented: false }).mark).toBe(true)
  })

  test('the second press is refused rather than marked again', () => {
    // The double submit this exists to stop. On the profile form it is two
    // renames in flight, each racing the other's uniqueness check.
    expect(busyDecision({ method: 'post', busy: true, defaultPrevented: false }))
      .toEqual({ mark: false, cancel: true })
  })

  test('a get is left alone, because a query is not a change', () => {
    // The search box and the people filter come back as an ordinary
    // navigation. A spinner on them is noise, and refusing the second press
    // would stop somebody searching twice.
    for (const busy of [false, true]) {
      expect(busyDecision({ method: 'get', busy, defaultPrevented: false }))
        .toEqual({ mark: false, cancel: false })
    }
  })

  test('and so is a submission something else already cancelled', () => {
    // It never left, so marking it busy would leave a button spinning over a
    // form that is not going anywhere - and would then refuse the real press.
    expect(busyDecision({ method: 'post', busy: false, defaultPrevented: true }))
      .toEqual({ mark: false, cancel: false })
  })

  test('a missing or odd method is not treated as a post', () => {
    // Safer in this direction: failing to mark a form costs a spinner, and
    // wrongly refusing a submit costs the submit.
    for (const method of ['', 'dialog', 'PUT'])
      expect(busyDecision({ method, busy: false, defaultPrevented: false }).cancel).toBe(false)
  })
})

describe('what a busy button reads', () => {
  test('the label it asked for', () => {
    expect(busyLabel('Save', 'Saving...')).toBe('Saving...')
  })

  test('and its own text when it asked for none', () => {
    // The verbs here are not interchangeable: a generic "Saving..." over
    // "Delete", "Revoke" or "Merge pull request" names the wrong action, which
    // is worse than naming none. Those buttons get the spinner alone.
    for (const requested of [null, undefined, '', '   '])
      expect(busyLabel('Delete', requested)).toBe('Delete')
  })

  test('and never an empty button', () => {
    // A button whose text is replaced by nothing is a button nobody can read
    // or describe, which is the one outcome worse than the wrong verb.
    expect(busyLabel('Merge pull request', '  ').length).toBeGreaterThan(0)
  })
})
