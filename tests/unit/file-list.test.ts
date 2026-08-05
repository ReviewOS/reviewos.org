/**
 * Filtering the file list, and remembering what has been read.
 *
 * Both are the kind of thing that looks like it works: a filter that quietly
 * drops a file still shows a list, and a viewed set keyed too loosely still
 * ticks boxes - just the wrong ones, on somebody else's pull request.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { filterFiles, matchesQuery, readViewed, viewedKey, writeViewed } from '../../resources/functions/filelist'

const paths = [
  'app/Actions/Pull/rows.ts',
  'app/Actions/Pull/diff.ts',
  'resources/functions/diffviewer.ts',
  'tests/unit/rows.test.ts',
  'README.md',
].map(path => ({ path }))

describe('matchesQuery', () => {
  test('an empty search matches everything', () => {
    expect(matchesQuery('a/b.ts', '')).toBe(true)
    expect(matchesQuery('a/b.ts', '   ')).toBe(true)
  })

  test('matches anywhere in the path, not just the filename', () => {
    expect(matchesQuery('app/Actions/Pull/rows.ts', 'actions')).toBe(true)
  })

  test('is case insensitive, because nobody types a path the way it is spelled', () => {
    expect(matchesQuery('app/Actions/Pull/rows.ts', 'ACTIONS')).toBe(true)
  })

  /**
   * The reason for several terms rather than one string. Nobody remembers
   * which directory comes first, which is exactly why they are searching
   * instead of scrolling.
   */
  test('every term has to appear, in any order', () => {
    expect(matchesQuery('tests/unit/rows.test.ts', 'rows test')).toBe(true)
    expect(matchesQuery('tests/unit/rows.test.ts', 'test rows')).toBe(true)
    expect(matchesQuery('tests/unit/rows.test.ts', 'rows missing')).toBe(false)
  })

  /**
   * Substring, not fuzzy subsequence. Subsequence matching makes `art` match
   * `app/routes/tree.ts` through three unrelated letters, and a filter that
   * returns files the reader cannot see the reason for is worse than one that
   * returns none.
   */
  test('does not match letters scattered through the path', () => {
    expect(matchesQuery('app/routes/tree.ts', 'art')).toBe(false)
  })
})

describe('filterFiles', () => {
  test('gives back positions in the diff, not a renumbered list', () => {
    expect(filterFiles(paths, 'rows')).toEqual([0, 3])
  })

  test('an empty search is every position, in order', () => {
    expect(filterFiles(paths, '')).toEqual([0, 1, 2, 3, 4])
  })

  test('a search that matches nothing is empty rather than everything', () => {
    expect(filterFiles(paths, 'nothing here')).toEqual([])
  })
})

describe('the viewed set', () => {
  const store = new Map<string, string>()

  function withStorage(): void {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value) },
        removeItem: (key: string) => { store.delete(key) },
        clear: () => store.clear(),
        key: () => null,
        length: 0,
      },
    }
  }

  afterEach(() => {
    store.clear()
    delete (globalThis as { window?: unknown }).window
  })

  test('reads back what was written', () => {
    withStorage()
    writeViewed('pull/1', new Set(['a.ts', 'b.ts']))

    expect([...readViewed('pull/1')].sort()).toEqual(['a.ts', 'b.ts'])
  })

  /**
   * The bug a key of just the path would have. Two pull requests touching the
   * same file would share ticks, and a file the reader had never opened would
   * already be marked read - which looks like the feature working.
   */
  test('is scoped, so one pull request cannot tick another one\'s files', () => {
    withStorage()
    writeViewed('pull/1', new Set(['a.ts']))

    expect(readViewed('pull/2').size).toBe(0)
    expect(viewedKey('pull/1')).not.toBe(viewedKey('pull/2'))
  })

  test('a browser with no storage reads as nothing viewed rather than throwing', () => {
    expect(readViewed('pull/1').size).toBe(0)
    expect(() => writeViewed('pull/1', new Set(['a.ts']))).not.toThrow()
  })

  test('unreadable storage is not an error, it is an empty set', () => {
    withStorage()
    store.set(viewedKey('pull/1'), '{not json')

    expect(readViewed('pull/1').size).toBe(0)
  })

  test('a stored value of the wrong shape is ignored rather than trusted', () => {
    withStorage()
    store.set(viewedKey('pull/1'), '{"a":1}')

    expect(readViewed('pull/1').size).toBe(0)
  })

  test('and anything in the list that is not a path is dropped', () => {
    withStorage()
    store.set(viewedKey('pull/1'), '["a.ts", 42, null]')

    expect([...readViewed('pull/1')]).toEqual(['a.ts'])
  })
})
