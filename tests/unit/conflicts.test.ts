/**
 * Conflict markers.
 *
 * The tests that matter here are the ones about *not* recognising a marker. A
 * parser that fires on `<<<<<<<` inside a string literal offers to resolve
 * something that is not a conflict, and accepting that offer deletes working
 * code. Recognition is deliberately exact and everything else is text.
 */

import { describe, expect, test } from 'bun:test'
import {
  countConflicts,
  hasConflicts,
  parseConflicts,
  resolveConflict,
  writeConflicts,
} from '../../app/Actions/Pull/conflicts'
import { renderConflictFile, renderConflictRows } from '../../app/Actions/Pull/conflictRows'

const SIMPLE = [
  'const a = 1',
  '<<<<<<< HEAD',
  'const b = 2',
  '=======',
  'const b = 3',
  '>>>>>>> feature',
  'const c = 4',
].join('\n')

const DIFF3 = [
  '<<<<<<< HEAD',
  'ours',
  '||||||| merged common ancestors',
  'base',
  '=======',
  'theirs',
  '>>>>>>> other',
].join('\n')

describe('parseConflicts', () => {
  test('splits a file into text and conflict regions', () => {
    const regions = parseConflicts(SIMPLE)

    expect(regions.map(region => region.type)).toEqual(['text', 'conflict', 'text'])
    expect(countConflicts(regions)).toBe(1)
    expect(hasConflicts(regions)).toBe(true)
  })

  test('keeps both sides and the labels git wrote', () => {
    const [, conflict] = parseConflicts(SIMPLE)

    expect(conflict).toMatchObject({
      type: 'conflict',
      ours: { label: 'HEAD', lines: ['const b = 2'] },
      theirs: { label: 'feature', lines: ['const b = 3'] },
      base: null,
    })
  })

  test('a file with no markers is one text region rather than a special case', () => {
    const regions = parseConflicts('one\ntwo\n')

    expect(regions).toHaveLength(1)
    expect(hasConflicts(regions)).toBe(false)
  })

  test('reads the common ancestor when git wrote one', () => {
    const [conflict] = parseConflicts(DIFF3)

    expect(conflict).toMatchObject({
      ours: { lines: ['ours'] },
      base: { label: 'merged common ancestors', lines: ['base'] },
      theirs: { lines: ['theirs'] },
    })
  })

  test('numbers regions from where they start in the file', () => {
    const [text, conflict, tail] = parseConflicts(SIMPLE)

    expect(text).toMatchObject({ startLine: 1 })
    expect(conflict).toMatchObject({ startLine: 2 })
    expect(tail).toMatchObject({ startLine: 7 })
  })

  test('several conflicts in one file are separate regions', () => {
    const doubled = `${SIMPLE}\n${SIMPLE}`

    expect(countConflicts(parseConflicts(doubled))).toBe(2)
  })
})

describe('what is not a conflict', () => {
  /**
   * The one that would do damage. A line of code that happens to start with
   * seven of the character is not a marker unless it is exactly a marker, and
   * treating it as one would let somebody "resolve" a file by deleting half of
   * a string literal.
   */
  test('a marker-like line inside a string literal is text', () => {
    const source = [
      'const banner = `',
      '<<<<<<< not a conflict',
      '`',
    ].join('\n')

    expect(hasConflicts(parseConflicts(source))).toBe(false)
  })

  test('six characters is not a marker, and eight is not either', () => {
    for (const marker of ['<<<<<< HEAD', '<<<<<<<< HEAD'])
      expect(hasConflicts(parseConflicts(`${marker}\na\n=======\nb\n>>>>>>> x`))).toBe(false)
  })

  test('an opening marker with nothing closing it is text', () => {
    expect(hasConflicts(parseConflicts('<<<<<<< HEAD\nours\nand nothing else'))).toBe(false)
  })

  test('a closing marker before the split is not a close', () => {
    expect(hasConflicts(parseConflicts('<<<<<<< HEAD\nours\n>>>>>>> theirs'))).toBe(false)
  })

  test('a marker that is not at the start of the line is text', () => {
    expect(hasConflicts(parseConflicts('  <<<<<<< HEAD\na\n=======\nb\n>>>>>>> x'))).toBe(false)
  })

  /**
   * git does not nest conflicts. A second opening marker inside one is content,
   * and reading it as a nested region would leave the outer conflict unclosed -
   * which would swallow the rest of the file into something nobody can resolve.
   */
  test('a second opening marker inside a conflict is content, not a nested conflict', () => {
    const source = [
      '<<<<<<< HEAD',
      '<<<<<<< inner',
      '=======',
      'theirs',
      '>>>>>>> other',
    ].join('\n')

    const regions = parseConflicts(source)

    expect(countConflicts(regions)).toBe(1)
    expect(regions[0]).toMatchObject({ ours: { lines: ['<<<<<<< inner'] } })
  })
})

describe('resolveConflict', () => {
  const regions = parseConflicts(SIMPLE)

  test('keeping ours drops the other side and the markers', () => {
    expect(resolveConflict(regions, 0, 'ours')).toBe('const a = 1\nconst b = 2\nconst c = 4')
  })

  test('keeping theirs does the same the other way', () => {
    expect(resolveConflict(regions, 0, 'theirs')).toBe('const a = 1\nconst b = 3\nconst c = 4')
  })

  test('keeping both keeps ours first, which is the order they were written in', () => {
    expect(resolveConflict(regions, 0, 'both'))
      .toBe('const a = 1\nconst b = 2\nconst b = 3\nconst c = 4')
  })

  /**
   * The base is what the line looked like before either side touched it. It is
   * context, and a resolution containing it would be a third version nobody
   * wrote.
   */
  test('the common ancestor is never part of an answer', () => {
    const diff3 = parseConflicts(DIFF3)

    expect(resolveConflict(diff3, 0, 'ours')).toBe('ours')
    expect(resolveConflict(diff3, 0, 'both')).toBe('ours\ntheirs')
  })

  test('resolving one conflict leaves the others exactly as they were', () => {
    const doubled = parseConflicts(`${SIMPLE}\n${SIMPLE}`)
    const resolved = resolveConflict(doubled, 0, 'ours')

    expect(countConflicts(parseConflicts(resolved))).toBe(1)
    expect(resolved).toContain('<<<<<<< HEAD')
  })

  test('an index that names no conflict changes nothing', () => {
    expect(resolveConflict(regions, 9, 'ours')).toBe(writeConflicts(regions))
  })
})

describe('writeConflicts', () => {
  test('gives back exactly what was parsed', () => {
    for (const source of [SIMPLE, DIFF3, 'plain\ntext'])
      expect(writeConflicts(parseConflicts(source))).toBe(source)
  })

  test('a marker with no label round trips without gaining a space', () => {
    const source = '<<<<<<<\nours\n=======\ntheirs\n>>>>>>>'

    expect(writeConflicts(parseConflicts(source))).toBe(source)
  })
})

describe('rendering', () => {
  test('marks each side so they can be told apart', () => {
    const html = renderConflictRows(parseConflicts(SIMPLE))

    expect(html).toContain('conflict-ours')
    expect(html).toContain('conflict-theirs')
    expect(html).toContain('HEAD')
    expect(html).toContain('feature')
  })

  test('offers the three answers only when something can act on them', () => {
    const regions = parseConflicts(SIMPLE)

    expect(renderConflictRows(regions)).not.toContain('conflict-accept')
    expect(renderConflictRows(regions, { resolvable: true })).toContain('conflict-accept')
  })

  test('the buttons say which conflict and which answer', () => {
    const html = renderConflictRows(parseConflicts(`${SIMPLE}\n${SIMPLE}`), { resolvable: true })

    expect(html).toContain('data-conflict="0"')
    expect(html).toContain('data-conflict="1"')
    expect(html).toContain('data-choice="both"')
  })

  test('the header counts what is left to resolve', () => {
    expect(renderConflictFile('src/a.ts', parseConflicts(SIMPLE))).toContain('1 conflict')
    expect(renderConflictFile('src/a.ts', parseConflicts(`${SIMPLE}\n${SIMPLE}`))).toContain('2 conflicts')
  })

  test('a line that is also markup is escaped', () => {
    const html = renderConflictRows(parseConflicts('<script>alert(1)</script>'))

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
