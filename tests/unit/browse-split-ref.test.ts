import { describe, expect, it } from 'bun:test'
import { joinRefAndPath, splitRefAndPath } from '../../app/Actions/Browse/splitRef'

/**
 * `/tree/{ref}/{path}` cannot be split without knowing the repository's refs.
 *
 * Splitting on the first slash sent every branch with a slash in its name -
 * `fix/`, `feat/`, `release/`, which is what branch names normally look like -
 * to a ref that does not exist. Git resolved nothing, the page fell back to the
 * default branch, and the reader got other files under the name they clicked.
 */

const REFS = ['main', 'fix/rounding', 'feat/checkout/v2', 'v1.0.0']

describe('splitRefAndPath', () => {
  it('keeps a branch whose name contains a slash', () => {
    expect(splitRefAndPath('fix/rounding', REFS)).toEqual({ ref: 'fix/rounding', path: '' })
    expect(splitRefAndPath('fix/rounding/src/index.ts', REFS))
      .toEqual({ ref: 'fix/rounding', path: 'src/index.ts' })
  })

  it('handles a name with more than one slash in it', () => {
    expect(splitRefAndPath('feat/checkout/v2/src', REFS))
      .toEqual({ ref: 'feat/checkout/v2', path: 'src' })
  })

  it('is unremarkable for an ordinary branch', () => {
    expect(splitRefAndPath('main', REFS)).toEqual({ ref: 'main', path: '' })
    expect(splitRefAndPath('main/src/index.ts', REFS)).toEqual({ ref: 'main', path: 'src/index.ts' })
  })

  /**
   * Otherwise creating a branch called `fix` silently changes where every
   * existing `fix/rounding` link goes.
   */
  it('takes the longest ref when one is a prefix of another', () => {
    const refs = ['fix', 'fix/rounding']

    expect(splitRefAndPath('fix/rounding/src', refs)).toEqual({ ref: 'fix/rounding', path: 'src' })
    expect(splitRefAndPath('fix/src', refs)).toEqual({ ref: 'fix', path: 'src' })
  })

  /** Without a segment boundary, `fix` is a "prefix" of `fixtures/data.json`. */
  it('only matches on a segment boundary', () => {
    expect(splitRefAndPath('main/fixtures/data.json', ['main', 'fix']))
      .toEqual({ ref: 'main', path: 'fixtures/data.json' })
  })

  /**
   * A sha, a tag somebody has since deleted, and a typo all land here. Git
   * gives its own answer about each, which is better than this file guessing.
   */
  it('falls back to the first segment when nothing matches', () => {
    expect(splitRefAndPath('8603f96/src/index.ts', REFS))
      .toEqual({ ref: '8603f96', path: 'src/index.ts' })
    expect(splitRefAndPath('deleted-branch', REFS)).toEqual({ ref: 'deleted-branch', path: '' })
  })

  it('is not confused by slashes on either end', () => {
    expect(splitRefAndPath('/fix/rounding/src/', REFS))
      .toEqual({ ref: 'fix/rounding', path: 'src' })
  })

  it('has an answer for nothing at all', () => {
    expect(splitRefAndPath('', REFS)).toEqual({ ref: '', path: '' })
    expect(splitRefAndPath('/', REFS)).toEqual({ ref: '', path: '' })
    expect(splitRefAndPath('main', [])).toEqual({ ref: 'main', path: '' })
  })
})

describe('joinRefAndPath', () => {
  it('is the split run backwards, so a link and a read cannot disagree', () => {
    for (const url of ['fix/rounding/src/index.ts', 'main', 'feat/checkout/v2/src']) {
      const { ref, path } = splitRefAndPath(url, REFS)

      expect(joinRefAndPath(ref, path)).toBe(url)
    }
  })

  it('leaves a slashed ref alone rather than encoding it', () => {
    // `fix%2Frounding` is a ref no git command has heard of.
    expect(joinRefAndPath('fix/rounding', '')).toBe('fix/rounding')
  })

  it('does not leave a trailing slash on a directory-less link', () => {
    expect(joinRefAndPath('main', '')).toBe('main')
    expect(joinRefAndPath('main', '/')).toBe('main')
  })
})
