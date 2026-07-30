// Suggested changes.
//
// A suggestion block turns into a commit on somebody's branch with one click,
// so a loose parser writes the wrong thing into their code. These lean on the
// half-written and the nearly-right: an unterminated fence, a fence with a
// language tag, and a suggestion mentioned inside prose.

import { describe, expect, test } from 'bun:test'
import { applySuggestion, suggestionIn } from '../../app/Actions/Pull/suggestions'

describe('suggestionIn', () => {
  test('reads the replacement text', () => {
    expect(suggestionIn('```suggestion\nconst a = 2\n```')).toBe('const a = 2')
  })

  test('keeps several lines', () => {
    expect(suggestionIn('```suggestion\none\ntwo\n```')).toBe('one\ntwo')
  })

  test('reads a suggestion below prose', () => {
    const body = 'How about:\n\n```suggestion\nfixed()\n```'

    expect(suggestionIn(body)).toBe('fixed()')
  })

  test('an empty suggestion means delete these lines', () => {
    expect(suggestionIn('```suggestion\n\n```')).toBe('')
  })

  test('finds nothing in a plain comment', () => {
    expect(suggestionIn('this looks wrong to me')).toBeNull()
  })

  test('ignores an ordinary code block', () => {
    expect(suggestionIn('```ts\nconst a = 2\n```')).toBeNull()
  })

  test('ignores an unterminated block, which is someone still typing', () => {
    expect(suggestionIn('```suggestion\nconst a = 2')).toBeNull()
  })

  test('ignores the word suggestion in prose', () => {
    expect(suggestionIn('I have a suggestion about this')).toBeNull()
  })

  test('tolerates indentation, which a nested list produces', () => {
    expect(suggestionIn('  ```suggestion\n  const a = 2\n  ```')).toBe('  const a = 2')
  })

  test('takes the first block when there are two', () => {
    expect(suggestionIn('```suggestion\nfirst\n```\n\n```suggestion\nsecond\n```')).toBe('first')
  })
})

describe('applySuggestion', () => {
  const file = ['one', 'two', 'three', 'four']

  test('replaces a single line', () => {
    expect(applySuggestion(file, 2, 2, 'TWO')).toEqual(['one', 'TWO', 'three', 'four'])
  })

  test('replaces a range', () => {
    expect(applySuggestion(file, 2, 3, 'merged')).toEqual(['one', 'merged', 'four'])
  })

  test('expands one line into several', () => {
    expect(applySuggestion(file, 2, 2, 'a\nb')).toEqual(['one', 'a', 'b', 'three', 'four'])
  })

  test('an empty replacement deletes the lines', () => {
    expect(applySuggestion(file, 2, 3, '')).toEqual(['one', 'four'])
  })

  test('replaces the first line', () => {
    expect(applySuggestion(file, 1, 1, 'ONE')![0]).toBe('ONE')
  })

  test('replaces the last line', () => {
    expect(applySuggestion(file, 4, 4, 'FOUR')![3]).toBe('FOUR')
  })

  test('refuses a range past the end of the file', () => {
    // This is what an outdated thread looks like: the file has since shrunk.
    expect(applySuggestion(file, 3, 9, 'x')).toBeNull()
  })

  test('refuses a backwards range', () => {
    expect(applySuggestion(file, 3, 2, 'x')).toBeNull()
  })

  test('refuses a line number below one', () => {
    expect(applySuggestion(file, 0, 1, 'x')).toBeNull()
  })

  test('leaves the original array alone', () => {
    applySuggestion(file, 2, 2, 'TWO')

    expect(file).toEqual(['one', 'two', 'three', 'four'])
  })
})
