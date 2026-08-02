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
  DEFAULT_LIMIT,
  decodeCursor,
  encodeCursor,
  isPageable,
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
  test('round-trips', () => {
    expect(decodeCursor(encodeCursor({ id: 42 }))).toEqual({ id: 42 })
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
   * and one of the tied rows is never returned. Ties are possible on both of
   * these, and expressing `(value, id) < (x, y)` needs an `OR` the query
   * builder in use cannot be given safely - so rather than hand out a cursor
   * that would repeat rows, these sorts answer one page and say so.
   */
  test('refuses to page a sort whose key is not unique', () => {
    for (const sort of ['updated', 'comments']) {
      const sorted = parseIssueQuery({ limit: '1', sort })

      expect(nextCursor([{ id: 3 }], sorted)).toBeNull()
    }
  })
})

describe('isPageable', () => {
  test('creation order pages, because the id is the order and is unique', () => {
    expect(isPageable('created')).toBe(true)
  })

  test('the sorts that can tie do not', () => {
    expect(isPageable('updated')).toBe(false)
    expect(isPageable('comments')).toBe(false)
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
