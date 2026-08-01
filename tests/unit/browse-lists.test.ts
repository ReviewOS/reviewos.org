import { describe, expect, it } from 'bun:test'
import {
  authorIsLocal,
  authorLabel,
  countLabel,
  filterHref,
  lastPage,
  listFilter,
  pageHref,
  pageNumber,
  pageOffset,
  stateLabel,
  statePill,
  statesFor,
} from '../../app/Actions/Browse/lists'

describe('listFilter', () => {
  /**
   * Open is the default because it answers the question people arrive with. A
   * repository with two thousand merged pull requests opening on all of them
   * buries the twelve that are live.
   */
  it('defaults to open', () => {
    expect(listFilter(null)).toBe('open')
    expect(listFilter('')).toBe('open')
    expect(listFilter('nonsense')).toBe('open')
  })

  it('reads closed and all', () => {
    expect(listFilter('closed')).toBe('closed')
    expect(listFilter('ALL')).toBe('all')
  })
})

describe('statesFor', () => {
  /**
   * A merged pull request is closed, and a reader looking through what is
   * finished expects to find it. Merged is not a tab; it is how it closed.
   */
  it('counts merged as closed for pull requests', () => {
    expect(statesFor('closed', 'pulls')).toEqual(['closed', 'merged'])
  })

  /**
   * An issue has no merged state, and both columns are native Postgres enums.
   * Asking for a value the enum does not define is not an empty result, it is
   * an error: the query fails and the page renders an empty list that reads as
   * a repository with nothing closed in it.
   */
  it('never asks an issue for a state its enum does not have', () => {
    expect(statesFor('closed', 'issues')).toEqual(['closed'])
  })

  it('is open only for open, either way', () => {
    expect(statesFor('open', 'pulls')).toEqual(['open'])
    expect(statesFor('open', 'issues')).toEqual(['open'])
  })

  it('is unfiltered for all', () => {
    expect(statesFor('all', 'pulls')).toBeNull()
    expect(statesFor('all', 'issues')).toBeNull()
  })
})

describe('paging', () => {
  it('cannot be talked out of a positive integer', () => {
    expect(pageNumber('0')).toBe(1)
    expect(pageNumber('-4')).toBe(1)
    expect(pageNumber('abc')).toBe(1)
    expect(pageNumber('2.9')).toBe(2)
  })

  it('offsets from the page', () => {
    expect(pageOffset(1, 30)).toBe(0)
    expect(pageOffset(3, 30)).toBe(60)
  })

  /**
   * An empty list still has a page to be on. "Page 1 of 0" reads as a broken
   * page rather than an empty one.
   */
  it('has at least one page even when empty', () => {
    expect(lastPage(0, 30)).toBe(1)
  })

  it('rounds a partial page up', () => {
    expect(lastPage(31, 30)).toBe(2)
    expect(lastPage(60, 30)).toBe(2)
  })
})

describe('stateLabel', () => {
  it('separates merged from closed', () => {
    expect(stateLabel('merged')).toBe('Merged')
    expect(stateLabel('closed')).toBe('Closed')
  })

  it('calls an open draft a draft', () => {
    expect(stateLabel('open', true)).toBe('Draft')
  })

  /**
   * A merged pull request that was once a draft is merged. Saying "Draft"
   * about something that landed is worse than saying nothing.
   */
  it('does not call a merged pull request a draft', () => {
    expect(stateLabel('merged', true)).toBe('Merged')
  })
})

describe('authorLabel', () => {
  it('prefers the local account', () => {
    expect(authorLabel('chris', 'chrisbbreuer')).toBe('chris')
  })

  it('falls back to the upstream login for a mirrored row', () => {
    expect(authorLabel(null, 'chrisbbreuer')).toBe('chrisbbreuer')
  })

  /**
   * Never blank. A row with no author at all reads as a bug in the page rather
   * than a fact about the row.
   */
  it('says something when there is neither', () => {
    expect(authorLabel(null, null)).toBe('someone')
    expect(authorLabel('  ', '  ')).toBe('someone')
  })

  it('knows when the author has no local account to link to', () => {
    expect(authorIsLocal('chris')).toBe(true)
    expect(authorIsLocal(null)).toBe(false)
  })
})

describe('countLabel', () => {
  it('pluralises', () => {
    expect(countLabel(1, 'pull request', 'pull requests')).toBe('1 pull request')
    expect(countLabel(2, 'pull request', 'pull requests')).toBe('2 pull requests')
    expect(countLabel(0, 'issue', 'issues')).toBe('0 issues')
  })

  it('groups thousands, since a forge reaches them', () => {
    expect(countLabel(1745, 'pull request', 'pull requests')).toBe('1,745 pull requests')
  })
})

describe('links', () => {
  it('leaves the default filter out of the url', () => {
    expect(filterHref('/a/b/pulls', 'open')).toBe('/a/b/pulls')
    expect(filterHref('/a/b/pulls', 'closed')).toBe('/a/b/pulls?state=closed')
  })

  it('combines filter and page', () => {
    expect(pageHref('/a/b/pulls', 'closed', 3)).toBe('/a/b/pulls?state=closed&page=3')
    expect(pageHref('/a/b/pulls', 'open', 2)).toBe('/a/b/pulls?page=2')
    expect(pageHref('/a/b/pulls', 'open', 1)).toBe('/a/b/pulls')
  })
})

describe('statePill', () => {
  it('names the class the layout already defines, so a state looks the same everywhere', () => {
    expect(statePill('merged')).toBe('merged')
    expect(statePill('closed')).toBe('closed')
    expect(statePill('open')).toBe('open')
    expect(statePill('open', true)).toBe('draft')
  })
})
