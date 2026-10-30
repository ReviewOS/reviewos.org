/**
 * Whether the interface is readable, and whether its colours are real.
 *
 * `palette-contrast.test.ts` next door checks the diff's own palettes. This
 * one checks the palette everything else is painted with, and it exists
 * because every failure it now guards against shipped at once:
 *
 *  - `labels` and `milestones` drew their primary button as `color: var(--bg)`
 *    on `background: var(--fg)`. `--fg` is not a token any palette here
 *    declares, so the fill was dropped as invalid at computed-value time and
 *    the label rendered in the page background colour on the page background.
 *    1.04:1 in light, 1.08:1 in dark - an invisible button, in both themes, on
 *    the one control each screen is built around. The same mistake made "New
 *    issue" invisible on every issue list, and a ticked task box in Markdown
 *    render as an empty one.
 *  - The run log's ANSI colours were half tokens and half hex literals picked
 *    against somebody else's terminal: black at 2.4:1, magenta at 3.4:1 in
 *    light, cyan at 3.6:1 in dark.
 *  - Read inbox rows, draft review rows, resolved threads, viewed files and
 *    the disabled pager were all dimmed with `opacity`, which multiplies
 *    through to the already-muted text inside them. `--muted` at 0.55 is
 *    2.3:1.
 *
 * None of that is subtle, and none of it was caught by looking: each one is a
 * state you have to get the page into, on a theme you have to be using. So the
 * values are read out of the stylesheets rather than restated here, and the
 * test is of the files the browser actually serves.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const resources = join(import.meta.dir, '../../resources')

function stylesheets(directory: string): string[] {
  const found: string[] = []

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)

    if (statSync(path).isDirectory())
      found.push(...stylesheets(path))
    else if (path.endsWith('.stx') || path.endsWith('.css'))
      found.push(path)
  }

  return found
}

const files = stylesheets(resources)

/**
 * The custom properties one block declares.
 *
 * The first block matching the selector, for the reason the diff palette test
 * gives: every palette is declared once for light and again for dark, and
 * merging them gives a set no browser ever renders.
 */
function paletteFor(source: string, selector: string): Record<string, string> {
  const values: Record<string, string> = {}
  const at = source.indexOf(selector)
  if (at < 0)
    return values

  const open = source.indexOf('{', at)
  const close = source.indexOf('}', open)
  if (open < 0 || close < 0)
    return values

  for (const [, name, value] of source.slice(open, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
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

const application = readFileSync(join(resources, 'views/layouts/app.stx'), 'utf8')
const marketing = readFileSync(join(resources, 'views/layouts/marketing.stx'), 'utf8')
const landing = readFileSync(join(resources, 'views/index.stx'), 'utf8')

/**
 * The three palettes the site actually ships.
 *
 * Three, because the landing page carries its own document rather than a
 * layout and the marketing pages have a layout of their own - so the same
 * greys are written out three times and can drift three ways. They are checked
 * separately here and compared to each other below.
 */
const palettes: Array<[string, Record<string, string>]> = [
  ['the application, light', paletteFor(application, ':root {')],
  ['the application, dark', paletteFor(application, ':root[data-theme=\'dark\']')],
  ['the marketing pages, light', paletteFor(marketing, ':root {')],
  ['the marketing pages, dark', paletteFor(marketing, ':root[data-theme=\'dark\']')],
  ['the landing page, light', paletteFor(landing, ':root {')],
  ['the landing page, dark', paletteFor(landing, ':root[data-theme=\'dark\']')],
]

/**
 * Foreground, background, and the floor it has to clear.
 *
 * 4.5:1 is WCAG AA for body text, and nearly everything on a forge is body
 * text: a branch name, a timestamp, a reviewer's handle, a line of a build
 * log. 3:1 is the large-text and non-text floor, and the only things held to
 * it here are fills that carry no words of their own.
 */
const pairs: Array<[string, string, number]> = [
  ['--text', '--bg', 4.5],
  ['--text', '--surface', 4.5],
  ['--text', '--surface-tint', 4.5],
  ['--muted', '--bg', 4.5],
  ['--muted', '--surface', 4.5],
  ['--muted', '--surface-tint', 4.5],
  ['--accent-text', '--bg', 4.5],
  ['--accent-text', '--surface', 4.5],
  ['--accent-text', '--surface-tint', 4.5],
  ['--accent-text', '--accent-quiet', 4.5],
  ['--pill-text', '--surface-tint', 4.5],
  // The label on a filled control, against the fill it sits on. This is the
  // pair the invisible buttons got wrong.
  ['--on-accent', '--accent', 4.5],
  ['--accent', '--bg', 3],
  ['--accent', '--surface', 3],
  // Review states, on the page and on their own tint.
  ['--ok', '--surface', 4.5],
  ['--bad', '--surface', 4.5],
  ['--warn', '--surface', 4.5],
  ['--ok', '--ok-bg', 4.5],
  ['--bad', '--bad-bg', 4.5],
  ['--warn', '--warn-bg', 4.5],
  // What a build's own escape codes resolve to. The log body is `--surface`.
  ['--ansi-gray', '--surface', 4.5],
  ['--ansi-blue', '--surface', 4.5],
  ['--ansi-magenta', '--surface', 4.5],
  ['--ansi-cyan', '--surface', 4.5],
  // Code sits on the tinted surface, in both the Markdown block and the blob.
  ['--text', '--add-bg', 4.5],
  ['--text', '--del-bg', 4.5],
]

describe('every palette the site ships is readable', () => {
  for (const [name, palette] of palettes) {
    for (const [foreground, background, floor] of pairs) {
      const ink = palette[foreground]
      const paper = palette[background]

      // A palette that does not declare one of a pair has nothing to say about
      // it: the marketing pages carry no review states, and the landing page
      // names its one state colour something else. What they do declare is
      // what they are held to.
      if (!ink || !paper || !ink.startsWith('#') || !paper.startsWith('#'))
        continue

      test(`${name}: ${foreground} on ${background} clears ${floor}:1`, () => {
        expect(contrast(ink, paper)).toBeGreaterThanOrEqual(floor)
      })
    }
  }
})

/**
 * The same greys in three files, kept the same.
 *
 * Not an argument that three copies are right - they are not - but while they
 * exist, a change to one of them that misses the other two is a page that
 * changes colour when you click a link, and that is exactly the bug the
 * light/dark choice had before it was wired into all three documents.
 */
describe('the three documents agree about what a colour is', () => {
  const groups: Array<[string, Record<string, string>, Record<string, string>]> = [
    ['light', paletteFor(application, ':root {'), paletteFor(marketing, ':root {')],
    ['dark', paletteFor(application, ':root[data-theme=\'dark\']'), paletteFor(marketing, ':root[data-theme=\'dark\']')],
  ]

  for (const [mode, product, pages] of groups) {
    test(`the marketing pages use the application's ${mode} values`, () => {
      for (const [token, value] of Object.entries(pages)) {
        if (product[token] && value.startsWith('#'))
          expect(`${token}: ${value}`).toBe(`${token}: ${product[token]}`)
      }
    })
  }

  for (const [mode, selector] of [['light', ':root {'], ['dark', ':root[data-theme=\'dark\']']] as const) {
    test(`the landing page uses the application's ${mode} values`, () => {
      const product = paletteFor(application, selector)

      for (const [token, value] of Object.entries(paletteFor(landing, selector))) {
        if (product[token] && value.startsWith('#'))
          expect(`${token}: ${value}`).toBe(`${token}: ${product[token]}`)
      }
    })
  }
})

/**
 * Every colour a stylesheet asks for is a colour something declares.
 *
 * This is the test that would have caught all of it. `var(--fg)` is not an
 * error anywhere: the parser accepts it, the declaration is dropped at
 * computed-value time, the property falls back to its inherited or initial
 * value, and the page renders - wrong, silently, in one state on one theme.
 * A name with no declaration behind it is a typo that only a reader finds.
 *
 * A fallback is allowed, because `var(--diff-viewport-offset, 0px)` is a
 * deliberate hook for a value set at runtime. A bare name is not.
 */
describe('no stylesheet asks for a colour that does not exist', () => {
  const declared = new Set<string>()

  for (const file of files) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/gi))
      declared.add(name)
  }

  test('every bare var() names a declared custom property', () => {
    const missing: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')

      source.split('\n').forEach((line, index) => {
        for (const [, name] of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)) {
          if (!declared.has(name))
            missing.push(`${file.slice(file.indexOf('resources'))}:${index + 1} uses ${name}`)
        }
      })
    }

    expect(missing).toEqual([])
  })
})
