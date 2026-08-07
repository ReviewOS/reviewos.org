/**
 * Who to suggest, and why it is not simply "whoever committed most".
 *
 * The ranking is the feature, so it is a pure function over values and argued
 * about here rather than in a browser. Three properties matter more than the
 * exact numbers, and each has a failure that looks like the feature working:
 *
 *   - recency has to beat volume, or a file's expert is whoever wrote it in
 *     2019 and has not opened it since;
 *   - load has to discount, or the same three people are suggested for
 *     everything, get buried, and stop answering;
 *   - being busy must not make somebody invisible, or the only person who has
 *     ever touched a file stops being suggested for it.
 */

import { describe, expect, test } from 'bun:test'
import { loadWeight, recencyWeight, RECENCY_HALF_LIFE_DAYS, suggestReviewers } from '../../app/Actions/Pull/suggest'

const NOW = Date.parse('2026-08-07T12:00:00.000Z')
const DAY = 86_400_000

function daysAgo(days: number): number {
  return NOW - days * DAY
}

describe('recencyWeight', () => {
  test('something touched today counts fully', () => {
    expect(recencyWeight(NOW, NOW)).toBeCloseTo(1, 5)
  })

  test('halves over the half-life', () => {
    expect(recencyWeight(daysAgo(RECENCY_HALF_LIFE_DAYS), NOW)).toBeCloseTo(0.5, 5)
    expect(recencyWeight(daysAgo(RECENCY_HALF_LIFE_DAYS * 2), NOW)).toBeCloseTo(0.25, 5)
  })

  /**
   * A curve rather than a threshold. There is no honest date on which somebody
   * stops knowing a file, and a cliff would put one there - ranking two people
   * either side of it as though one had never seen the code.
   */
  test('decays smoothly rather than falling off a cliff', () => {
    const before = recencyWeight(daysAgo(89), NOW)
    const after = recencyWeight(daysAgo(91), NOW)

    expect(before).toBeGreaterThan(after)
    expect(before - after).toBeLessThan(0.02)
  })

  test('a commit dated in the future is not worth more than one today', () => {
    expect(recencyWeight(NOW + 10 * DAY, NOW)).toBeCloseTo(1, 5)
  })
})

describe('loadWeight', () => {
  test('somebody with nothing waiting counts fully', () => {
    expect(loadWeight(0)).toBe(1)
  })

  test('each open request takes a share off', () => {
    expect(loadWeight(3)).toBeCloseTo(0.5, 5)
    expect(loadWeight(9)).toBeCloseTo(0.25, 5)
  })

  /**
   * Never zero. Somebody buried in requests is still the right suggestion when
   * they are the only person who has touched the file: being busy is a reason
   * to prefer somebody else, not a reason to be invisible.
   */
  test('being very busy never makes somebody worthless', () => {
    expect(loadWeight(1000)).toBeGreaterThan(0)
  })

  test('a negative count is treated as none rather than as a bonus', () => {
    expect(loadWeight(-5)).toBe(1)
  })
})

describe('suggestReviewers', () => {
  /**
   * The whole point of weighting by recency. Somebody with three times the
   * commits who has not been in the file for a year loses to somebody who was
   * in it last week.
   */
  test('recent beats prolific-but-absent', () => {
    const suggestions = suggestReviewers({
      now: NOW,
      contributions: [
        { handle: 'ancient', commits: 30, lastTouched: daysAgo(400) },
        { handle: 'recent', commits: 4, lastTouched: daysAgo(7) },
      ],
    })

    expect(suggestions[0]!.handle).toBe('recent')
  })

  test('between two equally recent people, more commits wins', () => {
    const suggestions = suggestReviewers({
      now: NOW,
      contributions: [
        { handle: 'occasional', commits: 2, lastTouched: daysAgo(5) },
        { handle: 'regular', commits: 9, lastTouched: daysAgo(5) },
      ],
    })

    expect(suggestions[0]!.handle).toBe('regular')
  })

  /**
   * Without this the same three people are suggested for everything, get
   * buried, and stop answering - and a review culture ends up with three
   * bottlenecks and everybody else out of practice.
   */
  test('a full queue hands the suggestion to somebody else', () => {
    const contributions = [
      { handle: 'busy', commits: 10, lastTouched: daysAgo(5) },
      { handle: 'free', commits: 7, lastTouched: daysAgo(5) },
    ]

    expect(suggestReviewers({ now: NOW, contributions })[0]!.handle).toBe('busy')
    expect(suggestReviewers({ now: NOW, contributions, load: { busy: 12 } })[0]!.handle).toBe('free')
  })

  test('the only person who has touched the file is still suggested, however buried', () => {
    const suggestions = suggestReviewers({
      now: NOW,
      contributions: [{ handle: 'buried', commits: 3, lastTouched: daysAgo(2) }],
      load: { buried: 500 },
    })

    expect(suggestions.map(one => one.handle)).toEqual(['buried'])
  })

  test('the author and anybody already asked are left out', () => {
    const suggestions = suggestReviewers({
      now: NOW,
      contributions: [
        { handle: 'author', commits: 20, lastTouched: daysAgo(1) },
        { handle: 'alreadyAsked', commits: 15, lastTouched: daysAgo(1) },
        { handle: 'fresh', commits: 2, lastTouched: daysAgo(1) },
      ],
      exclude: ['AUTHOR', 'alreadyasked'],
    })

    expect(suggestions.map(one => one.handle)).toEqual(['fresh'])
  })

  test('says why, so nobody clicks a name they cannot account for', () => {
    const [suggestion] = suggestReviewers({
      now: NOW,
      contributions: [{ handle: 'alice', commits: 4, lastTouched: daysAgo(3) }],
      load: { alice: 2 },
    })

    expect(suggestion!.reason).toBe('4 commits here, last 3d ago, 2 waiting on them')
  })

  test('one commit today reads as one commit today', () => {
    const [suggestion] = suggestReviewers({
      now: NOW,
      contributions: [{ handle: 'alice', commits: 1, lastTouched: NOW }],
    })

    expect(suggestion!.reason).toBe('1 commit here, last today')
  })

  test('holds to the limit, and defaults to a shortlist rather than a directory', () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      handle: `person${index}`,
      commits: 10 - index,
      lastTouched: daysAgo(1),
    }))

    expect(suggestReviewers({ now: NOW, contributions: many })).toHaveLength(3)
    expect(suggestReviewers({ now: NOW, contributions: many, limit: 5 })).toHaveLength(5)
  })

  /**
   * Two people with identical histories must come back in the same order every
   * time, rather than in whatever order git happened to report them.
   */
  test('ties break the same way twice', () => {
    const same = { commits: 5, lastTouched: daysAgo(10) }
    const forwards = suggestReviewers({ now: NOW, contributions: [{ handle: 'zoe', ...same }, { handle: 'amy', ...same }] })
    const backwards = suggestReviewers({ now: NOW, contributions: [{ handle: 'amy', ...same }, { handle: 'zoe', ...same }] })

    expect(forwards.map(one => one.handle)).toEqual(['amy', 'zoe'])
    expect(backwards.map(one => one.handle)).toEqual(['amy', 'zoe'])
  })

  test('nobody having touched it suggests nobody, rather than guessing', () => {
    expect(suggestReviewers({ now: NOW, contributions: [] })).toEqual([])
  })

  test('everybody excluded suggests nobody', () => {
    expect(suggestReviewers({
      now: NOW,
      contributions: [{ handle: 'only', commits: 3, lastTouched: NOW }],
      exclude: ['only'],
    })).toEqual([])
  })
})
