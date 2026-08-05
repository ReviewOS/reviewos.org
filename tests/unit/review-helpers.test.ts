// The helpers the review templates call.
//
// They live in resources/functions rather than inside a template because logic
// in a template cannot be tested, and "which threads belong under this line" is
// exactly the kind of thing that goes quietly wrong: a comment printed under
// the line that replaced the one it was written about is worse than no comment.

import { describe, expect, test } from 'bun:test'
import { formatCount, relativeTime, threadsAt } from '../../resources/functions/review'
import { startsCollapsed } from '../../app/Actions/Pull/manifest'

function thread(id: number, path: string, line: number | null, side: 'left' | 'right' = 'right') {
  return { id, path, line, side, resolved: false, outdated: false, comments: [] }
}

const line = (oldLine: number | null, newLine: number | null) => ({
  origin: 'context' as const,
  oldLine,
  newLine,
})

describe('threadsAt', () => {
  test('finds a right-side thread by the new line number', () => {
    const threads = [thread(1, 'a.ts', 10)]

    expect(threadsAt(threads, 'a.ts', line(8, 10))).toHaveLength(1)
  })

  test('a left-side thread matches the old line number', () => {
    const threads = [thread(1, 'a.ts', 8, 'left')]

    expect(threadsAt(threads, 'a.ts', line(8, 10))).toHaveLength(1)
  })

  test('a right-side thread does not match the old number', () => {
    // Matching on both is how a comment lands under the wrong line.
    const threads = [thread(1, 'a.ts', 8)]

    expect(threadsAt(threads, 'a.ts', line(8, 10))).toHaveLength(0)
  })

  test('a thread on another file never matches', () => {
    expect(threadsAt([thread(1, 'b.ts', 10)], 'a.ts', line(10, 10))).toHaveLength(0)
  })

  test('a thread with no line is not placed anywhere', () => {
    expect(threadsAt([thread(1, 'a.ts', null)], 'a.ts', line(1, 1))).toHaveLength(0)
  })

  test('an added line has no old number and still matches on the right', () => {
    expect(threadsAt([thread(1, 'a.ts', 5)], 'a.ts', line(null, 5))).toHaveLength(1)
  })

  test('a removed line has no new number and still matches on the left', () => {
    expect(threadsAt([thread(1, 'a.ts', 5, 'left')], 'a.ts', line(5, null))).toHaveLength(1)
  })

  test('several threads on one line all come back, in order', () => {
    const threads = [thread(1, 'a.ts', 10), thread(2, 'a.ts', 10)]

    expect(threadsAt(threads, 'a.ts', line(9, 10)).map(t => t.id)).toEqual([1, 2])
  })

  test('nothing anchored here is an empty list, not a null', () => {
    expect(threadsAt([], 'a.ts', line(1, 1))).toEqual([])
  })
})

describe('startsCollapsed', () => {
  const small = { path: 'src/app.ts', status: 'modified' as const, additions: 10, deletions: 4 }

  test('an ordinary file starts open', () => {
    expect(startsCollapsed(small)).toBe(false)
  })

  test('a generated file starts collapsed', () => {
    expect(startsCollapsed({ ...small, path: 'bun.lock', additions: 4000, deletions: 12 })).toBe(true)
  })

  test('a very large file starts collapsed even when it is hand written', () => {
    expect(startsCollapsed({ ...small, path: 'src/big.ts', additions: 400, deletions: 200 })).toBe(true)
  })

  test('a file just under the threshold stays open', () => {
    expect(startsCollapsed({ ...small, path: 'src/big.ts', additions: 300, deletions: 200 })).toBe(false)
  })

  // What a deleted file used to contain is not the change. The deletion is,
  // and the header carries that whether the body is open or not.
  test('a deleted file starts collapsed however small it is', () => {
    expect(startsCollapsed({ ...small, status: 'deleted', additions: 0, deletions: 3 })).toBe(true)
  })
})

describe('formatCount', () => {
  test('groups thousands', () => {
    expect(formatCount(1234)).toBe('1,234')
  })

  test('leaves small numbers alone', () => {
    expect(formatCount(7)).toBe('7')
  })

  test('handles zero', () => {
    expect(formatCount(0)).toBe('0')
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-07-30T12:00:00Z')

  test('very recent reads as just now', () => {
    expect(relativeTime('2026-07-30T11:59:40Z', now)).toBe('just now')
  })

  test('minutes', () => {
    expect(relativeTime('2026-07-30T11:30:00Z', now)).toBe('30 minutes ago')
  })

  test('hours', () => {
    expect(relativeTime('2026-07-30T09:00:00Z', now)).toBe('3 hours ago')
  })

  test('days', () => {
    expect(relativeTime('2026-07-27T12:00:00Z', now)).toBe('3 days ago')
  })

  test('uses the singular for one', () => {
    expect(relativeTime('2026-07-29T12:00:00Z', now)).toBe('1 day ago')
  })

  test('years', () => {
    expect(relativeTime('2025-07-30T12:00:00Z', now)).toBe('1 year ago')
  })

  test('an unparseable date renders as nothing rather than Invalid Date', () => {
    expect(relativeTime('not a date', now)).toBe('')
  })
})
