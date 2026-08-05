// Reading an issue list query, and paging through the answer.
//
// The paging half is the part worth testing hard. An offset page is wrong
// exactly when it matters - somebody paging through a repository while issues
// are being opened sees page one's last row again at the top of page two, and
// never sees the one that fell through the gap. A cursor names the row instead,
// so the tests below are mostly about the cursor surviving the things that
// happen to it: a timestamp with a `|` in it, a hand-edited URL, a page that
// came back short.

import { describe, expect, test } from 'bun:test'
import {
  cursorValueOf,
  DEFAULT_LIMIT,
  decodeCursor,
  encodeCursor,
  isPageable,
  keysetPlan,
  MAX_LIMIT,
  nextCursor,
  parseIssueQuery,
  SORT_COLUMNS,
  statesFor,
} from '../../app/Actions/Issue/listing'

describe('parseIssueQuery', () => {
  test('defaults to open issues, newest first', () => {
    const query = parseIssueQuery({})

    expect(query.state).toBe('open')
    expect(query.sort).toBe('created')
    expect(query.descending).toBe(true)
    expect(query.limit).toBe(DEFAULT_LIMIT)
    expect(query.cursor).toBeNull()
  })

  test('reads the states and sorts it knows', () => {
    expect(parseIssueQuery({ state: 'closed' }).state).toBe('closed')
    expect(parseIssueQuery({ state: 'all' }).state).toBe('all')
    expect(parseIssueQuery({ sort: 'updated' }).sort).toBe('updated')
    expect(parseIssueQuery({ sort: 'comments' }).sort).toBe('comments')
  })

  /**
   * A list is somewhere people arrive from a stale link or a hand-edited URL.
   * Answering "open issues, newest first" beats refusing to answer.
   */
  test('falls back rather than failing on a value it does not know', () => {
    expect(parseIssueQuery({ state: 'pending' }).state).toBe('open')
    expect(parseIssueQuery({ sort: 'priority' }).sort).toBe('created')
  })

  test('is case insensitive about states and sorts', () => {
    expect(parseIssueQuery({ state: 'CLOSED' }).state).toBe('closed')
    expect(parseIssueQuery({ sort: 'Updated' }).sort).toBe('updated')
  })

  test('reverses only when asked to, in the spelling people use', () => {
    expect(parseIssueQuery({ direction: 'asc' }).descending).toBe(false)
    expect(parseIssueQuery({ direction: 'desc' }).descending).toBe(true)
    expect(parseIssueQuery({ direction: 'sideways' }).descending).toBe(true)
  })

  test('takes labels as a list or as one comma-separated value', () => {
    expect(parseIssueQuery({ labels: ['bug', 'regression'] }).labels).toEqual(['bug', 'regression'])
    expect(parseIssueQuery({ label: 'bug,regression' }).labels).toEqual(['bug', 'regression'])
  })

  test('drops empty and repeated labels', () => {
    expect(parseIssueQuery({ label: 'bug,,bug, ' }).labels).toEqual(['bug'])
  })

  test('lowercases handles, which is how they are stored', () => {
    expect(parseIssueQuery({ author: 'Chris' }).author).toBe('chris')
    expect(parseIssueQuery({ assignee: 'Chris' }).assignee).toBe('chris')
  })

  /** Milestone titles are free text, so they are not folded. */
  test('leaves a milestone title as written', () => {
    expect(parseIssueQuery({ milestone: 'Version 1.0' }).milestone).toBe('Version 1.0')
  })

  test('caps the page size, and ignores a nonsense one', () => {
    expect(parseIssueQuery({ limit: '5' }).limit).toBe(5)
    expect(parseIssueQuery({ limit: '5000' }).limit).toBe(MAX_LIMIT)
    expect(parseIssueQuery({ limit: '0' }).limit).toBe(DEFAULT_LIMIT)
    expect(parseIssueQuery({ limit: '-3' }).limit).toBe(DEFAULT_LIMIT)
    expect(parseIssueQuery({ limit: 'lots' }).limit).toBe(DEFAULT_LIMIT)
    expect(parseIssueQuery({ limit: '2.5' }).limit).toBe(DEFAULT_LIMIT)
  })

  test('accepts search under either name', () => {
    expect(parseIssueQuery({ q: 'crash' }).search).toBe('crash')
    expect(parseIssueQuery({ search: 'crash' }).search).toBe('crash')
  })
})

describe('cursors', () => {
  test('round-trips the id-only form', () => {
    expect(decodeCursor(encodeCursor({ id: 42 }))).toEqual({ id: 42 })
  })

  test('round-trips a value alongside the id', () => {
    expect(decodeCursor(encodeCursor({ id: 42, value: '2026-08-02T10:00:00.000Z' })))
      .toEqual({ id: 42, value: '2026-08-02T10:00:00.000Z' })
    expect(decodeCursor(encodeCursor({ id: 7, value: '3' }))).toEqual({ id: 7, value: '3' })
  })

  /**
   * Null is a position in the order, not the absence of one: an issue nobody
   * has touched since opening it has no `updated_at`, and Postgres sorts that
   * block at one end. A cursor that could not say "null" would skip it.
   */
  test('round-trips a null value, which is a position rather than a gap', () => {
    expect(decodeCursor(encodeCursor({ id: 42, value: null }))).toEqual({ id: 42, value: null })
  })

  /** The value goes last and is split on the first separator, so it may contain one. */
  test('survives a value containing the separator', () => {
    expect(decodeCursor(encodeCursor({ id: 5, value: 'a|b|c' }))).toEqual({ id: 5, value: 'a|b|c' })
  })

  test('refuses a cursor that did not come from here', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull()
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor(undefined)).toBeNull()
    expect(decodeCursor(null)).toBeNull()
  })

  test('refuses a cursor with no usable id', () => {
    expect(decodeCursor(Buffer.from('i', 'utf8').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('iabc', 'utf8').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('i0', 'utf8').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('i-1', 'utf8').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('12', 'utf8').toString('base64url'))).toBeNull()
  })

  test('refuses a tuple cursor that is missing its value', () => {
    expect(decodeCursor(Buffer.from('t42', 'utf8').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('t42|', 'utf8').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('t42|x', 'utf8').toString('base64url'))).toBeNull()
  })

  test('a bad cursor leaves the query at the first page rather than failing', () => {
    expect(parseIssueQuery({ cursor: 'rubbish' }).cursor).toBeNull()
  })
})

describe('nextCursor', () => {
  const query = parseIssueQuery({ limit: '2' })

  test('points at the last row of a full page', () => {
    const rows = [
      { id: 9, created_at: '2026-08-02' },
      { id: 8, created_at: '2026-08-01' },
    ]

    expect(nextCursor(rows, query)).toEqual({ id: 8 })
  })

  /** A short page is the last one, and a cursor to nothing makes a client ask. */
  test('is null when the page came back short', () => {
    expect(nextCursor([{ id: 9, created_at: '2026-08-02' }], query)).toBeNull()
    expect(nextCursor([], query)).toBeNull()
  })

  /**
   * A cursor has to name a row uniquely or a page boundary lands inside a tie
   * and one of the tied rows is never returned. Ties are constant on these two -
   * a thousand issues with no comments all sort equal - so the boundary is the
   * pair, and the pair has to travel.
   */
  test('carries the sort value on a sort that can tie', () => {
    const sorted = parseIssueQuery({ limit: '1', sort: 'comments' })

    expect(nextCursor([{ id: 3, comments_count: 0 }], sorted)).toEqual({ id: 3, value: '0' })
  })

  test('carries a null value rather than pretending the row had none', () => {
    const sorted = parseIssueQuery({ limit: '1', sort: 'updated' })

    expect(nextCursor([{ id: 3, updated_at: null }], sorted)).toEqual({ id: 3, value: null })
  })

  /** A `Date` stringifies to something Postgres will not take back. */
  test('writes a timestamp in the one spelling that survives the round trip', () => {
    const sorted = parseIssueQuery({ limit: '1', sort: 'updated' })
    const at = new Date('2026-08-02T10:00:00.000Z')

    expect(nextCursor([{ id: 3, updated_at: at }], sorted)).toEqual({ id: 3, value: at.toISOString() })
  })

  /** The id-only form stays, so a cursor already out in the world still works. */
  test('keeps creation order on the id alone', () => {
    expect(nextCursor([{ id: 8, created_at: '2026-08-01' }], parseIssueQuery({ limit: '1' })))
      .toEqual({ id: 8 })
  })
})

describe('isPageable', () => {
  test('every sort pages now', () => {
    expect(isPageable('created')).toBe(true)
    expect(isPageable('updated')).toBe(true)
    expect(isPageable('comments')).toBe(true)
  })
})

/**
 * The boundary a keyset page needs is `col < v OR (col = v AND id < i)`, and
 * the `OR` is exactly what this project's query builder cannot be given safely.
 * The plan splits it along the `OR` into segments that are each an `AND` of
 * single-column comparisons, to be run in order until the page is full.
 *
 * Nulls are the part that is easy to get wrong. Postgres sorts them first on
 * `DESC` and last on `ASC`, and `updated_at` is null on every issue nobody has
 * touched since opening it - most of them, in a young repository.
 */
describe('keysetPlan', () => {
  const at = (params: Record<string, unknown>) => parseIssueQuery(params)

  test('the first page has no boundary at all', () => {
    expect(keysetPlan(at({ sort: 'updated' }))).toEqual([{ kind: 'all' }])
  })

  test('creation order needs one comparison, because its key cannot tie', () => {
    const query = at({ cursor: encodeCursor({ id: 8 }) })

    expect(keysetPlan(query)).toEqual([{ kind: 'afterId', afterId: 8 }])
  })

  test('a sort that ties finishes the tie group, then goes past it', () => {
    const query = at({ sort: 'comments', cursor: encodeCursor({ id: 8, value: '4' }) })

    expect(keysetPlan(query)).toEqual([
      { kind: 'tie', value: '4', afterId: 8 },
      { kind: 'beyond', value: '4' },
    ])
  })

  test('descending, the null block leads, so the non-null rows follow it', () => {
    const query = at({ sort: 'updated', cursor: encodeCursor({ id: 8, value: null }) })

    expect(keysetPlan(query)).toEqual([
      { kind: 'tie', value: null, afterId: 8 },
      { kind: 'nonNulls' },
    ])
  })

  test('ascending, the null block trails, so it is what comes last', () => {
    const query = at({ sort: 'updated', direction: 'asc', cursor: encodeCursor({ id: 8, value: '2026-08-01' }) })

    expect(keysetPlan(query)).toEqual([
      { kind: 'tie', value: '2026-08-01', afterId: 8 },
      { kind: 'beyond', value: '2026-08-01' },
      { kind: 'nulls' },
    ])
  })

  test('ascending, inside the null block there is nothing after it', () => {
    const query = at({ sort: 'updated', direction: 'asc', cursor: encodeCursor({ id: 8, value: null }) })

    expect(keysetPlan(query)).toEqual([{ kind: 'tie', value: null, afterId: 8 }])
  })

  /** A column that cannot be null has no null block to walk through. */
  test('a sort with no nulls never looks for them', () => {
    const query = at({ sort: 'comments', direction: 'asc', cursor: encodeCursor({ id: 8, value: '0' }) })

    expect(keysetPlan(query).some(segment => segment.kind === 'nulls')).toBe(false)
  })
})

describe('cursorValueOf', () => {
  test('reads the column the sort orders by', () => {
    expect(cursorValueOf({ comments_count: 12 }, 'comments')).toBe('12')
    expect(cursorValueOf({ updated_at: '2026-08-01' }, 'updated')).toBe('2026-08-01')
  })

  test('says null for a row that has none', () => {
    expect(cursorValueOf({ updated_at: null }, 'updated')).toBeNull()
    expect(cursorValueOf({}, 'updated')).toBeNull()
  })
})

describe('statesFor', () => {
  test('narrows to one state, or to none at all', () => {
    expect(statesFor('open')).toEqual(['open'])
    expect(statesFor('closed')).toEqual(['closed'])
    expect(statesFor('all')).toBeNull()
  })
})

describe('SORT_COLUMNS', () => {
  test('names a column for every sort', () => {
    expect(SORT_COLUMNS.created).toBe('created_at')
    expect(SORT_COLUMNS.updated).toBe('updated_at')
    expect(SORT_COLUMNS.comments).toBe('comments_count')
  })
})
