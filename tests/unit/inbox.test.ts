import { describe, expect, it } from 'bun:test'
import {
  collapse,
  filterInbox,
  parseEntry,
  reasonLabel,
  repositoriesIn,
  shortAge,
  unreadCount,
} from '../../app/Actions/Notification/inbox'

/** A stored row, with only what a case cares about spelled out. */
function row(data: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    type: 'review.requested',
    data: JSON.stringify(data),
    read_at: null,
    created_at: '2026-08-07T12:00:00.000Z',
    ...overrides,
  } as any
}

describe('parsing a stored notification', () => {
  it('reads the sentence, the link, and the reason off the row', () => {
    const entry = parseEntry(row({
      title: 'chris requested your review',
      url: '/acme/api/pull/12/files',
      reason: 'review_requested',
      repository: 'acme/api',
      number: 12,
    }))

    expect(entry.title).toBe('chris requested your review')
    expect(entry.url).toBe('/acme/api/pull/12/files')
    expect(entry.reason).toBe('review_requested')
    expect(entry.reasonLabel).toBe('your review was requested')
    expect(entry.repository).toBe('acme/api')
    expect(entry.number).toBe(12)
    expect(entry.read).toBe(false)
  })

  it('survives a row whose data will not parse', () => {
    // The inbox is the channel that has to work when the others do not.
    // Dropping the page because one row of four hundred is malformed turns a
    // cosmetic defect into an outage.
    const entry = parseEntry(row({}, { data: '{not json' }))

    expect(entry.title).toBe('review.requested')
    expect(entry.url).toBe('/notifications')
    expect(entry.reason).toBe('participating')
  })

  it('falls back to the type rather than to a placeholder', () => {
    // `pull_request.merged` is ugly and true. "Notification" is neither.
    const entry = parseEntry(row({ reason: 'watching' }, { type: 'pull_request.merged' }))

    expect(entry.title).toBe('pull_request.merged')
  })

  it('a null data column is an empty object, not a crash', () => {
    expect(parseEntry(row({}, { data: null })).url).toBe('/notifications')
  })

  it('read_at present means read', () => {
    expect(parseEntry(row({}, { read_at: '2026-08-07T13:00:00.000Z' })).read).toBe(true)
  })

  it('an unknown reason still gets a sentence', () => {
    expect(reasonLabel('invented')).toBe('you are subscribed')
  })
})

describe('filtering', () => {
  const entries = [
    parseEntry(row({ reason: 'review_requested', repository: 'acme/api', url: '/a' })),
    parseEntry(row({ reason: 'watching', repository: 'acme/api', url: '/b' }, { id: 2, read_at: 'x' })),
    parseEntry(row({ reason: 'mentioned', repository: 'acme/web', url: '/c' }, { id: 3 })),
  ]

  it('by reason', () => {
    expect(filterInbox(entries, { reason: 'mentioned' }).map(e => e.url)).toEqual(['/c'])
  })

  it('by repository', () => {
    expect(filterInbox(entries, { repository: 'acme/api' }).map(e => e.url)).toEqual(['/a', '/b'])
  })

  it('unread only', () => {
    expect(filterInbox(entries, { unreadOnly: true }).map(e => e.url)).toEqual(['/a', '/c'])
  })

  it('composes, because filters that do not compose lie', () => {
    const left = filterInbox(entries, { repository: 'acme/api', unreadOnly: true })

    expect(left.map(e => e.url)).toEqual(['/a'])
  })

  it('ignores a reason nobody defines rather than matching nothing', () => {
    // A hand-typed query string must not be able to produce an inbox that
    // looks convincingly empty.
    expect(filterInbox(entries, { reason: 'made_up' })).toHaveLength(3)
  })
})

describe('collapsing repeats', () => {
  it('six comments on one pull request are one row and a count', () => {
    const entries = [
      parseEntry(row({ title: 'first', url: '/pr/1' }, { id: 1, created_at: '2026-08-07T10:00:00.000Z' })),
      parseEntry(row({ title: 'second', url: '/pr/1' }, { id: 2, created_at: '2026-08-07T11:00:00.000Z' })),
      parseEntry(row({ title: 'third', url: '/pr/1' }, { id: 3, created_at: '2026-08-07T12:00:00.000Z' })),
    ]

    const groups = collapse(entries)

    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
  })

  it('the newest supplies the sentence, because that is the state they will find', () => {
    // "review submitted" over "review requested": the older line would send
    // somebody to do work that is already done.
    const groups = collapse([
      parseEntry(row({ title: 'chris requested your review', url: '/pr/1' }, { id: 1, created_at: '2026-08-07T10:00:00.000Z' })),
      parseEntry(row({ title: 'chris approved it', url: '/pr/1' }, { id: 2, created_at: '2026-08-07T12:00:00.000Z' })),
    ])

    expect(groups[0].title).toBe('chris approved it')
    expect(groups[0].id).toBe(2)
  })

  it('a group is unread if anything in it is', () => {
    // Hiding one unread row behind five read ones loses exactly the
    // notification worth keeping.
    const groups = collapse([
      parseEntry(row({ url: '/pr/1' }, { id: 1, read_at: 'seen' })),
      parseEntry(row({ url: '/pr/1' }, { id: 2, read_at: null })),
    ])

    expect(groups[0].read).toBe(false)
  })

  it('different destinations stay separate', () => {
    const groups = collapse([
      parseEntry(row({ url: '/pr/1' }, { id: 1 })),
      parseEntry(row({ url: '/pr/2' }, { id: 2 })),
    ])

    expect(groups).toHaveLength(2)
  })

  it('newest first', () => {
    const groups = collapse([
      parseEntry(row({ url: '/old' }, { id: 1, created_at: '2026-08-01T00:00:00.000Z' })),
      parseEntry(row({ url: '/new' }, { id: 2, created_at: '2026-08-07T00:00:00.000Z' })),
    ])

    expect(groups.map(g => g.url)).toEqual(['/new', '/old'])
  })
})

describe('the repository strip', () => {
  it('counts unread per repository, noisiest first', () => {
    const entries = [
      parseEntry(row({ repository: 'acme/web', url: '/a' }, { id: 1 })),
      parseEntry(row({ repository: 'acme/api', url: '/b' }, { id: 2 })),
      parseEntry(row({ repository: 'acme/api', url: '/c' }, { id: 3 })),
      parseEntry(row({ repository: 'acme/api', url: '/d' }, { id: 4, read_at: 'seen' })),
    ]

    expect(repositoriesIn(entries)).toEqual([
      { repository: 'acme/api', unread: 2, total: 3 },
      { repository: 'acme/web', unread: 1, total: 1 },
    ])
  })

  it('leaves out rows that carry no repository', () => {
    expect(repositoriesIn([parseEntry(row({ url: '/a' }))])).toEqual([])
  })
})

describe('unread counting', () => {
  it('counts what has not been read', () => {
    expect(unreadCount([
      parseEntry(row({ url: '/a' }, { id: 1 })),
      parseEntry(row({ url: '/b' }, { id: 2, read_at: 'seen' })),
    ])).toBe(1)
  })
})

describe('age, in the shortest form that is still true', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z')

  it('under a minute is now', () => {
    expect(shortAge(now - 30_000, now)).toBe('now')
  })

  it('minutes, hours, days', () => {
    expect(shortAge(now - 5 * 60_000, now)).toBe('5m')
    expect(shortAge(now - 3 * 3_600_000, now)).toBe('3h')
    expect(shortAge(now - 2 * 86_400_000, now)).toBe('2d')
  })

  it('past a week it is a date, because nobody counts 9d on their fingers', () => {
    expect(shortAge(Date.parse('2026-07-20T12:00:00.000Z'), now)).toBe('2026-07-20')
  })

  it('a clock that disagrees does not produce a negative age', () => {
    expect(shortAge(now + 60_000, now)).toBe('now')
  })
})
