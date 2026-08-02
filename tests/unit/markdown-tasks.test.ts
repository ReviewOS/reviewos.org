/**
 * Ticking a task list item edits the markdown source, not the rendered HTML.
 *
 * The property every test here is really checking is that nothing else in the
 * body moves. A body is somebody's writing; ticking a box is not permission to
 * reformat it.
 */

import { describe, expect, test } from 'bun:test'
import { taskItems, toggleTask } from '../../app/Actions/Markdown/tasks'

const LIST = [
  'Before the list.',
  '',
  '- [ ] first',
  '- [x] second',
  '* [ ] third',
  '+ [X] fourth',
  '1. [ ] fifth',
  '',
  'After the list.',
].join('\n')

describe('taskItems', () => {
  test('finds every marker style, in source order', () => {
    expect(taskItems(LIST).map(item => item.label)).toEqual(['first', 'second', 'third', 'fourth', 'fifth'])
  })

  test('reads the state, upper or lower case', () => {
    expect(taskItems(LIST).map(item => item.checked)).toEqual([false, true, false, true, false])
  })

  test('numbers them from zero, matching what the rendered checkbox carries', () => {
    expect(taskItems(LIST).map(item => item.index)).toEqual([0, 1, 2, 3, 4])
  })

  test('finds nested items too', () => {
    const source = '- [ ] outer\n  - [x] inner'

    expect(taskItems(source).map(item => item.label)).toEqual(['outer', 'inner'])
  })

  /** `- [x]foo` is a list item starting with a bracket, not a task. */
  test('needs the space after the bracket', () => {
    expect(taskItems('- [x]not a task')).toEqual([])
  })

  test('is not fooled by a bracket in ordinary text', () => {
    expect(taskItems('- see [x] in the table\n- [ ] real')).toHaveLength(1)
  })

  /**
   * The renderer does not turn a fenced example into checkboxes, so neither
   * does this - otherwise the indices disagree and ticking one box moves
   * another.
   */
  test('skips items inside a fence', () => {
    const source = '- [ ] real\n\n```\n- [ ] example\n- [x] example\n```\n\n- [ ] also real'

    expect(taskItems(source).map(item => item.label)).toEqual(['real', 'also real'])
  })

  test('finds nothing in a body with no list', () => {
    expect(taskItems('Just prose.')).toEqual([])
    expect(taskItems('')).toEqual([])
  })
})

describe('toggleTask', () => {
  test('ticks the item asked for and nothing else', () => {
    const result = toggleTask(LIST, 0, true)

    expect(result.ok && result.changed).toBe(true)
    expect(result.ok && result.source.split('\n')[2]).toBe('- [x] first')
    // Every other line survives untouched.
    expect(result.ok && result.source.split('\n').filter((_, i) => i !== 2))
      .toEqual(LIST.split('\n').filter((_, i) => i !== 2))
  })

  test('unticks', () => {
    const result = toggleTask(LIST, 1, false)

    expect(result.ok && result.source.split('\n')[3]).toBe('- [x] second'.replace('x', ' '))
  })

  test('keeps the marker, the indentation and the spacing exactly', () => {
    const source = '   *   [ ]   spaced out'
    const result = toggleTask(source, 0, true)

    expect(result.ok && result.source).toBe('   *   [x]   spaced out')
  })

  test('keeps an ordered marker', () => {
    const result = toggleTask('1. [ ] one', 0, true)

    expect(result.ok && result.source).toBe('1. [x] one')
  })

  test('leaves the body alone when the state already matches', () => {
    const result = toggleTask(LIST, 1, true)

    expect(result.ok && result.changed).toBe(false)
    expect(result.ok && result.source).toBe(LIST)
  })

  /** A stale page ticking item 4 of a three-item list should hear about it. */
  test('refuses an index that is not there', () => {
    expect(toggleTask(LIST, 99, true)).toEqual({ ok: false, error: 'That task is no longer in this text' })
    expect(toggleTask(LIST, -1, true).ok).toBe(false)
    expect(toggleTask(LIST, 1.5, true).ok).toBe(false)
  })

  /**
   * Two people on one issue: without this, the second write silently undoes a
   * state the second person never saw.
   */
  test('refuses when the item is not in the state the caller last saw', () => {
    expect(toggleTask(LIST, 1, false, false)).toEqual({ ok: false, error: 'Somebody else changed that task first' })
  })

  test('proceeds when the expected state matches', () => {
    expect(toggleTask(LIST, 1, false, true).ok).toBe(true)
  })

  test('indexes past a fence the same way the renderer does', () => {
    const source = '- [ ] real\n\n```\n- [ ] example\n```\n\n- [ ] also real'
    const result = toggleTask(source, 1, true)

    expect(result.ok && result.source).toContain('- [x] also real')
    expect(result.ok && result.source).toContain('- [ ] example')
  })
})
