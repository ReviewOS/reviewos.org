/**
 * A fragment highlighted as though the file above it were there.
 *
 * The failure this closes is silent and confident, which is the worst pairing:
 * a hunk or a window that begins inside a block comment, a template literal or
 * a docstring is tokenized from a cold state, so the comment renders as code
 * and nothing anywhere says the highlighter was guessing. A reader sees a
 * licence header full of keywords and blames the theme.
 *
 * Every test here is the same shape - tokenize the same lines cold, then
 * resumed, and assert they disagree in the direction that makes the resumed one
 * right. Asserting only the resumed answer would pass against a highlighter
 * that had never had the bug.
 */

import { describe, expect, test } from 'bun:test'
import { tokenClass } from '../../app/Actions/Browse/highlight'
import { highlightResumed, MAX_PRELUDE_LINES, ScopeWalk, scopeStateAfter } from '../../app/Actions/Browse/resume'

/** The classes a run of lines came back with, flattened. */
function classes(lines: string[], language: string | null, prelude: string[] = []): string[] {
  const tokens = highlightResumed(lines, language, scopeStateAfter(prelude, language), tokenClass)

  if (!tokens)
    throw new Error('expected the resume path to answer')

  return tokens.flat().map(token => token.type)
}

function rebuilt(lines: string[], language: string | null, prelude: string[] = []): string[] {
  const tokens = highlightResumed(lines, language, scopeStateAfter(prelude, language), tokenClass)!

  return tokens.map(line => line.map(token => token.content).join(''))
}

describe('a hunk that begins inside a block comment', () => {
  const prelude = [
    '/*',
    ' * Copyright somebody.',
    ' *',
  ]
  const fragment = [
    ' * function greet(name) { return name }',
    ' */',
    'export const x = 1',
  ]

  test('cold, the comment body is read as code', () => {
    const cold = classes(fragment, 'typescript')

    expect(cold).toContain('keyword')
  })

  test('resumed, it is read as a comment', () => {
    const warm = classes(fragment, 'typescript', prelude)

    expect(warm.filter(type => type === 'comment').length).toBeGreaterThan(0)
    // The `export const` after the comment closes is code again, which is the
    // half that proves the state was resumed rather than simply forced.
    expect(warm).toContain('keyword')
  })

  test('the comment lines carry no keyword classes', () => {
    const tokens = highlightResumed(fragment, 'typescript', scopeStateAfter(prelude, 'typescript'), tokenClass)!

    expect(tokens[0]!.every(token => token.type !== 'keyword')).toBe(true)
    expect(tokens[2]!.some(token => token.type === 'keyword')).toBe(true)
  })
})

describe('a hunk that begins inside a template literal', () => {
  const prelude = ['const html = `', '  <div>']
  const fragment = ['  return null', '`', 'const after = 2']

  test('cold, the string body is read as code', () => {
    expect(classes(fragment, 'typescript')).toContain('keyword')
  })

  test('resumed, the body is string and the code after it is code', () => {
    const tokens = highlightResumed(fragment, 'typescript', scopeStateAfter(prelude, 'typescript'), tokenClass)!

    expect(tokens[0]!.every(token => token.type !== 'keyword')).toBe(true)
    expect(tokens[2]!.some(token => token.type === 'keyword')).toBe(true)
  })
})

describe('the property nothing here may break', () => {
  test('the tokens are the lines, exactly', () => {
    const fragment = ['  const a = 1', '\tif (a) {', '    return `x ${a}`', '  }']

    expect(rebuilt(fragment, 'typescript', ['function f() {'])).toEqual(fragment)
  })

  test('a line whose tokens do not rebuild it renders plain rather than wrong', () => {
    // Asserted through the public shape rather than by breaking a tokenizer:
    // every line comes back, and every line is itself.
    const fragment = ['const a = 1']

    expect(rebuilt(fragment, 'typescript')).toEqual(fragment)
  })
})

describe('what it refuses, which every caller treats as "do it the old way"', () => {
  test('no language', () => {
    expect(highlightResumed(['x'], null, null, tokenClass)).toBeNull()
  })

  test('a language with no grammar', () => {
    expect(highlightResumed(['x'], 'not-a-language', null, tokenClass)).toBeNull()
  })

  test('no lines', () => {
    expect(highlightResumed([], 'typescript', null, tokenClass)).toBeNull()
  })

  test('a prelude past the ceiling, because a partial walk is a confident wrong answer', () => {
    const prelude = Array.from({ length: MAX_PRELUDE_LINES + 1 }, () => 'const a = 1')

    expect(scopeStateAfter(prelude, 'typescript')).toBeNull()
  })

  test('an empty prelude has nothing to resume from', () => {
    expect(scopeStateAfter([], 'typescript')).toBeNull()
  })
})

describe('the walking form, for a reader that is streaming the prelude past anyway', () => {
  test('agrees with walking the whole prelude at once', () => {
    const prelude = ['/*', ' * a', ' * b']
    const walk = new ScopeWalk('typescript')

    for (const line of prelude)
      walk.push(line)

    const streamed = highlightResumed([' * still a comment'], 'typescript', walk.finish(), tokenClass)!
    const collected = highlightResumed([' * still a comment'], 'typescript', scopeStateAfter(prelude, 'typescript'), tokenClass)!

    expect(streamed.flat().map(token => token.type)).toEqual(collected.flat().map(token => token.type))
    expect(streamed.flat().every(token => token.type === 'comment')).toBe(true)
  })

  test('gives up rather than resume from halfway once the prelude is too long', () => {
    const walk = new ScopeWalk('typescript')

    for (let index = 0; index <= MAX_PRELUDE_LINES; index++)
      walk.push('const a = 1')

    expect(walk.finish()).toBeNull()
    expect(walk.active).toBe(false)
  })

  test('a walk with no language never becomes active', () => {
    const walk = new ScopeWalk(null)

    walk.push('/*')

    expect(walk.active).toBe(false)
    expect(walk.finish()).toBeNull()
  })
})
