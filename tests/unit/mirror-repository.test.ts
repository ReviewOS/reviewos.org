/**
 * The repository's own metadata, and the labels and milestones under it.
 *
 * Pure mapping, like the rest of `github.ts`, so the rules are testable against
 * literals rather than against a token and somebody else's repository. What is
 * asserted here is mostly what is *left out* and what is *corrected*, because
 * those are the decisions - copying a field verbatim needs no test.
 */

import { describe, expect, it } from 'bun:test'
import { mapLabel, mapMilestone, mapRepository } from '../../app/Actions/Mirror/github'

describe('the repository itself', () => {
  it('takes the description, topics, default branch and archived flag', () => {
    const mapped = mapRepository({
      description: 'A forge',
      topics: ['Git', 'code-review'],
      default_branch: 'trunk',
      archived: true,
      private: false,
    })

    expect(mapped?.description).toBe('A forge')
    expect(mapped?.defaultBranch).toBe('trunk')
    expect(mapped?.archived).toBe(true)
  })

  it('lowercases and de-duplicates topics, because that is how they are stored here', () => {
    const mapped = mapRepository({ topics: ['Git', 'git', ' GIT ', 'rust'] })

    expect(mapped?.topics).toEqual(['git', 'rust'])
  })

  it('reads `private` rather than `visibility`', () => {
    /*
     * `visibility` is the newer field and reads `internal` on an Enterprise
     * instance - a value this product's enum does not have. Trusting it
     * verbatim would store something the column cannot hold, and a mirror of an
     * internal repository is private here whatever it is called there.
     */
    expect(mapRepository({ private: true, visibility: 'internal' })?.visibility).toBe('private')
    expect(mapRepository({ private: false, visibility: 'internal' })?.visibility).toBe('public')
  })

  it('carries nothing about their audience', () => {
    // Stars, watchers and forks are their numbers about their copy. Showing
    // them here would make this instance look like it has an audience it does
    // not have.
    const mapped: any = mapRepository({ stargazers_count: 40_000, watchers_count: 900, forks_count: 12 })

    expect(mapped.stars).toBeUndefined()
    expect(mapped.watchers).toBeUndefined()
    expect(mapped.forks).toBeUndefined()
  })

  it('is null for a body that is not a repository, rather than a row of empty strings', () => {
    expect(mapRepository(null)).toBeNull()
    expect(mapRepository('not found')).toBeNull()
  })

  it('has no topics rather than undefined when the field is absent', () => {
    // GitHub omits `topics` unless the preview header is sent, and a caller
    // spreading `undefined` into a write is how a column ends up holding the
    // string "undefined".
    expect(mapRepository({ description: 'x' })?.topics).toEqual([])
  })
})

describe('labels', () => {
  it('strips the leading hash from a colour, because that is not how it is stored', () => {
    expect(mapLabel({ name: 'bug', color: '#D73A4A' })?.color).toBe('d73a4a')
  })

  it('falls back for a colour that is not six hex digits', () => {
    /*
     * A three-character colour renders as no colour at all, which reads as a
     * bug in this product rather than as bad data upstream. Grey is visibly a
     * default; an empty string is visibly broken.
     */
    expect(mapLabel({ name: 'bug', color: 'f00' })?.color).toBe('888888')
    expect(mapLabel({ name: 'bug' })?.color).toBe('888888')
  })

  it('is null without a name, which is the only field a label cannot do without', () => {
    expect(mapLabel({ color: 'ff0000' })).toBeNull()
    expect(mapLabel({ name: '   ' })).toBeNull()
  })
})

describe('milestones', () => {
  it('keeps the number, so a mirrored milestone matches the one upstream', () => {
    const mapped = mapMilestone({ number: 7, title: 'v2', state: 'closed', due_on: '2026-01-01T00:00:00Z' })

    expect(mapped?.number).toBe(7)
    expect(mapped?.state).toBe('closed')
    expect(mapped?.dueOn).toBe('2026-01-01T00:00:00Z')
  })

  it('treats anything that is not closed as open', () => {
    // GitHub only sends open or closed, but a mirror should not invent a third
    // state from a field it did not expect.
    expect(mapMilestone({ number: 1, state: 'whatever' })?.state).toBe('open')
  })

  it('is null without a number, which is how it is matched to what is already here', () => {
    expect(mapMilestone({ title: 'v2' })).toBeNull()
  })
})
