import { describe, expect, it } from 'bun:test'
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

function unnamedControlsIn(source: string): string[] {
  let markup = source.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
  markup = markup.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')

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
