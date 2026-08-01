import { describe, expect, it } from 'bun:test'
import type { MappedIssue, MappedPull, MappedReviewComment } from '../../app/Actions/Mirror/github'
import {
  issueRow,
  metadataBackoffSeconds,
  metadataDue,
  planByExternalId,
  planByNumber,
  pullNumberOf,
  pullRow,
  reviewCommentRow,
  threadRow,
} from '../../app/Actions/Mirror/metadata'

function issue(number: number, over: Partial<MappedIssue> = {}): MappedIssue {
  return {
    number,
    title: `issue ${number}`,
    body: '',
    state: 'open',
    labels: [],
    attribution: { userId: null, displayName: null },
    createdAt: null,
    closedAt: null,
    ...over,
  }
}

describe('planByNumber', () => {
  it('creates what is not here and updates what is', () => {
    const plan = planByNumber([issue(1), issue(2)], new Map([[2, { id: 40 }]]))

    expect(plan.create.map(i => i.number)).toEqual([1])
    expect(plan.update).toEqual([{ id: 40, incoming: plan.update[0]!.incoming }])
    expect(plan.update[0]!.incoming.number).toBe(2)
  })

  /**
   * Nothing is ever deleted. An issue that vanished upstream has usually still
   * been read and linked to here, and removing it breaks those links to make
   * the mirror tidier.
   */
  it('never proposes deleting a row that is no longer upstream', () => {
    const plan = planByNumber([issue(1)], new Map([[1, { id: 10 }], [99, { id: 11 }]]))

    expect(plan.create).toEqual([])
    expect(plan.update).toHaveLength(1)
    expect(JSON.stringify(plan)).not.toContain('99')
  })

  it('handles an empty upstream without proposing anything', () => {
    expect(planByNumber([], new Map([[1, { id: 1 }]]))).toEqual({ create: [], update: [] })
  })
})

describe('planByExternalId', () => {
  function comment(externalId: number): MappedReviewComment {
    return {
      externalId,
      path: 'a.ts',
      line: 1,
      side: 'right',
      body: 'x',
      attribution: { userId: null, displayName: null },
      createdAt: null,
      inReplyTo: null,
    }
  }

  it('recognises a comment it already imported, so a re-sync does not duplicate', () => {
    const plan = planByExternalId([comment(5), comment(6)], new Map([[5, { id: 90 }]]))

    expect(plan.create.map(c => c.externalId)).toEqual([6])
    expect(plan.update[0]!.id).toBe(90)
  })
})

describe('issueRow and pullRow attribution', () => {
  /**
   * Exactly one of `author_id` and `external_author` is ever set. Both set
   * would make the interface choose between them, and it would choose wrong
   * half the time.
   */
  it('sets author_id and leaves external_author null for a linked account', () => {
    const row = issueRow(issue(1, { attribution: { userId: 7, displayName: 'chrisbreuer' } }), 3)

    expect(row.author_id).toBe(7)
    expect(row.external_author).toBeNull()
  })

  it('sets external_author and leaves author_id null for an unlinked account', () => {
    const row = issueRow(issue(1, { attribution: { userId: null, displayName: 'a-stranger' } }), 3)

    expect(row.author_id).toBeNull()
    expect(row.external_author).toBe('a-stranger')
  })

  it('marks a mirrored issue as not a pull request', () => {
    // Issues and pull requests share a number sequence, and a mirrored issue
    // landing with this flag set would take a number a pull request needs.
    expect(issueRow(issue(1), 3).is_pull_request).toBe(false)
  })

  it('carries a merged pull request across as merged', () => {
    const pull: MappedPull = {
      number: 4,
      title: 't',
      body: '',
      state: 'merged',
      draft: false,
      headRef: 'feature',
      baseRef: 'main',
      attribution: { userId: null, displayName: 'x' },
      createdAt: null,
      mergedAt: '2026-01-01T00:00:00Z',
    }

    expect(pullRow(pull, 3)).toMatchObject({ state: 'merged', merged_at: '2026-01-01T00:00:00Z' })
  })
})

describe('threadRow', () => {
  function comment(externalId: number, over: Partial<MappedReviewComment> = {}): MappedReviewComment {
    return {
      externalId,
      path: 'src/a.ts',
      line: 12,
      side: 'right',
      body: '',
      attribution: { userId: null, displayName: null },
      createdAt: null,
      inReplyTo: null,
      ...over,
    }
  }

  it('anchors the thread on its root comment', () => {
    const row = threadRow([comment(1), comment(2, { path: 'other.ts', line: 99 })], 8)

    expect(row).toMatchObject({ pull_request_id: 8, path: 'src/a.ts', line: 12, external_id: 1 })
  })

  it('returns nothing for an empty thread rather than an anchorless row', () => {
    expect(threadRow([], 8)).toBeNull()
  })

  it('links a comment to the thread it was placed in', () => {
    expect(reviewCommentRow(comment(3), 55)).toMatchObject({ review_thread_id: 55, external_id: 3 })
  })
})

describe('pullNumberOf', () => {
  /**
   * The repository-wide comment endpoint is one list across every pull request,
   * and the number is only recoverable from the URL. Fetching per pull request
   * instead is one request each, which on a large repository is the difference
   * between one sync and a rate limit.
   */
  it('reads the number out of a pull request url', () => {
    expect(pullNumberOf({ pull_request_url: 'https://api.github.com/repos/a/b/pulls/1234' })).toBe(1234)
  })

  it('is not confused by a trailing path or query', () => {
    expect(pullNumberOf({ pull_request_url: 'https://api.github.com/repos/a/b/pulls/7/comments' })).toBe(7)
    expect(pullNumberOf({ pull_request_url: 'https://api.github.com/repos/a/b/pulls/7?x=1' })).toBe(7)
  })

  it('does not mistake an issue url for a pull request one', () => {
    expect(pullNumberOf({ pull_request_url: 'https://api.github.com/repos/a/b/issues/7' })).toBeNull()
  })

  it('is null when there is no url', () => {
    expect(pullNumberOf({})).toBeNull()
  })
})

describe('metadataDue', () => {
  const now = new Date('2026-01-01T12:00:00Z')

  it('is due when it has never run', () => {
    expect(metadataDue(null, 900, now)).toBe(true)
  })

  it('is not due inside the interval', () => {
    expect(metadataDue('2026-01-01T11:55:00Z', 900, now)).toBe(false)
  })

  it('is due once the interval has passed', () => {
    expect(metadataDue('2026-01-01T11:45:00Z', 900, now)).toBe(true)
  })

  /**
   * A timestamp that will not parse means the recorded state is not
   * trustworthy. Syncing once too often is cheaper than never syncing again.
   */
  it('is due when the recorded time is unreadable', () => {
    expect(metadataDue('not a date', 900, now)).toBe(true)
  })
})

describe('metadataBackoffSeconds', () => {
  it('is the plain interval while nothing is failing', () => {
    expect(metadataBackoffSeconds(0, 900)).toBe(900)
  })

  it('widens with consecutive failures', () => {
    expect(metadataBackoffSeconds(1, 900)).toBe(1800)
    expect(metadataBackoffSeconds(2, 900)).toBe(3600)
  })

  /**
   * A day is the ceiling rather than the end: whatever broke may be fixed, and
   * a mirror that stops checking forever cannot notice.
   */
  it('stops widening at a day and keeps checking', () => {
    expect(metadataBackoffSeconds(50, 900)).toBe(86_400)
  })
})
