// Which references in a piece of text become an entry on another issue.
//
// Recording is a write on somebody else's history, so the rules that decide
// what counts are the ones worth testing: a scanner that is eager here appends
// lines to issues nobody was writing about, and one that follows a reference
// into another repository lets anyone append a line to any issue anywhere.

import { describe, expect, test } from 'bun:test'
import { referencedNumbers } from '../../app/Actions/Issue/crossReferences'
import { entrySentence } from '../../app/Actions/Issue/timeline'

describe('referencedNumbers', () => {
  test('finds a reference', () => {
    expect(referencedNumbers('see #12 for context', 7)).toEqual([12])
  })

  test('finds several, deduplicated and ordered', () => {
    expect(referencedNumbers('#12 then #3 then #12 again', 7)).toEqual([3, 12])
  })

  /**
   * Whoever wrote this has permission here and nothing checked that they may
   * write on a timeline over there. The same rule the closing keywords follow,
   * for the same reason.
   */
  test('does not follow a reference into another repository', () => {
    expect(referencedNumbers('see other/repo#7', 1)).toEqual([])
  })

  test('ignores the number the text is written on', () => {
    expect(referencedNumbers('this is #7, not a duplicate of #7', 7)).toEqual([])
  })

  /** A reference inside code is an example, not a link. */
  test('ignores a reference inside code', () => {
    expect(referencedNumbers('run `git log #12`', 1)).toEqual([])
    expect(referencedNumbers('```\nsee #12\n```', 1)).toEqual([])
  })

  test('ignores an anchor in a URL', () => {
    expect(referencedNumbers('https://example.com/page#12', 1)).toEqual([])
  })

  test('finds nothing in text that has none', () => {
    expect(referencedNumbers('no references at all', 1)).toEqual([])
    expect(referencedNumbers('', 1)).toEqual([])
  })
})

/**
 * The two ends read differently on purpose. A reader on the issue that was
 * referred to wants to know that something else is about it; a reader on the
 * thing that did the referring already knows, and wants the link the other way.
 */
describe('how each end reads', () => {
  test('the incoming entry names where it came from', () => {
    expect(entrySentence('referenced', { reference: 7 })).toBe('referenced this in #7')
  })

  test('the outgoing entry names where it points', () => {
    expect(entrySentence('mentioned', { reference: 12 })).toBe('mentioned #12')
  })
})
