import { describe, expect, it } from 'bun:test'
import {
  channelFor,
  describeChange,
  isPresent,
  presenceText,
  PRESENCE_TTL_MS,
  roster,
} from '../../app/Actions/Pull/live'

/** A reading, with only what a case cares about spelled out. */
function state(overrides: Partial<Parameters<typeof describeChange>[0]> = {}) {
  return { comments: 0, reviews: 0, head: 'aaa', state: 'open', watching: [], ...overrides }
}

describe('what moved', () => {
  it('says nothing when nothing did', () => {
    const change = describeChange(state(), state())

    expect(change.changed).toBe(false)
    expect(change.summary).toBe('')
  })

  it('counts new comments, in words a reader can act on', () => {
    expect(describeChange(state(), state({ comments: 3 })).summary).toBe('3 new comments')
    expect(describeChange(state(), state({ comments: 1 })).summary).toBe('1 new comment')
  })

  it('counts reviews separately, because they mean something different', () => {
    // Three comments is a conversation. One review is a verdict, and burying it
    // in a comment count is how somebody misses that they are unblocked.
    expect(describeChange(state(), state({ reviews: 1 })).summary).toBe('1 new review')
  })

  it('never counts down', () => {
    // A deleted comment must not report "-1 new comments". The reading is a
    // count, not a ledger, and deletions are not news.
    expect(describeChange(state({ comments: 5 }), state({ comments: 3 })).changed).toBe(false)
  })
})

describe('stale, which is a different message', () => {
  it('a new comment is not stale', () => {
    // What is on screen is still correct; there is simply more of it.
    expect(describeChange(state(), state({ comments: 2 })).stale).toBe(false)
  })

  it('a new head commit is', () => {
    // Every line number on screen may have moved, and a draft anchored to one
    // is now anchored to the wrong line.
    const change = describeChange(state(), state({ head: 'bbb' }))

    expect(change.stale).toBe(true)
    expect(change.summary).toContain('new commits')
  })

  it('so is a state change', () => {
    const change = describeChange(state(), state({ state: 'merged' }))

    expect(change.stale).toBe(true)
    expect(change.summary).toContain('merged')
  })

  it('an unknown head on either side is not a force push', () => {
    // A missing sha means we do not know, and "we do not know" must not render
    // as "the branch moved" - which would tell every reader their diff is
    // stale the moment a column is null.
    expect(describeChange(state({ head: '' }), state({ head: 'bbb' })).stale).toBe(false)
    expect(describeChange(state(), state({ head: '' })).stale).toBe(false)
  })
})

describe('the presence roster', () => {
  it('leaves the reader out of their own', () => {
    // "You are looking at this" is not information, and including it makes an
    // empty room read as one person.
    expect(roster(['chris', 'ada'], 'chris').shown).toEqual(['ada'])
  })

  it('is an empty roster when nobody else is here', () => {
    expect(roster(['chris'], 'chris')).toEqual({ shown: [], extra: 0 })
  })

  it('deduplicates, because two tabs are one person', () => {
    expect(roster(['ada', 'ada', 'grace'], 'chris').shown).toEqual(['ada', 'grace'])
  })

  it('caps, and counts the rest', () => {
    // Presence is a glance. Thirty faces is a widget rather than an answer.
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

    expect(roster(many, 'chris', 5)).toEqual({ shown: ['a', 'b', 'c', 'd', 'e'], extra: 2 })
  })

  it('drops empty handles rather than rendering a gap', () => {
    expect(roster(['', 'ada'], 'chris').shown).toEqual(['ada'])
  })
})

describe('the presence sentence', () => {
  it('names one person', () => {
    expect(presenceText(['ada'], 0)).toBe('ada is looking at this')
  })

  it('joins two', () => {
    expect(presenceText(['ada', 'grace'], 0)).toBe('ada and grace are looking at this')
  })

  it('counts the rest past a handful', () => {
    expect(presenceText(['ada', 'grace', 'alan'], 4)).toBe('ada, grace and 5 others are looking at this')
  })

  it('says nothing for nobody', () => {
    expect(presenceText([], 0)).toBe('')
  })
})

describe('how long presence lasts', () => {
  const now = 1_700_000_000_000

  it('a recent heartbeat counts', () => {
    expect(isPresent(now - 5_000, now)).toBe(true)
  })

  it('an old one does not', () => {
    expect(isPresent(now - PRESENCE_TTL_MS - 1, now)).toBe(false)
  })

  it('the window is generous on purpose', () => {
    // A laptop that slept for thirty seconds must not flicker out and back in.
    // The flicker is worse than the staleness: it makes the whole signal look
    // unreliable, and then nobody believes the roster.
    expect(isPresent(now - 30_000, now)).toBe(true)
    expect(PRESENCE_TTL_MS).toBeGreaterThanOrEqual(60_000)
  })
})

describe('the channel name', () => {
  it('is per repository and per pull request', () => {
    // Not per number alone: pull request 12 exists in every repository, and a
    // channel keyed on the number would broadcast one team's activity to
    // another and leak presence across repositories.
    expect(channelFor(3, 12)).toBe('pull.3.12')
    expect(channelFor(4, 12)).not.toBe(channelFor(3, 12))
  })
})
