// When a deleted repository stops being recoverable.
//
// This is the one piece of this codebase that permanently destroys somebody's
// work, so it is tested for what it *refuses* to delete at least as hard as for
// what it deletes. The directory it sweeps holds the last copy.

import { describe, expect, test } from 'bun:test'
import { retiredPath } from '../../app/Actions/Repo/settings'
import {
  expiredRetirements,
  LOOSE_OBJECT_THRESHOLD,
  needsPacking,
  PACK_THRESHOLD,
  readRetired,
  RETENTION_DAYS,
} from '../../app/Actions/Repo/retention'

const AUGUST = Date.parse('2026-08-05T19:30:00.000Z')
const DAY = 24 * 60 * 60 * 1000

describe('readRetired', () => {
  /**
   * The two have to agree exactly: the name written by the delete is the only
   * record of when it happened, so a reader that cannot parse a writer's output
   * means a repository that is never swept, and one that parses it *wrongly*
   * means a repository swept too early.
   */
  test('reads back what the delete wrote', () => {
    const directory = retiredPath('acme', 'app', AUGUST)!.split('/').pop()!
    const read = readRetired(directory)

    expect(read).not.toBeNull()
    expect(read!.name).toBe('app')
    expect(read!.deletedAtMs).toBe(AUGUST)
  })

  test('round-trips across a range of times, not one lucky one', () => {
    for (const offset of [0, 1, 999, 60_000, 86_400_000, 365 * DAY]) {
      const at = AUGUST + offset
      const directory = retiredPath('acme', 'app', at)!.split('/').pop()!

      expect(readRetired(directory)?.deletedAtMs, String(offset)).toBe(at)
    }
  })

  test('keeps a repository name containing dots intact', () => {
    const directory = retiredPath('acme', 'my.repo.js', AUGUST)!.split('/').pop()!

    expect(readRetired(directory)?.name).toBe('my.repo.js')
  })

  /**
   * Anything unrecognised must read as null, not as a timestamp of zero -
   * which would place it in 1970 and have the sweep delete it on sight.
   */
  test('anything it does not recognise is null, never epoch zero', () => {
    const unrecognised = [
      'app.git',
      'app',
      'app.notatimestamp.git',
      '',
      // Right shape, impossible date. Reading it as zero would place the
      // deletion in 1970 and have the sweep remove it on sight.
      'app.2026-13-45T99-99-99-999Z.git',
    ]

    for (const directory of unrecognised)
      expect(readRetired(directory), directory).toBeNull()
  })
})

describe('expiredRetirements', () => {
  const at = (daysAgo: number) => retiredPath('acme', `r${daysAgo}`, AUGUST - daysAgo * DAY)!.split('/').pop()!

  test('takes what is past the window and leaves what is not', () => {
    const expired = expiredRetirements([at(1), at(29), at(31), at(400)], AUGUST)

    expect(expired.map(entry => entry.name).sort()).toEqual(['r31', 'r400'])
  })

  test('the boundary day is included, so nothing sits at the edge forever', () => {
    expect(expiredRetirements([at(RETENTION_DAYS)], AUGUST)).toHaveLength(1)
    expect(expiredRetirements([at(RETENTION_DAYS - 1)], AUGUST)).toHaveLength(0)
  })

  /** The rule that matters most. */
  test('never returns a directory it could not read', () => {
    const expired = expiredRetirements(
      ['something-else', 'important-backup', 'app.git', '.DS_Store', at(400)],
      AUGUST,
    )

    expect(expired.map(entry => entry.directory)).toEqual([at(400)])
  })

  test('a shorter window can be asked for, and is respected', () => {
    expect(expiredRetirements([at(8)], AUGUST, 7)).toHaveLength(1)
    expect(expiredRetirements([at(8)], AUGUST, 30)).toHaveLength(0)
  })

  test('a deletion in the future is not expired, however it got there', () => {
    const future = retiredPath('acme', 'clock-skew', AUGUST + 10 * DAY)!.split('/').pop()!

    expect(expiredRetirements([future], AUGUST)).toHaveLength(0)
  })

  test('an empty directory sweeps nothing', () => {
    expect(expiredRetirements([], AUGUST)).toEqual([])
  })
})

describe('needsPacking', () => {
  test('packs a repository with a pile of loose objects', () => {
    expect(needsPacking({ looseObjects: LOOSE_OBJECT_THRESHOLD, packs: 1 })).toBe(true)
    expect(needsPacking({ looseObjects: LOOSE_OBJECT_THRESHOLD - 1, packs: 1 })).toBe(false)
  })

  /**
   * Packs matter as much as loose objects: fifty packfiles is fifty indexes to
   * search per object lookup, which is what makes a small repository slow to
   * clone.
   */
  test('packs a repository that has accumulated packfiles', () => {
    expect(needsPacking({ looseObjects: 0, packs: PACK_THRESHOLD })).toBe(true)
    expect(needsPacking({ looseObjects: 0, packs: PACK_THRESHOLD - 1 })).toBe(false)
  })

  test('leaves a freshly packed repository alone', () => {
    expect(needsPacking({ looseObjects: 0, packs: 1 })).toBe(false)
  })
})
