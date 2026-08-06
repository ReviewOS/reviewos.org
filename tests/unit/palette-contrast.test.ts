/**
 * Whether the code is readable on every palette this application ships.
 *
 * "Checked rather than assumed" is the whole point. A diff palette is chosen by
 * eye, on one monitor, in one room - and the add and remove tints sit *behind*
 * syntax colours, so the combination that fails is rarely the one anybody
 * looked at. The values are read out of the stylesheet rather than duplicated
 * here, so this cannot pass while the page uses different colours.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const stylesheet = readFileSync(join(import.meta.dir, '../../resources/views/layouts/app.stx'), 'utf8')

/**
 * The custom properties one block declares.
 *
 * The *first* block matching the selector, deliberately: every palette is
 * declared once for light and again inside a dark media query, and merging the
 * two gives a set that no browser ever renders - dark tints under light text.
 * Reading the first attempt at this did exactly that and reported four palettes
 * as illegible when none of them was.
 */
function paletteFor(selector: string, occurrence = 0): Record<string, string> {
  const values: Record<string, string> = {}

  let at = -1
  for (let seen = 0; seen <= occurrence; seen++) {
    at = stylesheet.indexOf(selector, at + 1)
    if (at < 0)
      return values
  }

  const open = stylesheet.indexOf('{', at)
  const close = stylesheet.indexOf('}', open)
  if (open < 0 || close < 0)
    return values

  for (const [, name, value] of stylesheet.slice(open, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    values[name] = value.trim()

  return values
}

function channels(colour: string): [number, number, number] {
  const hex = colour.replace('#', '')
  const full = hex.length === 3 ? [...hex].map(digit => digit + digit).join('') : hex

  return [0, 2, 4].map(at => Number.parseInt(full.slice(at, at + 2), 16) / 255) as [number, number, number]
}

/** WCAG relative luminance: the gamma-corrected, perceptually weighted one. */
function luminance(colour: string): number {
  const [red, green, blue] = channels(colour).map(value =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) as [number, number, number]

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(a: string, b: string): number {
  const light = Math.max(luminance(a), luminance(b))
  const dark = Math.min(luminance(a), luminance(b))

  return (light + 0.05) / (dark + 0.05)
}

const base = paletteFor(':root {')
const dark = paletteFor(':root[data-theme=\'dark\']')

/** The add and remove tints of one palette, over the text they sit behind. */
function surfaces(palette: Record<string, string>, fallback: Record<string, string>) {
  const pick = (name: string) => palette[name] ?? fallback[name] ?? ''

  return {
    text: pick('--text'),
    addBackground: pick('--add-bg'),
    removeBackground: pick('--del-bg'),
    addMark: pick('--add-line'),
    removeMark: pick('--del-line'),
  }
}

const palettes: Array<[string, ReturnType<typeof surfaces>]> = [
  ['classic, light', surfaces(base, base)],
  ['classic, dark', surfaces(dark, base)],
  ['deuteranopia', surfaces(paletteFor('[data-diff-palette=\'deuteranopia\']'), base)],
  ['tritanopia', surfaces(paletteFor('[data-diff-palette=\'tritanopia\']'), base)],
  ['contrast', surfaces(paletteFor('[data-diff-palette=\'contrast\']'), base)],
]

/**
 * The claim the alternative palettes make, checked.
 *
 * Red and green differ almost entirely in hue and barely at all in luminance,
 * which is exactly why a reader who cannot separate those hues cannot separate
 * the two sides of a diff. An alternative palette that also differed only in
 * hue would be a different pair of colours and the same failure - so the test
 * is that the two sides differ in *brightness*, which is the channel those
 * readers still have.
 */
describe('the colour-vision palettes differ by more than hue', () => {
  for (const name of ['deuteranopia', 'tritanopia', 'contrast']) {
    test(`${name} separates the two sides by luminance, not only by hue`, () => {
      const palette = surfaces(paletteFor(`[data-diff-palette='${name}']`), base)

      expect(contrast(palette.addBackground, palette.removeBackground)).toBeGreaterThan(1.08)
    })
  }

  /**
   * And the conventional pair does not, which is the whole reason the others
   * exist. Stated as a test so that nobody "improves" the classic palette into
   * something that makes the alternatives look unnecessary.
   */
  test('the classic pair does not, which is what the others are for', () => {
    const palette = surfaces(base, base)

    expect(contrast(palette.addBackground, palette.removeBackground)).toBeLessThan(1.08)
  })
})

describe('every diff palette is readable', () => {
  for (const [name, palette] of palettes) {
    test(`${name} has the colours it claims to`, () => {
      for (const [key, value] of Object.entries(palette)) {
        expect(value, `${name} is missing ${key}`).toMatch(/^#[0-9a-f]{3,8}$/i)
      }
    })

    /**
     * 4.5:1 is the WCAG AA threshold for body text, and code is body text: it
     * is what the reader is here to read, at a small size, for a long time.
     */
    test(`${name} keeps code legible on an added line`, () => {
      expect(contrast(palette.text, palette.addBackground)).toBeGreaterThanOrEqual(4.5)
    })

    test(`${name} keeps code legible on a removed line`, () => {
      expect(contrast(palette.text, palette.removeBackground)).toBeGreaterThanOrEqual(4.5)
    })

    /**
     * The intra-line mark sits on top of the line's own tint, so it has to be
     * distinguishable from it - otherwise marking what changed within a line
     * marks nothing. A lower bar than text contrast, because this is a wash
     * behind characters rather than something to read.
     */
    test(`${name} makes an intra-line mark visible against its own line`, () => {
      expect(contrast(palette.addMark, palette.addBackground)).toBeGreaterThan(1.1)
      expect(contrast(palette.removeMark, palette.removeBackground)).toBeGreaterThan(1.1)
    })

    test(`${name} does not use one colour for both sides`, () => {
      expect(palette.addBackground).not.toBe(palette.removeBackground)
    })
  }
})
