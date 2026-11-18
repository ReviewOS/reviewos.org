// A form that answers without replacing the page.
//
// Imported from `public/js/form-live.js`, the file the layout serves, so these
// are the rules that ship. Importing it installs nothing: it only attaches
// itself when there is a `document`, and there is not one here.

import { describe, expect, test } from 'bun:test'
import { changeSubmits, liveDecision, liveMessage, movedAway, pick, renderedValue, settleControl } from '../../public/js/form-live.js'

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

  /*
   * The schedule endpoint is the reason this exists. It answers with what the
   * hours just saved would do to a review request *right now*, which is the
   * only part of that response worth reading and exactly what the full reload
   * used to throw away. The form names the field; this module knows no key
   * belonging to any one action.
   */
  test('a form can name the field its answer lives in', () => {
    const body = {
      days: '1,2,3',
      right_now: { decision: 'hold', explanation: 'If your review were requested now, it would wait until 09:00.' },
    }

    expect(liveMessage(true, body, 'right_now.explanation').message)
      .toBe('If your review were requested now, it would wait until 09:00.')
  })

  test('and falls back rather than saying nothing when the field is missing', () => {
    // A rule that changed shape, an older server, a field renamed: the save
    // still happened, so the answer is still a confirmation.
    expect(liveMessage(true, { ok: true }, 'right_now.explanation').message).toBe('Saved.')
    expect(liveMessage(true, { right_now: {} }, 'right_now.explanation').message).toBe('Saved.')
    expect(liveMessage(true, { right_now: 'not an object' }, 'right_now.explanation').message).toBe('Saved.')
  })

  test('a refusal still wins over a named success field', () => {
    const body = { error: 'A window needs a start and an end that differ', right_now: { explanation: 'ignored' } }

    expect(liveMessage(false, body, 'right_now.explanation'))
      .toEqual({ ok: false, message: 'A window needs a start and an end that differ' })
  })
})

describe('reading a named field out of an answer', () => {
  test('a dotted path, however deep', () => {
    expect(pick({ a: { b: { c: 'here' } } }, 'a.b.c')).toBe('here')
    expect(pick({ top: 'here' }, 'top')).toBe('here')
  })

  test('and nothing rather than a crash when the path is not there', () => {
    expect(pick({}, 'a.b')).toBe('')
    expect(pick(null, 'a')).toBe('')
    expect(pick({ a: null }, 'a.b')).toBe('')
    expect(pick({ a: 'string' }, 'a.b')).toBe('')
  })

  test('and only strings, because this goes into a sentence', () => {
    // `{ ok: true }` named by mistake would otherwise print "true" at somebody.
    expect(pick({ ok: true }, 'ok')).toBe('')
    expect(pick({ count: 3 }, 'count')).toBe('')
    expect(pick({ at: { nested: {} } }, 'at.nested')).toBe('')
  })
})

describe('when staying on the page would be the wrong answer', () => {
  /*
   * The profile form can rename the account, and this page is full of the old
   * handle: the heading link, and every repository URL under it. Staying would
   * leave somebody reading a page that says `/old` while they are `/new`.
   */
  test('a rename moves the page out from under the reader', () => {
    expect(movedAway('chris', { ok: true, handle: 'chris-b' }, 'handle')).toBe(true)
  })

  test('and saving anything else does not', () => {
    expect(movedAway('chris', { ok: true, handle: 'chris' }, 'handle')).toBe(false)
    expect(movedAway('chris', { ok: true, unchanged: true }, 'handle')).toBe(false)
    expect(movedAway('chris', {}, 'handle')).toBe(false)
  })

  test('and a form that never had a handle is never moved by one', () => {
    // Every other form that might opt in later. `data-live-was` is absent,
    // so there is nothing for a response to differ from.
    expect(movedAway(undefined, { handle: 'anything' }, 'handle')).toBe(false)
    expect(movedAway('', { handle: 'anything' }, 'handle')).toBe(false)
  })

  /*
   * The field is named by the form, and a form that names none cannot be moved.
   * This is the case that made the old signature a trap: it read `body.handle`
   * whatever the form was, so the moment a second form went live - a preference
   * cell, a merge toggle - any action answering with a `handle` of its own
   * would have reloaded a page that had not moved.
   */
  test('a form that names no field is never moved, whatever came back', () => {
    expect(movedAway('squash', { handle: 'someone-else' }, undefined)).toBe(false)
    expect(movedAway('squash', { handle: 'someone-else' }, '')).toBe(false)
  })

  test('and the named field is the only one that counts', () => {
    // The repository settings answer carries `name` when a rename happened.
    expect(movedAway('reviewos', { id: 7, name: 'reviewos-core' }, 'name')).toBe(true)
    expect(movedAway('reviewos', { id: 7, handle: 'chris-b' }, 'name')).toBe(false)
  })
})

describe('a control that submits as soon as it changes', () => {
  /*
   * The role select on the people page used `onchange="this.form.submit()"`.
   * Two things were wrong with that at once, and the second is the dangerous
   * one: `form.submit()` fires no submit event, so neither the live save nor
   * the busy guard in `form-busy.js` can see it. A form wired that way keeps
   * posting the whole page however many times it is marked `data-live` - the
   * opt-in says it stays put, and it does not.
   */
  test('a control that asked for it', () => {
    expect(changeSubmits({ dataset: { liveChange: '' } })).toBe(true)
  })

  test('and no other control, because change is not a submit anywhere else', () => {
    // Every other select in the product: the preference cells have a Save
    // button, and a select that posted on change would lose the button's
    // meaning.
    expect(changeSubmits({ dataset: {} })).toBe(false)
    expect(changeSubmits({ dataset: { live: '' } })).toBe(false)
    expect(changeSubmits({ dataset: { liveStatus: '' } })).toBe(false)
  })

  test('and nothing that is not a control at all', () => {
    expect(changeSubmits(null)).toBe(false)
    expect(changeSubmits(undefined)).toBe(false)
    expect(changeSubmits({})).toBe(false)
  })
})

describe('a submit-on-change control after the server answers', () => {
  /** A `<select>` stub: `value` is what the reader picked, the attribute is what was rendered. */
  function select(rendered: string, picked = rendered) {
    return {
      tagName: 'SELECT',
      value: picked,
      dataset: {} as Record<string, string>,
      querySelector: (query: string) =>
        query === 'option[selected]' ? { value: rendered } : null,
    }
  }

  test('the rendered value is the one in the markup, not the one picked', () => {
    // The reader has chosen `member`; the database still says `owner`.
    expect(renderedValue(select('owner', 'member'))).toBe('owner')
  })

  test('and an input carries it on the attribute', () => {
    expect(renderedValue({ tagName: 'INPUT', getAttribute: () => 'typescript' })).toBe('typescript')
    expect(renderedValue({ tagName: 'INPUT', getAttribute: () => null })).toBe('')
  })

  test('nothing, for something that is not a control', () => {
    expect(renderedValue(null)).toBe('')
    expect(renderedValue(undefined)).toBe('')
    expect(renderedValue({ tagName: 'SELECT' })).toBe('')
  })

  /*
   * The reload this replaced re-rendered the truth, so staying put has to do
   * the same job. Demoting the only owner is refused - "An organization must
   * keep at least one owner" - and without this the select would sit on
   * "Member" beside that sentence, saying the person has a role they do not.
   */
  test('a refusal puts the control back where the server had it', () => {
    const control = select('owner', 'member')
    control.dataset.liveGood = 'owner'

    expect(settleControl(control, false)).toBe('owner')
    expect(control.value).toBe('owner')
  })

  test('and an accepted change becomes the value to come back to', () => {
    const control = select('member', 'admin')
    control.dataset.liveGood = 'member'

    expect(settleControl(control, true)).toBe('admin')
    expect(control.dataset.liveGood).toBe('admin')

    // A later refusal returns to the accepted value, not the rendered one.
    control.value = 'owner'
    expect(settleControl(control, false)).toBe('admin')
  })

  test('with nothing remembered it leaves the control alone', () => {
    // Better than guessing: a wrong revert is as misleading as no revert.
    const control = select('member', 'admin')

    expect(settleControl(control, false)).toBe('admin')
  })

  test('and it is safe when no control started the submit', () => {
    // Every form with a Save button, which is most of them.
    expect(settleControl(undefined, true)).toBe('')
    expect(settleControl(null, false)).toBe('')
  })
})
