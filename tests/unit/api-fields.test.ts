/**
 * Asking for the fields you need.
 *
 * A pull request list that always carries every body is expensive on both ends:
 * four hundred open pull requests with a paragraph each is a megabyte of prose
 * to build a list of titles, and the caller throws every body away.
 *
 * The decisions worth pinning are the ones about *degrading well*. This is an
 * optional optimisation, so every failure mode has to be recoverable - a client
 * that gets it slightly wrong should get slightly less, never nothing.
 */

import { describe, expect, it } from 'bun:test'
import { pick, pickAll, readFields, wants, withRequired } from '../../app/Api/fields'

const row = { id: 1, number: 12, title: 'a change', body: 'a long paragraph', state: 'open' }

describe('reading the parameter', () => {
  it('takes a comma-separated list', () => {
    expect(readFields('number,title')).toEqual(new Set(['number', 'title']))
  })

  it('tolerates spacing, which a hand-written URL will have', () => {
    expect(readFields(' number , title ')).toEqual(new Set(['number', 'title']))
  })

  it('is null for absent, which means everything', () => {
    /*
     * Null rather than an empty set, because the two mean opposite things.
     * Conflating them is how `?fields=` with a typo returns an empty object
     * instead of the whole resource.
     */
    expect(readFields(undefined)).toBeNull()
    expect(readFields('')).toBeNull()
    expect(readFields('   ')).toBeNull()
    expect(readFields(',,,')).toBeNull()
  })
})

describe('narrowing', () => {
  it('keeps only what was asked for', () => {
    expect(pick(row, new Set(['number', 'title']))).toEqual({ number: 12, title: 'a change' })
  })

  it('returns everything when nothing was asked for', () => {
    // Breaking every existing client to save bytes for the ones that opt in
    // would be the wrong trade.
    expect(pick(row, null)).toEqual(row)
  })

  it('ignores a field that does not exist rather than refusing', () => {
    /*
     * A client asking for `titel` gets the fields it spelled correctly. A 422
     * for a typo in an *optional* optimisation is a client that stops using the
     * optimisation - and the missing field in the response is the feedback.
     */
    expect(pick(row, new Set(['number', 'titel']))).toEqual({ number: 12 })
  })

  it('does not invent a key with an undefined value for a missing field', () => {
    // `{ titel: undefined }` serialises to nothing in JSON but is visible to
    // anything inspecting the object, and reads as "the field exists and is
    // empty" rather than "you asked for something that is not here".
    expect('titel' in pick(row, new Set(['titel']))).toBe(false)
  })

  it('narrows a whole list', () => {
    const rows = [row, { ...row, id: 2, number: 13 }]

    expect(pickAll(rows, new Set(['number']))).toEqual([{ number: 12 }, { number: 13 }])
  })
})

describe('fields a caller cannot drop', () => {
  it('adds the identifier back when it was left out', () => {
    /*
     * A list of objects with no id is a list nothing can be done with, and a
     * client that omitted it did so by accident every time.
     */
    const fields = withRequired(new Set(['title']), ['id'])

    expect(pick(row, fields)).toEqual({ id: 1, title: 'a change' })
  })

  it('leaves "everything" alone', () => {
    expect(withRequired(null, ['id'])).toBeNull()
  })

  it('does not duplicate one already asked for', () => {
    expect(withRequired(new Set(['id', 'title']), ['id'])).toEqual(new Set(['id', 'title']))
  })
})

describe('skipping the work, not just the bytes', () => {
  it('says whether an expensive field was asked for', () => {
    /*
     * The point of the whole feature. A serializer that narrows *after* reading
     * every column has saved the transfer and none of the work - and the
     * expensive fields are exactly the ones a list does not need: the body, the
     * labels, the review state, the check summary. Each is a query.
     */
    const fields = readFields('number,title')

    expect(wants(fields, 'title')).toBe(true)
    expect(wants(fields, 'body')).toBe(false)
  })

  it('wants everything when nothing was asked for', () => {
    expect(wants(null, 'body')).toBe(true)
  })
})
