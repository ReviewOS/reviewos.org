// What the event touched, stored on the run so a step's condition can ask.
//
// The interesting part is not the storage, it is the truncation. A merge of a
// long-lived branch changes thousands of files; a run row that grew with it
// would be one nobody can load. So the list is cut - and a condition that
// quietly answers "no, that path did not change" out of a cut list is the one
// failure worth designing against, which is why the flag travels with the data.

import { describe, expect, test } from 'bun:test'
import { changedPathsColumn, changedPathsFromColumn, MAX_CHANGED_PATHS } from '../../app/Actions/Workflow/dispatch'

describe('storing what changed', () => {
  test('an ordinary push round-trips whole', () => {
    const stored = changedPathsColumn(['src/app.ts', 'README.md'])

    expect(changedPathsFromColumn(stored)).toEqual({ paths: ['src/app.ts', 'README.md'], truncated: false })
  })

  test('a push that changed nothing stores nothing', () => {
    // Null rather than an empty array: a column holding `{"paths":[]}` on every
    // scheduled run is bytes spent to say what its absence already says.
    expect(changedPathsColumn([])).toBeNull()
    expect(changedPathsColumn(null)).toBeNull()
  })

  test('a very large push is cut, and says so', () => {
    const many = Array.from({ length: MAX_CHANGED_PATHS + 50 }, (one, index) => `file-${index}.ts`)
    const read = changedPathsFromColumn(changedPathsColumn(many))

    expect(read.paths).toHaveLength(MAX_CHANGED_PATHS)
    expect(read.truncated).toBe(true)
  })

  test('and one exactly at the limit is not', () => {
    const exact = Array.from({ length: MAX_CHANGED_PATHS }, (one, index) => `file-${index}.ts`)

    expect(changedPathsFromColumn(changedPathsColumn(exact)).truncated).toBe(false)
  })
})

describe('reading it back', () => {
  test('nothing stored is no answer rather than an error', () => {
    expect(changedPathsFromColumn(null)).toEqual({ paths: [], truncated: false })
    expect(changedPathsFromColumn('')).toEqual({ paths: [], truncated: false })
  })

  /**
   * A row written by a version that is gone, or one somebody edited by hand.
   * Reported as truncated rather than as "nothing changed", because those two
   * answers send a conditional in opposite directions and only one of them is
   * safe to be wrong about: a step that runs when it need not have costs a
   * minute, and one that is skipped when it was needed ships the bug.
   */
  test('a value that will not parse says "I cannot tell", not "nothing"', () => {
    const unreadable = changedPathsFromColumn('{not json')

    expect(unreadable.paths).toEqual([])
    expect(unreadable.truncated).toBe(true)
  })

  test('and a shape that is not the one written is treated the same way', () => {
    expect(changedPathsFromColumn('{"paths":"src/app.ts"}')).toEqual({ paths: [], truncated: false })
  })
})
