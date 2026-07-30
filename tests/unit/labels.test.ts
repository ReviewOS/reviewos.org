// Labels: names, colours, and whether the text on them can be read.
//
// The contrast function is the one that matters visually: a label whose text
// is unreadable against its own background is a label nobody can use, and the
// naive "average the channels" version gets green and blue backwards.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LABELS,
  labelNamesCollide,
  labelTextColor,
  normalizeColor,
  normalizeLabelName,
} from '../../app/Actions/Issue/labels'

describe('DEFAULT_LABELS', () => {
  test('every default has a valid colour', () => {
    for (const label of DEFAULT_LABELS)
      expect(normalizeColor(label.color)).toBe(label.color)
  })

  test('every default has a usable name', () => {
    for (const label of DEFAULT_LABELS)
      expect(normalizeLabelName(label.name)).toBe(label.name)
  })

  test('no two defaults collide', () => {
    const names = DEFAULT_LABELS.map(label => label.name.toLowerCase())

    expect(new Set(names).size).toBe(names.length)
  })

  test('every default explains itself', () => {
    for (const label of DEFAULT_LABELS)
      expect(label.description.length).toBeGreaterThan(0)
  })
})

describe('normalizeLabelName', () => {
  test('trims', () => {
    expect(normalizeLabelName('  bug  ')).toBe('bug')
  })

  test('collapses runs of whitespace', () => {
    expect(normalizeLabelName('good   first    issue')).toBe('good first issue')
  })

  test('keeps the capitals somebody typed', () => {
    expect(normalizeLabelName('Bug')).toBe('Bug')
  })

  test('refuses an empty name', () => {
    expect(normalizeLabelName('   ')).toBeNull()
  })

  test('refuses a name with a comma, which breaks list filters', () => {
    expect(normalizeLabelName('bug, urgent')).toBeNull()
  })

  test('refuses a name that is too long', () => {
    expect(normalizeLabelName('x'.repeat(51))).toBeNull()
  })

  test('accepts one at the limit', () => {
    expect(normalizeLabelName('x'.repeat(50))).toHaveLength(50)
  })
})

describe('labelNamesCollide', () => {
  test('the same name collides', () => {
    expect(labelNamesCollide('bug', 'bug')).toBe(true)
  })

  test('case does not save you', () => {
    expect(labelNamesCollide('Bug', 'bug')).toBe(true)
  })

  test('surrounding whitespace does not save you', () => {
    expect(labelNamesCollide(' bug ', 'bug')).toBe(true)
  })

  test('different names do not collide', () => {
    expect(labelNamesCollide('bug', 'bugs')).toBe(false)
  })
})

describe('normalizeColor', () => {
  test('accepts six hex digits', () => {
    expect(normalizeColor('d73a4a')).toBe('d73a4a')
  })

  test('accepts a leading hash', () => {
    expect(normalizeColor('#d73a4a')).toBe('d73a4a')
  })

  test('lowercases', () => {
    expect(normalizeColor('#D73A4A')).toBe('d73a4a')
  })

  test('expands the three-digit form', () => {
    expect(normalizeColor('#fff')).toBe('ffffff')
    expect(normalizeColor('0a5')).toBe('00aa55')
  })

  test('refuses anything else', () => {
    expect(normalizeColor('red')).toBeNull()
    expect(normalizeColor('#12345')).toBeNull()
    expect(normalizeColor('')).toBeNull()
  })
})

describe('labelTextColor', () => {
  test('black text on white', () => {
    expect(labelTextColor('ffffff')).toBe('black')
  })

  test('white text on black', () => {
    expect(labelTextColor('000000')).toBe('white')
  })

  test('white text on a dark red', () => {
    expect(labelTextColor('d73a4a')).toBe('white')
  })

  test('black text on a pale blue', () => {
    expect(labelTextColor('a2eeef')).toBe('black')
  })

  test('green and blue of the same channel value get opposite text', () => {
    // The reason luminance is weighted: eyes are far more sensitive to green.
    expect(labelTextColor('00ff00')).toBe('black')
    expect(labelTextColor('0000ff')).toBe('white')
  })

  test('falls back to black on an unusable colour', () => {
    expect(labelTextColor('nonsense')).toBe('black')
  })

  test('every default label is readable', () => {
    for (const label of DEFAULT_LABELS)
      expect(['black', 'white']).toContain(labelTextColor(label.color))
  })
})
