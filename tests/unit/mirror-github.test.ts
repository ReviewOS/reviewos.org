import { describe, expect, it } from 'bun:test'
import {
  attribute,
  buildThreads,
  commentLine,
  commentSide,
  issueState,
  mapIssue,
  type MappedReviewComment,
  mapPull,
  mapReviewComment,
  normalizeLabels,
  onlyIssues,
  pullState,
} from '../../app/Actions/Mirror/github'

const linked = new Map([['chrisbreuer', 7]])

describe('pullState', () => {
  /**
   * GitHub reports a merged pull request as `closed`. Losing the distinction
   * loses the thing the review screen is built around.
   */
  it('reads merged from merged_at, not from state', () => {
    expect(pullState({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' })).toBe('merged')
  })

  it('is closed when closed without merging', () => {
    expect(pullState({ state: 'closed', merged_at: null })).toBe('closed')
  })

  it('is open otherwise', () => {
    expect(pullState({ state: 'open' })).toBe('open')
  })
})

describe('issueState', () => {
  it('maps open and closed', () => {
    expect(issueState({ state: 'open' })).toBe('open')
    expect(issueState({ state: 'closed' })).toBe('closed')
  })

  it('treats anything unfamiliar as open', () => {
    expect(issueState({})).toBe('open')
  })
})

describe('onlyIssues', () => {
  /**
   * GitHub's issues endpoint returns pull requests too, told apart only by a
   * `pull_request` key. Importing without filtering creates a duplicate issue
   * for every pull request, each holding a number a real issue may occupy.
   */
  it('drops pull requests returned by the issues endpoint', () => {
    const items = [
      { number: 1, title: 'a real issue' },
      { number: 2, title: 'actually a pull request', pull_request: { url: 'x' } },
    ]

    expect(onlyIssues(items).map(i => i.number)).toEqual([1])
  })

  it('drops entries with no number, since the number is the identity', () => {
    expect(onlyIssues([{ title: 'no number' }])).toEqual([])
  })
})

describe('normalizeLabels', () => {
  it('accepts objects and bare strings alike', () => {
    expect(normalizeLabels([{ name: 'bug', color: 'ff0000' }, 'chore']))
      .toEqual([{ name: 'bug', color: 'ff0000' }, { name: 'chore', color: null }])
  })

  it('drops duplicates and empties', () => {
    expect(normalizeLabels(['bug', 'bug', '', { name: '' }])).toEqual([{ name: 'bug', color: null }])
  })

  it('tolerates a missing list', () => {
    expect(normalizeLabels(undefined)).toEqual([])
  })
})

describe('attribute', () => {
  it('links a known account to its local user', () => {
    expect(attribute({ login: 'chrisbreuer' }, linked)).toEqual({ userId: 7, displayName: 'chrisbreuer' })
  })

  it('matches case-insensitively, as GitHub logins are', () => {
    expect(attribute({ login: 'ChrisBreuer' }, linked).userId).toBe(7)
  })

  /**
   * The rule worth being strict about: an unlinked account is shown by name and
   * attributed to nobody. Assigning it to a local user who happens to share a
   * handle puts words in someone's mouth.
   */
  it('attributes an unlinked account to nobody, but keeps the name visible', () => {
    expect(attribute({ login: 'a-stranger' }, linked)).toEqual({ userId: null, displayName: 'a-stranger' })
  })

  it('handles a deleted account with no login', () => {
    expect(attribute(null, linked)).toEqual({ userId: null, displayName: null })
  })
})

describe('mapIssue', () => {
  it('preserves the number, so cross-references keep pointing at the same thing', () => {
    const mapped = mapIssue({ number: 123, title: 'x', state: 'open' }, linked)

    expect(mapped?.number).toBe(123)
  })

  it('carries state, labels and author across', () => {
    const mapped = mapIssue({
      number: 4,
      title: 'a bug',
      body: 'details',
      state: 'closed',
      user: { login: 'chrisbreuer' },
      labels: ['bug'],
      closed_at: '2026-01-02T00:00:00Z',
    }, linked)

    expect(mapped).toMatchObject({
      number: 4,
      state: 'closed',
      closedAt: '2026-01-02T00:00:00Z',
    })
    expect(mapped?.labels).toEqual([{ name: 'bug', color: null }])
    expect(mapped?.attribution.userId).toBe(7)
  })

  it('refuses an entry with no number rather than inventing one', () => {
    expect(mapIssue({ title: 'x' }, linked)).toBeNull()
  })
})

describe('mapPull', () => {
  it('preserves the number and reads merged correctly', () => {
    const mapped = mapPull({
      number: 900,
      title: 'a change',
      state: 'closed',
      merged_at: '2026-01-03T00:00:00Z',
      head: { ref: 'feature' },
      base: { ref: 'main' },
    }, linked)

    expect(mapped).toMatchObject({ number: 900, state: 'merged', headRef: 'feature', baseRef: 'main' })
  })

  it('carries the draft flag, which changes what the screen offers', () => {
    expect(mapPull({ number: 1, draft: true }, linked)?.draft).toBe(true)
  })
})

describe('commentSide and commentLine', () => {
  it('reads the side GitHub gives', () => {
    expect(commentSide({ side: 'LEFT' })).toBe('left')
    expect(commentSide({ side: 'RIGHT' })).toBe('right')
  })

  it('defaults to the right side, where new code lives', () => {
    expect(commentSide({})).toBe('right')
  })

  it('prefers the current line so a comment stays attached to the code as it is', () => {
    expect(commentLine({ line: 42, original_line: 7 })).toBe(42)
  })

  it('falls back to the original line rather than losing the anchor', () => {
    expect(commentLine({ line: null, original_line: 7 })).toBe(7)
  })

  it('is null when there is no usable line', () => {
    expect(commentLine({})).toBeNull()
  })
})

describe('mapReviewComment', () => {
  it('keeps the external id, so a re-sync updates rather than duplicates', () => {
    const mapped = mapReviewComment({ id: 55, path: 'src/a.ts', line: 3, body: 'hm' }, linked)

    expect(mapped).toMatchObject({ externalId: 55, path: 'src/a.ts', line: 3, side: 'right' })
  })

  it('refuses a comment with no path, which cannot be anchored', () => {
    expect(mapReviewComment({ id: 1, body: 'x' }, linked)).toBeNull()
  })
})

describe('buildThreads', () => {
  function comment(id: number, inReplyTo: number | null, createdAt: string): MappedReviewComment {
    return {
      externalId: id,
      path: 'a.ts',
      line: 1,
      side: 'right',
      body: `#${id}`,
      attribution: { userId: null, displayName: 'x' },
      createdAt,
      inReplyTo,
    }
  }

  it('groups replies under their root', () => {
    const threads = buildThreads([
      comment(1, null, '2026-01-01T00:00:00Z'),
      comment(2, 1, '2026-01-01T00:01:00Z'),
      comment(3, null, '2026-01-01T00:02:00Z'),
    ])

    expect(threads).toHaveLength(2)
    expect(threads.find(t => t.length === 2)!.map(c => c.externalId)).toEqual([1, 2])
  })

  it('orders a conversation as it happened, not as the API returned it', () => {
    const threads = buildThreads([
      comment(2, 1, '2026-01-01T00:05:00Z'),
      comment(1, null, '2026-01-01T00:00:00Z'),
    ])

    expect(threads[0]!.map(c => c.externalId)).toEqual([1, 2])
  })

  /**
   * A reply whose root was never imported is still something someone wrote;
   * dropping it loses a comment silently.
   */
  it('keeps an orphaned reply as its own thread', () => {
    const threads = buildThreads([comment(9, 999, '2026-01-01T00:00:00Z')])

    expect(threads).toHaveLength(1)
    expect(threads[0]![0]!.externalId).toBe(9)
  })

  it('returns nothing for no comments', () => {
    expect(buildThreads([])).toEqual([])
  })
})

describe('GitHub client paging and limits', () => {
  it('reads rel="next" rather than guessing from page size', async () => {
    // A collection that is an exact multiple of the page size looks full on its
    // last page, so guessing loops forever or stops one page early.
    const { hasNextPage } = await import('../../app/Actions/Mirror/github-client')

    expect(hasNextPage(new Headers({ link: '<https://api.github.com/x?page=2>; rel="next"' }))).toBe(true)
    expect(hasNextPage(new Headers({ link: '<https://api.github.com/x?page=1>; rel="prev"' }))).toBe(false)
    expect(hasNextPage(new Headers())).toBe(false)
  })

  it('tells a rate limit apart from a permission failure', async () => {
    // Both are 403, and they want opposite responses: retry one, never the
    // other.
    const { isRateLimited } = await import('../../app/Actions/Mirror/github-client')

    expect(isRateLimited(403, new Headers({ 'x-ratelimit-remaining': '0' }))).toBe(true)
    expect(isRateLimited(403, new Headers({ 'x-ratelimit-remaining': '4999' }))).toBe(false)
    expect(isRateLimited(200, new Headers({ 'x-ratelimit-remaining': '0' }))).toBe(false)
  })

  it('reports how long a limit lasts, and guesses sanely without a header', async () => {
    const { resetDelayMs } = await import('../../app/Actions/Mirror/github-client')
    const now = new Date('2026-01-01T00:00:00Z')
    const reset = String(Math.floor(now.getTime() / 1000) + 120)

    expect(resetDelayMs(new Headers({ 'x-ratelimit-reset': reset }), now)).toBe(120_000)
    expect(resetDelayMs(new Headers(), now)).toBe(60_000)
  })

  it('follows pages and stops when there is no next', async () => {
    const { GitHubClient } = await import('../../app/Actions/Mirror/github-client')
    const pages = [
      { body: [{ number: 1 }], link: '<x>; rel="next"' },
      { body: [{ number: 2 }], link: '' },
    ]
    let call = 0

    const client = new GitHubClient({
      fetchImpl: (async () => {
        const page = pages[call++]!
        return new Response(JSON.stringify(page.body), { status: 200, headers: { link: page.link } })
      }) as any,
    })

    const result = await client.collect<{ number: number }>('/repos/a/b/issues')

    expect(result.ok).toBe(true)
    expect(result.items.map(i => i.number)).toEqual([1, 2])
    expect(call).toBe(2)
  })

  it('reports a 404 as a repository problem, not a crash', async () => {
    const { GitHubClient } = await import('../../app/Actions/Mirror/github-client')
    const client = new GitHubClient({
      fetchImpl: (async () => new Response('{}', { status: 404 })) as any,
    })

    const result = await client.collect('/repos/a/b/issues')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('keeps what it already collected when a later page fails', async () => {
    // A partial import that says so beats losing the pages that worked.
    const { GitHubClient } = await import('../../app/Actions/Mirror/github-client')
    let call = 0
    const client = new GitHubClient({
      fetchImpl: (async () => {
        if (call++ === 0)
          return new Response(JSON.stringify([{ number: 1 }]), { status: 200, headers: { link: '<x>; rel="next"' } })
        return new Response('{}', { status: 500 })
      }) as any,
    })

    const result = await client.collect<{ number: number }>('/repos/a/b/issues')

    expect(result.ok).toBe(false)
    expect(result.items.map(i => i.number)).toEqual([1])
  })
})
