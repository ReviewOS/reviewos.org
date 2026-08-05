// Which release is the latest, and what a release may be called.
//
// "Latest" is the answer every download button and every install script
// depends on, so it is tested against the two orderings that look right and are
// not: v10 sorting under v9 alphabetically, and a release published today from
// an old branch outranking a newer version published last month.

import { describe, expect, test } from 'bun:test'
import {
  compareTags,
  decideRelease,
  DRAFT,
  isDraft,
  isUsableTagName,
  latestRelease,
  looksLikePrerelease,
  PUBLISHED,
  sortReleases,
} from '../../app/Actions/Repo/releases'

const NOW = '2026-08-05T20:00:00.000Z'

describe('isUsableTagName', () => {
  test('takes the shapes people actually tag with', () => {
    for (const tag of ['v1.0.0', '1.0.0', 'v2.0.0-rc.1', 'release-2026-08', 'v1.0.0+build.7'])
      expect(isUsableTagName(tag), tag).toBe(true)
  })

  /** A tag goes into a URL, so a slash would be a path segment forever. */
  test('refuses a slash, however normal it is in git', () => {
    expect(isUsableTagName('release/1.0')).toBe(false)
  })

  test('refuses what git itself refuses', () => {
    for (const tag of ['-v1', '.hidden', 'v1.', 'v1..0', 'v1@{0}', '', '   '])
      expect(isUsableTagName(tag), JSON.stringify(tag)).toBe(false)
  })

  test('refuses a name nobody could read back', () => {
    expect(isUsableTagName('v'.repeat(101))).toBe(false)
  })
})

describe('compareTags', () => {
  /**
   * The comparison people notice. Alphabetically `v1.10.0` sorts above
   * `v1.9.0`, so a list ordered by name puts a two-year-old release on top and
   * every script that takes the first entry installs it.
   */
  test('ten is newer than nine', () => {
    expect(compareTags('v1.10.0', 'v1.9.0')).toBeLessThan(0)
    expect([...['v1.9.0', 'v1.10.0', 'v1.2.0']].sort(compareTags)).toEqual(['v1.10.0', 'v1.9.0', 'v1.2.0'])
  })

  test('a missing minor or patch is zero, not a different version', () => {
    expect(compareTags('v2', 'v2.0.0')).toBe(0)
    expect(compareTags('v2.1', 'v2.1.0')).toBe(0)
  })

  test('a leading v changes nothing', () => {
    expect(compareTags('v1.2.3', '1.2.3')).toBe(0)
  })

  test('build metadata does not affect precedence', () => {
    expect(compareTags('1.0.0+build.1', '1.0.0+build.99')).toBe(0)
  })

  /** Semver's own rule, and the reason an rc must not be offered as the release. */
  test('a release outranks its own prereleases', () => {
    expect(compareTags('1.0.0', '1.0.0-rc.1')).toBeLessThan(0)
    expect(compareTags('1.0.0-rc.1', '1.0.0')).toBeGreaterThan(0)
  })

  test('rc.9 comes before rc.10, because those are numbers', () => {
    expect(compareTags('1.0.0-rc.10', '1.0.0-rc.9')).toBeLessThan(0)
  })

  test('alpha, beta then rc, in that order', () => {
    expect(sortReleases([
      { tag_name: '1.0.0-rc.1' },
      { tag_name: '1.0.0-alpha.1' },
      { tag_name: '1.0.0-beta.1' },
    ]).map(release => release.tag_name)).toEqual(['1.0.0-rc.1', '1.0.0-beta.1', '1.0.0-alpha.1'])
  })

  test('a shorter prerelease precedes a longer one with the same prefix', () => {
    expect(compareTags('1.0.0-rc.1', '1.0.0-rc')).toBeLessThan(0)
  })

  test('tags that are not versions fall back to something stable', () => {
    const sorted = sortReleases([{ tag_name: 'nightly' }, { tag_name: 'stable' }, { tag_name: 'v1.0.0' }])

    expect(sorted).toHaveLength(3)
    // Whatever the order, it must be total and repeatable.
    expect(sortReleases(sorted)).toEqual(sorted)
  })
})

describe('latestRelease', () => {
  /**
   * The case that makes "most recently published" wrong: a patch backported to
   * an old branch and published today.
   */
  test('is the highest version, not the most recent publication', () => {
    const releases = [
      { tag_name: 'v1.4.0', published_at: '2026-06-01T00:00:00Z' },
      { tag_name: 'v1.2.1', published_at: '2026-08-05T00:00:00Z' },
    ]

    expect(latestRelease(releases)!.tag_name).toBe('v1.4.0')
  })

  test('is never a prerelease', () => {
    const releases = [
      { tag_name: 'v2.0.0-rc.1', is_prerelease: true },
      { tag_name: 'v1.9.0' },
    ]

    expect(latestRelease(releases)!.tag_name).toBe('v1.9.0')
  })

  test('is never a draft', () => {
    const releases = [
      { tag_name: 'v3.0.0', status: DRAFT },
      { tag_name: 'v2.0.0', status: PUBLISHED },
    ]

    expect(latestRelease(releases)!.tag_name).toBe('v2.0.0')
  })

  test('is null when everything is a draft or a prerelease', () => {
    expect(latestRelease([{ tag_name: 'v1.0.0-rc.1', is_prerelease: true }])).toBeNull()
    expect(latestRelease([])).toBeNull()
  })
})

describe('looksLikePrerelease', () => {
  test('recognises the suffixes every scheme uses', () => {
    for (const tag of ['v1.0.0-rc.1', '2.0.0-beta', '0.4.0-alpha.2', 'v1-canary', 'v2.0.0-nightly'])
      expect(looksLikePrerelease(tag), tag).toBe(true)
  })

  test('a plain version is not one', () => {
    for (const tag of ['v1.0.0', '2.3.4', 'v1.0.0+build.1'])
      expect(looksLikePrerelease(tag), tag).toBe(false)
  })

  /** A guess offered as a default, not a rule: the flag on the row decides. */
  test('does not fire on a word that merely contains one', () => {
    expect(looksLikePrerelease('v1.0.0-alphabetical')).toBe(false)
  })
})

describe('decideRelease', () => {
  test('publishing stamps the date', () => {
    const decision = decideRelease({ tag_name: 'v1.0.0', is_draft: false }, NOW)

    expect(decision).toMatchObject({ ok: true, changes: { tag_name: 'v1.0.0', status: PUBLISHED, published_at: NOW } })
  })

  test('a draft has no publication date', () => {
    expect(decideRelease({ tag_name: 'v1.0.0', is_draft: true }, NOW))
      .toMatchObject({ changes: { status: DRAFT, published_at: null } })
  })

  /**
   * One column rather than a second `is_draft` flag beside the framework's own
   * `status`, because two columns for one question is two columns that can
   * disagree.
   */
  test('draftness is the status column, not a flag of its own', () => {
    const changes = (decideRelease({ is_draft: true }, NOW) as any).changes

    expect(changes.is_draft).toBeUndefined()
    expect(changes.status).toBe(DRAFT)
    expect(isDraft({ tag_name: 'v1', status: DRAFT })).toBe(true)
    expect(isDraft({ tag_name: 'v1', status: PUBLISHED })).toBe(false)
  })

  /**
   * "Published, with no publication date" and "a draft that says when it was
   * published" are both rows nothing else in the product can read.
   */
  test('going back to a draft takes the date with it', () => {
    const decision = decideRelease({ is_draft: true }, NOW, { status: PUBLISHED, published_at: '2026-01-01T00:00:00Z' })

    expect(decision).toMatchObject({ changes: { status: DRAFT, published_at: null } })
  })

  test('editing an already published release does not restamp it', () => {
    const decision = decideRelease({ body: 'Fixed a typo', is_draft: false }, NOW, {
      status: PUBLISHED,
      published_at: '2026-01-01T00:00:00Z',
    })

    expect((decision as any).changes.published_at).toBeUndefined()
  })

  test('refuses a tag name it would not accept', () => {
    expect(decideRelease({ tag_name: 'release/1.0' }, NOW)).toMatchObject({ ok: false, status: 422 })
  })

  test('refuses a change that changes nothing', () => {
    expect(decideRelease({}, NOW)).toMatchObject({ ok: false, status: 422 })
  })

  /** The body is stored in `notes`, the framework column that already means it. */
  test('an empty body clears the notes rather than being ignored', () => {
    expect(decideRelease({ body: '' }, NOW)).toMatchObject({ changes: { notes: '' } })
    expect(decideRelease({ body: null }, NOW)).toMatchObject({ changes: { notes: null } })
  })
})
