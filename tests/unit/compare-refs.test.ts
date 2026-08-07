// Reading a compare URL. The split is unambiguous because git forbids `..`
// inside a refname - so either spelling is a separator, never a name - and
// the two spellings are different questions, not different punctuation.

import { describe, expect, test } from 'bun:test'
import { parseCompareRefs } from '../../app/Actions/Browse/compare'

describe('parseCompareRefs', () => {
  test('three dots is the merge-base compare', () => {
    expect(parseCompareRefs('main...feature', 'main'))
      .toEqual({ base: 'main', head: 'feature', mode: 'merge-base' })
  })

  test('two dots is tip to tip, kept apart on purpose', () => {
    expect(parseCompareRefs('main..feature', 'main'))
      .toEqual({ base: 'main', head: 'feature', mode: 'direct' })
  })

  test('one name compares against the default branch', () => {
    expect(parseCompareRefs('feature', 'trunk'))
      .toEqual({ base: 'trunk', head: 'feature', mode: 'merge-base' })
  })

  test('three dots wins when both could match', () => {
    // 'a...b' contains 'a..' too; splitting on '..' first would read the
    // head as '.b'.
    expect(parseCompareRefs('a...b', 'main'))
      .toEqual({ base: 'a', head: 'b', mode: 'merge-base' })
  })

  test('slashes in branch names survive', () => {
    expect(parseCompareRefs('release/1.0...feature/login', 'main'))
      .toEqual({ base: 'release/1.0', head: 'feature/login', mode: 'merge-base' })
  })

  test('an empty side is nothing to compare', () => {
    expect(parseCompareRefs('...feature', 'main')).toBeNull()
    expect(parseCompareRefs('main...', 'main')).toBeNull()
    expect(parseCompareRefs('', 'main')).toBeNull()
  })
})
