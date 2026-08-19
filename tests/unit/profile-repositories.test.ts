// The rules behind a profile's repository list, without a database.
//
// The list is the whole page for an organization, and it had three bugs that a
// screenshot does not show: it was ordered by a column that is null on every
// repository nobody has edited through the product, it stopped at thirty with
// nothing saying so, and there was no way to look for one by name.
//
// What is worth pinning here is the arithmetic around those - a page number out
// of range, a search string carrying a wildcard - because each of them has a
// wrong answer that looks like a working page: page 9 of 5 renders an empty
// list, and `bun_queue` matching `bun-queue` renders a result that was not
// asked for.

import { describe, expect, test } from 'bun:test'
import { clampPage, pageCount, PROFILE_README_PATHS, profileRepositoriesFor, readmePathsIn, REPOSITORIES_PER_PAGE, searchPattern } from '../../app/Actions/Profile/read'
import { isSafeSegment } from '../../app/Actions/Git/storage'

describe('how many pages there are', () => {
  test('an exact multiple does not gain an empty last page', () => {
    expect(pageCount(48, 24)).toBe(2)
  })

  test('a remainder gets a page of its own', () => {
    expect(pageCount(49, 24)).toBe(3)
  })

  test('an owner with nothing still has a page one', () => {
    // Zero pages would make every page number out of range, and the pager would
    // then be asked to render "page 1 of 0".
    expect(pageCount(0, 24)).toBe(1)
  })

  test('the default is the one the grid is built for', () => {
    expect(pageCount(REPOSITORIES_PER_PAGE)).toBe(1)
    expect(pageCount(REPOSITORIES_PER_PAGE + 1)).toBe(2)
  })
})

describe('which page is actually shown', () => {
  test('what was asked for, when it exists', () => {
    expect(clampPage('3', 5)).toBe(3)
  })

  test('past the end lands on the last page rather than on nothing', () => {
    // `?page=900` is a link somebody kept after the list got shorter. An empty
    // list under a heading that says there are a hundred repositories reads as
    // the page having broken.
    expect(clampPage(900, 5)).toBe(5)
  })

  test('nonsense, negatives and nothing all mean the first page', () => {
    expect(clampPage('banana', 5)).toBe(1)
    expect(clampPage(-4, 5)).toBe(1)
    expect(clampPage(undefined, 5)).toBe(1)
    expect(clampPage('2.7', 5)).toBe(2)
  })
})

describe('the search pattern', () => {
  test('matches anywhere in the name, lowercased', () => {
    // The comparison is against `LOWER(name)`, because repository names carry
    // capitals - `GitHarbor` - and nobody types them.
    expect(searchPattern('GitHarbor')).toBe('%githarbor%')
  })

  test('a wildcard somebody typed is a literal, not a wildcard', () => {
    // Otherwise `bun_queue` quietly also matches `bun-queue`, and a search that
    // means something other than what was typed is worse than one that finds
    // nothing.
    expect(searchPattern('bun_queue')).toBe('%bun\\_queue%')
    expect(searchPattern('100%')).toBe('%100\\%%')
  })

  test('surrounding space is not part of what was asked for', () => {
    expect(searchPattern('  stx  ')).toBe('%stx%')
  })
})

describe('which file is read, in the repository being read', () => {
  test('a `.profile` repository holds the page at its root', () => {
    // `.profile/profile/README.md` would be saying it twice. The nested path is
    // still read, because it is what somebody copying a profile across has.
    expect(readmePathsIn('.profile', true)).toEqual(['README.md', 'profile/README.md'])
  })

  test('a mirrored `.github` is read where GitHub puts it', () => {
    expect(readmePathsIn('.github', true)).toEqual(['profile/README.md'])
  })

  test('an organization\'s namesake repository gives up only its profile file', () => {
    // `stacks/stacks` is the framework, and its README is the framework's. On
    // the organization page it would be a project's install instructions under
    // a heading that says who these people are.
    expect(readmePathsIn('stacks', true)).toEqual(['profile/README.md'])
  })

  test('a person\'s namesake repository is their profile, README and all', () => {
    expect(readmePathsIn('chrisbbreuer', false)).toEqual([...PROFILE_README_PATHS])
  })
})

describe('which repository a profile page is read from', () => {
  test('the forge asks for `.profile`, which carries nobody else\'s brand', () => {
    expect(profileRepositoriesFor('stacks', true)[0]).toBe('.profile')
    expect(profileRepositoriesFor('chrisbbreuer', false)[0]).toBe('.profile')
  })

  test('an organization arriving from elsewhere is read where it already writes one', () => {
    // A mirrored `.github` is GitHub's place for an organization page and the
    // repository named after the handle is its place for a person's. Read as
    // compatibility, after the name this forge asks for.
    expect(profileRepositoriesFor('stacks', true)).toEqual(['.profile', '.github', 'stacks'])
    expect(profileRepositoriesFor('chrisbbreuer', false)).toEqual(['.profile', 'chrisbbreuer'])
  })

  test('the handle is read the way a URL spells it', () => {
    expect(profileRepositoriesFor('Stacks', true)).toEqual(['.profile', '.github', 'stacks'])
  })

  test('every name it asks for is one this forge can actually host', () => {
    // The whole feature turned on this: `isSafeSegment` refused a leading dot,
    // so the repository the profile page reads from could not be created.
    for (const name of profileRepositoriesFor('stacks', true))
      expect(isSafeSegment(name)).toBe(true)
  })
})
