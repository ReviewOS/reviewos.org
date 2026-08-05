// Turning reaction rows into the row of buttons a page draws.
//
// The database half is not here: what is worth testing is the shape the reader
// gets, because that is where the two ways of showing reactions have to agree.
// The picker under a comment and the summary above it are the same eight in the
// same order, and a function that decided which to show would make them two
// different things that drift.

import { describe, expect, test } from 'bun:test'
import { REACTIONS } from '../../app/Actions/Markdown/emoji'
import { pressed, subjectKey, summarize, summarizeAll } from '../../app/Actions/Issue/reactions'

const rows = [
  { subject_type: 'issue', subject_id: 1, content: 'rocket', user_id: 7 },
  { subject_type: 'issue', subject_id: 1, content: 'rocket', user_id: 8 },
  { subject_type: 'issue', subject_id: 1, content: '+1', user_id: 8 },
  { subject_type: 'issue_comment', subject_id: 4, content: 'eyes', user_id: 7 },
]

describe('summarize', () => {
  test('answers all eight, in the fixed order, whatever was pressed', () => {
    expect(summarize([], null).map(one => one.content)).toEqual([...REACTIONS])
  })

  test('counts each reaction', () => {
    const summary = summarize(rows.filter(row => row.subject_id === 1), null)

    expect(summary.find(one => one.content === 'rocket')?.count).toBe(2)
    expect(summary.find(one => one.content === '+1')?.count).toBe(1)
    expect(summary.find(one => one.content === 'heart')?.count).toBe(0)
  })

  test('carries the character, so a template never looks one up', () => {
    expect(summarize([], null).find(one => one.content === 'rocket')?.emoji).toBe('🚀')
  })

  test('marks the ones the reader has already pressed', () => {
    const summary = summarize(rows, 8)

    expect(summary.find(one => one.content === 'rocket')?.mine).toBe(true)
    expect(summary.find(one => one.content === '+1')?.mine).toBe(true)
    expect(summary.find(one => one.content === 'eyes')?.mine).toBe(false)
  })

  test('marks nothing for somebody who is not signed in', () => {
    expect(summarize(rows, null).every(one => !one.mine)).toBe(true)
  })
})

describe('summarizeAll', () => {
  /**
   * One read for the whole page. An issue with three hundred comments would
   * otherwise be three hundred queries, which is slow in exactly the
   * repositories where it matters.
   */
  test('groups by subject', () => {
    const grouped = summarizeAll(rows, 7)

    expect(grouped.get(subjectKey('issue', 1))?.find(one => one.content === 'rocket')?.count).toBe(2)
    expect(grouped.get(subjectKey('issue_comment', 4))?.find(one => one.content === 'eyes')?.count).toBe(1)
  })

  test('has no entry for a subject nobody reacted to', () => {
    expect(summarizeAll(rows, null).get(subjectKey('issue', 99))).toBeUndefined()
  })

  /** An id can repeat across subject types, and must not merge. */
  test('keeps an issue and a comment with the same id apart', () => {
    const grouped = summarizeAll([
      { subject_type: 'issue', subject_id: 3, content: 'heart', user_id: 1 },
      { subject_type: 'issue_comment', subject_id: 3, content: 'rocket', user_id: 1 },
    ], null)

    expect(pressed(grouped.get(subjectKey('issue', 3))!).map(one => one.content)).toEqual(['heart'])
    expect(pressed(grouped.get(subjectKey('issue_comment', 3))!).map(one => one.content)).toEqual(['rocket'])
  })
})

describe('pressed', () => {
  test('keeps only what somebody actually pressed, in order', () => {
    expect(pressed(summarize(rows.filter(row => row.subject_id === 1), null)).map(one => one.content))
      .toEqual(['+1', 'rocket'])
  })

  test('is empty when nobody has reacted', () => {
    expect(pressed(summarize([], null))).toEqual([])
  })
})
