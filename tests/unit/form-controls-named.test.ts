import { describe, expect, it, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Every form control a person can type into has a name a screen reader can say.
 *
 * A placeholder is not that name. It is announced inconsistently, it is gone the
 * moment somebody types, and it is the first thing to disappear when a field is
 * refilled from a failed submit - so a reader who cannot see the form is left
 * with "edit text, blank" on a field that decides who owns a repository.
 *
 * The product mostly gets this right already, which is what makes the gaps worth
 * catching: `labels.stx` labelled the three inputs on its edit row and missed two
 * on the create row directly above it. That is not a decision anybody made.
 *
 * A control is named by a `<label for>`, by a `<label>` wrapped around it, by
 * `aria-label`, by `aria-labelledby`, or by `title`. Hidden and button-like
 * inputs are excluded: they are not typed into and their name is their value.
 */

const ROOTS = [
  resolve(import.meta.dir, '../../resources/views'),
  resolve(import.meta.dir, '../../resources/components'),
]

function templates(dir: string): string[] {
  const found: string[] = []

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)

    if (statSync(path).isDirectory())
      found.push(...templates(path))
    else if (entry.endsWith('.stx'))
      found.push(path)
  }

  return found
}

const NOT_TYPED_INTO = new Set(['hidden', 'submit', 'button', 'image', 'reset'])

export function unnamedControlsIn(source: string): string[] {
  let markup = source.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
  markup = markup.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')

  /*
   * Comments are not markup, and the comments here talk about markup.
   *
   * `tokens.stx` documents the control it replaced - "a list of checkboxes
   * rather than a `<select multiple>`" - and this read that sentence as an
   * unnamed `<select>` and failed the build. The control it describes had
   * been deleted in the same commit, so the test was reporting a field that
   * no longer existed, in prose explaining why it no longer existed.
   *
   * Same reasoning as the two lines above: a `<script>` can contain a string
   * that looks like a control, and so can a comment. Nothing is weakened by
   * this, because a control inside a comment renders for nobody.
   */
  markup = markup.replace(/\{\{--[\s\S]*?--\}\}/g, '')
  markup = markup.replace(/<!--[\s\S]*?-->/g, '')

  const labelled = new Set([...markup.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map(m => m[1]!))

  const wrapped = new Set<string>()
  for (const label of markup.matchAll(/<label\b(?![^>]*\bfor=)[^>]*>([\s\S]*?)<\/label>/g)) {
    for (const control of label[1]!.matchAll(/<(?:input|select|textarea)\b[^>]*>/g))
      wrapped.add(control[0])
  }

  const unnamed: string[] = []

  for (const control of markup.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)) {
    const tag = control[0]
    const type = tag.match(/type="([^"]+)"/)?.[1] ?? 'text'

    if (NOT_TYPED_INTO.has(type))
      continue
    if (/aria-label|aria-labelledby|\btitle=/.test(tag))
      continue
    if (wrapped.has(tag))
      continue

    const id = tag.match(/\bid="([^"]+)"/)?.[1]

    // An interpolated id is a per-row control; its label is interpolated too.
    if (id && (labelled.has(id) || id.includes('{{')))
      continue

    unnamed.push(tag.slice(0, 100))
  }

  return unnamed
}

describe('what counts as a control', () => {
  // The scanner itself, because the sweep above can only say "none found",
  // and "none found" is also what a broken scanner says.
  test('an unnamed field is reported', () => {
    expect(unnamedControlsIn('<form><input type="text" name="owner"></form>')).toHaveLength(1)
  })

  test('and a named one is not, however it was named', () => {
    const named = [
      '<label for="a">Owner</label><input id="a" type="text">',
      '<label>Owner<input type="text"></label>',
      '<input type="text" aria-label="Owner">',
      '<input type="text" title="Owner">',
      '<input type="hidden" name="_token" value="x">',
    ]

    for (const markup of named)
      expect(unnamedControlsIn(markup)).toEqual([])
  })

  /*
   * The case this file got wrong. `tokens.stx` replaced a `<select multiple>`
   * with a list of checkboxes and said so in a comment; the scanner read the
   * sentence as the control and failed the build over a field that had been
   * deleted in that same commit.
   */
  test('and prose about a control is prose, not a control', () => {
    expect(unnamedControlsIn('{{-- a list of checkboxes rather than a <select\n multiple> --}}')).toEqual([])
    expect(unnamedControlsIn('<!-- we used to have <input type="text"> here -->')).toEqual([])
  })

  test('but a real control beside the prose is still found', () => {
    // The failure mode of the fix: stripping too much and reporting nothing.
    const markup = '{{-- replaced the <select multiple> --}}<input type="text" name="live">'

    expect(unnamedControlsIn(markup)).toHaveLength(1)
  })
})

describe('form controls', () => {
  it('all have a name that is not just a placeholder', () => {
    const offenders: string[] = []

    for (const root of ROOTS) {
      for (const file of templates(root)) {
        for (const tag of unnamedControlsIn(readFileSync(file, 'utf8')))
          offenders.push(`${file.split('/resources/')[1]}\n      ${tag}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
