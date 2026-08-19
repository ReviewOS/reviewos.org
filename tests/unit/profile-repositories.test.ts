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
import { clampPage, pageCount, PROFILE_README_PATHS, profileRepositoriesFor, readmePathsFor, REPOSITORIES_PER_PAGE, searchPattern } from '../../app/Actions/Profile/read'
import { localNameFor } from '../../app/Commands/MirrorAdd'

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

describe('where a profile page is written', () => {
  test('an organization writes one file and only that file', () => {
    // `stacks/stacks` is the framework, and its README is the framework's. On
    // the organization page it would be a project's install instructions under
    // a heading that says who these people are.
    expect(readmePathsFor(true)).toEqual(['profile/README.md'])
  })

  test('a person may use either, and the profile one wins', () => {
    expect(readmePathsFor(false)).toEqual([...PROFILE_README_PATHS])
    expect(readmePathsFor(false)[0]).toBe('profile/README.md')
  })
})

describe('which repository a profile page is read from', () => {
  test('an organization publishes it where GitHub does, mirrored', () => {
    // `.github` cannot be a repository name here - a leading dot is rejected so
    // a name cannot hide a directory or climb out of the repository root - so a
    // mirror of it lands as `github`, and that is read first. An instance
    // mirroring an organization then shows the same page the organization
    // publishes upstream, kept current by the mirror rather than by copying.
    expect(profileRepositoriesFor('stacks', true)).toEqual(['github', 'stacks'])
  })

  test('a person publishes it in the repository named after them', () => {
    expect(profileRepositoriesFor('chrisbbreuer', false)).toEqual(['chrisbbreuer'])
  })

  test('the handle is read the way a URL spells it', () => {
    expect(profileRepositoriesFor('Stacks', true)).toEqual(['github', 'stacks'])
  })
})

describe('mirroring a repository whose name cannot be one here', () => {
  test('drops the leading dot, so `.github` can be mirrored at all', () => {
    // Without this, the one repository an organization keeps its profile page
    // in is the one repository this forge could not mirror.
    expect(localNameFor('.github')).toBe('github')
  })

  test('leaves an ordinary name alone', () => {
    expect(localNameFor('stacks')).toBe('stacks')
    expect(localNameFor('bun-router')).toBe('bun-router')
  })

  test('a dot inside the name is part of the name', () => {
    expect(localNameFor('reviewos.org')).toBe('reviewos.org')
  })
})
