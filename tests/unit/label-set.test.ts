/**
 * Managing the label and milestone sets.
 *
 * The validation lives in one place for both the create and the update path,
 * because update is where it is usually forgotten: the value "was already valid
 * once", so nobody checks it the second time.
 */

import { describe, expect, test } from 'bun:test'
import { dueOn, labelFields, milestoneFields } from '../../app/Actions/Issue/labelSet'

describe('labelFields', () => {
  test('normalizes the name and the colour', () => {
    const result = labelFields({ name: '  needs   triage ', color: '#FFF' })

    expect(result.ok).toBe(true)
    // Stored without the `#`, the way the default label set is.
    expect(result.ok && result.value).toEqual({ name: 'needs triage', color: 'ffffff', description: null })
  })

  test('needs a name', () => {
    expect(labelFields({ name: '   ', color: '#ffffff' })).toEqual({ ok: false, error: 'A label needs a name' })
  })

  test('needs a colour it can store', () => {
    expect(labelFields({ name: 'bug', color: 'reddish' }).ok).toBe(false)
    expect(labelFields({ name: 'bug', color: '' }).ok).toBe(false)
  })

  /** Stored as absent rather than as an empty string, so the two cannot both mean "none". */
  test('turns a blank description into nothing at all', () => {
    const result = labelFields({ name: 'bug', color: '#ffffff', description: '   ' })

    expect(result.ok && result.value.description).toBeNull()
  })

  test('refuses a description nobody would read', () => {
    expect(labelFields({ name: 'bug', color: '#ffffff', description: 'x'.repeat(201) }).ok).toBe(false)
  })

  test('keeps a description that fits', () => {
    const result = labelFields({ name: 'bug', color: '#ffffff', description: '  Something is broken ' })

    expect(result.ok && result.value.description).toBe('Something is broken')
  })
})

describe('dueOn', () => {
  test('accepts a plain calendar day', () => {
    expect(dueOn('2026-08-02')).toEqual({ ok: true, value: '2026-08-02' })
  })

  test('treats nothing as no due date', () => {
    expect(dueOn(null)).toEqual({ ok: true, value: null })
    expect(dueOn(undefined)).toEqual({ ok: true, value: null })
    expect(dueOn('  ')).toEqual({ ok: true, value: null })
  })

  /**
   * The reason the format is fixed rather than parsed: `01/02` is January the
   * second to half the world and the first of February to the other half, and
   * a parser that accepts both picks one silently.
   */
  test('refuses anything that is not that shape', () => {
    expect(dueOn('01/02/2026').ok).toBe(false)
    expect(dueOn('2026-8-2').ok).toBe(false)
    expect(dueOn('next tuesday').ok).toBe(false)
    expect(dueOn('2026-08-02T12:00:00Z').ok).toBe(false)
  })

  /** These parse and then roll forward into the next month, which is worse than failing. */
  test('refuses a day that does not exist', () => {
    expect(dueOn('2026-02-30').ok).toBe(false)
    expect(dueOn('2026-13-01').ok).toBe(false)
    expect(dueOn('2026-00-10').ok).toBe(false)
  })

  test('allows a real leap day, and refuses one that is not', () => {
    expect(dueOn('2028-02-29').ok).toBe(true)
    expect(dueOn('2026-02-29').ok).toBe(false)
  })
})

describe('milestoneFields', () => {
  test('collapses whitespace in the title', () => {
    const result = milestoneFields({ title: '  1.0   release ' })

    expect(result.ok && result.value).toEqual({ title: '1.0 release', description: null, due_on: null })
  })

  test('needs a title', () => {
    expect(milestoneFields({ title: '  ' })).toEqual({ ok: false, error: 'A milestone needs a title' })
  })

  test('refuses a title too long to show in a list', () => {
    expect(milestoneFields({ title: 'x'.repeat(121) }).ok).toBe(false)
  })

  test('carries the due date through', () => {
    const result = milestoneFields({ title: '1.0', due_on: '2026-12-31' })

    expect(result.ok && result.value.due_on).toBe('2026-12-31')
  })

  test('rejects the whole milestone when the date is wrong', () => {
    expect(milestoneFields({ title: '1.0', due_on: '2026-02-30' })).toEqual({ ok: false, error: 'There is no such date' })
  })
})
