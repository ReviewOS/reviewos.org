/**
 * Cursor pagination, and the tiebreaker that makes it correct.
 *
 * The failure this replaces is silent: offset pagination over a table people
 * are writing to returns row 25 twice and never returns row 51, because the
 * result set is rewritten between the two requests. A person clicking "next"
 * rarely notices; an agent paginating an issue tracker gets a picture with
 * holes in it and nothing anywhere reports a problem.
 *
 * So the case that matters most here is the same-timestamp pair. An ordering by
 * time alone is not total, and a cursor on a non-total ordering skips rows for
 * exactly the same reason offset does - which would make this a rewrite that
 * fixed nothing.
 */

import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  isAfter,
  MAX_PAGE_SIZE,
  pageSize,
  toPage,
} from '../../app/Api/cursor'

describe('encoding', () => {
  it('round-trips a position', () => {
    const position = { value: '2026-08-08T12:00:00Z', id: 42 }

    expect(decodeCursor(encodeCursor(position))).toEqual(position)
  })

  it('survives a value containing spaces, which timestamps from some drivers do', () => {
    // Split on the *last* space rather than the first, or `2026-08-08 12:00:00`
    // loses its time half and every cursor lands in the wrong place.
    const position = { value: '2026-08-08 12:00:00', id: 7 }

    expect(decodeCursor(encodeCursor(position))).toEqual(position)
  })

  it('is null for anything malformed, so a bad cursor starts from the beginning', () => {
    /*
     * Not an error. A cursor names a position in a result set that may no
     * longer exist - the row could have been deleted - and refusing would
     * strand a paginating client with no way forward except knowing to drop the
     * cursor itself.
     */
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(Buffer.from('no-separator').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('value notanumber').toString('base64url'))).toBeNull()
    expect(decodeCursor(null)).toBeNull()
  })
})

describe('page size', () => {
  it('defaults when unasked', () => {
    expect(pageSize(undefined)).toBe(DEFAULT_PAGE_SIZE)
    expect(pageSize('')).toBe(DEFAULT_PAGE_SIZE)
    expect(pageSize(0)).toBe(DEFAULT_PAGE_SIZE)
    expect(pageSize(-5)).toBe(DEFAULT_PAGE_SIZE)
  })

  it('clamps rather than refusing', () => {
    // `per_page=5000` is a client being optimistic rather than hostile, and 100
    // rows with a cursor is more useful than an error they must write code for.
    expect(pageSize(5000)).toBe(MAX_PAGE_SIZE)
  })

  it('honours a reasonable request', () => {
    expect(pageSize('10')).toBe(10)
  })
})

describe('building a page', () => {
  const rows = Array.from({ length: 4 }, (_, index) => ({ at: `t${index}`, id: index + 1 }))
  const position = (row: { at: string, id: number }) => ({ value: row.at, id: row.id })

  it('drops the extra row and emits a cursor when there is more', () => {
    // The caller asks for size + 1. The extra row is never returned - it exists
    // only to answer "is there more?" without a COUNT, which on a large table
    // costs more than the page did.
    const page = toPage(rows, 3, position)

    expect(page.items).toHaveLength(3)
    expect(page.items[2].id).toBe(3)
    expect(decodeCursor(page.nextCursor)).toEqual({ value: 't2', id: 3 })
  })

  it('emits no cursor on the last page, so following until null terminates', () => {
    const page = toPage(rows.slice(0, 2), 3, position)

    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeNull()
  })

  it('and none for an empty result, rather than a cursor to nowhere', () => {
    expect(toPage([], 3, position).nextCursor).toBeNull()
  })

  it('does not produce a trailing empty page when the total divides evenly', () => {
    // Exactly 3 rows for a size of 3: there is no extra row, so there is no
    // cursor, so the client stops. A cursor here would cost a request that
    // returns nothing.
    expect(toPage(rows.slice(0, 3), 3, position).nextCursor).toBeNull()
  })
})

describe('the tiebreaker', () => {
  const cursor = { value: 't5', id: 10 }

  it('takes rows strictly after the cursor, descending', () => {
    expect(isAfter({ value: 't4', id: 99 }, cursor)).toBe(true)
    expect(isAfter({ value: 't6', id: 1 }, cursor)).toBe(false)
  })

  it('splits a same-value pair by id, which is the whole point', () => {
    /*
     * Two rows written in the same millisecond have no defined order between
     * them. Without the id, a cursor pointing at one cannot say which side of
     * the pair it is on - so the pair straddles a page boundary and one of them
     * is never returned. This is the case offset pagination gets wrong and a
     * naive cursor gets wrong in exactly the same way.
     */
    expect(isAfter({ value: 't5', id: 9 }, cursor)).toBe(true)
    expect(isAfter({ value: 't5', id: 11 }, cursor)).toBe(false)
  })

  it('never returns the cursor row itself', () => {
    // Otherwise the last row of every page is the first row of the next one.
    expect(isAfter({ value: 't5', id: 10 }, cursor)).toBe(false)
  })

  it('reverses cleanly when ascending', () => {
    expect(isAfter({ value: 't6', id: 1 }, cursor, 'asc')).toBe(true)
    expect(isAfter({ value: 't4', id: 99 }, cursor, 'asc')).toBe(false)
    expect(isAfter({ value: 't5', id: 11 }, cursor, 'asc')).toBe(true)
    expect(isAfter({ value: 't5', id: 9 }, cursor, 'asc')).toBe(false)
  })

  it('takes everything when there is no cursor', () => {
    expect(isAfter({ value: 't1', id: 1 }, null)).toBe(true)
  })
})

describe('paginating a table being written to', () => {
  it('does not skip or repeat when a row is inserted above the window', () => {
    /*
     * The whole reason this module exists, as one assertion.
     *
     * Offset would return `c` twice and never return `a`: the insert shifts
     * every row down one, so `OFFSET 2` lands on a row already seen. A cursor
     * names a position, and inserts above it do not move it.
     */
    /*
     * ISO timestamps rather than `t1`…`t10`, and that is not incidental. The
     * comparison is lexical, which is exactly right for ISO-8601 and exactly
     * wrong for an unpadded counter: `"t10" < "t7"`, so a naive fixture makes
     * the newest row look like the oldest and the test fails for a reason that
     * has nothing to do with the code. Any caller ordering on a column whose
     * text does not sort like its value has the same trap.
     */
    const at = (minute: number) => `2026-08-08T12:${String(minute).padStart(2, '0')}:00Z`

    const first = [
      { value: at(9), id: 9 },
      { value: at(8), id: 8 },
      { value: at(7), id: 7 },
    ]

    const page = toPage([...first, { value: at(6), id: 6 }], 3, row => row)
    const cursor = decodeCursor(page.nextCursor)

    // Somebody inserts a newer row between the two requests. It belongs on page
    // one, which has already been served - so it must not appear on page two.
    const afterInsert = [
      { value: at(10), id: 10 },
      ...first,
      { value: at(6), id: 6 },
      { value: at(5), id: 5 },
    ]

    const second = afterInsert.filter(row => isAfter(row, cursor))

    expect(second.map(row => row.id)).toEqual([6, 5])
    // Nothing from the first page comes back, and nothing between them is lost.
    expect(second.some(row => first.some(seen => seen.id === row.id))).toBe(false)
  })
})
