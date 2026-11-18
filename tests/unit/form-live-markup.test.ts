// Every form that answers in place has somewhere to put the answer.
//
// `public/js/form-live.js` cancels the navigation and then writes what came
// back into the element marked `data-live-status` inside the form. A form that
// opts in without one saves correctly and says *nothing at all*: the button
// un-busies, the page does not move, and the only way to find out whether it
// worked is to reload the page by hand. That is strictly worse than the full
// round trip it replaced, and it is invisible in review - the attribute that
// is missing is the one nobody is looking at.
//
// So the pairing is checked rather than remembered. This reads the templates
// as text, like `tests/unit/form-controls-named.test.ts` does, because the
// failure is in the markup and there is no page to render here.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['resources/views', 'resources/components', 'resources/layouts', 'resources/partials']

function templates(dir: string): string[] {
  let found: string[] = []

  try {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)

      if (statSync(path).isDirectory())
        found = found.concat(templates(path))
      else if (entry.endsWith('.stx'))
        found.push(path)
    }
  }
  catch {
    return []
  }

  return found
}

/**
 * The templates' comments are not markup.
 *
 * A `{{-- ... --}}` block explaining `data-live` reads exactly like a form
 * that uses it, and this test failing on its own explanation is how the
 * sibling scanner first went red in CI. Stripped before anything is matched.
 */
export function withoutComments(text: string): string {
  return text
    .replace(/\{\{--[\s\S]*?--\}\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

/** Each `data-live` form in a template, as its own chunk of markup. */
export function liveFormsIn(text: string): string[] {
  const body = withoutComments(text)
  const forms: string[] = []

  for (const part of body.split(/<form\b/).slice(1)) {
    const form = part.split(/<\/form>/)[0] ?? ''
    const head = form.slice(0, 400)

    // `data-live` itself, not `data-live-was` or `data-live-status`, which are
    // the attributes a form carrying it also sets.
    if (/data-live(?=[\s>=]|$)/.test(head))
      forms.push(form)
  }

  return forms
}

describe('the scanner reads markup and not prose', () => {
  test('a form that opts in is found', () => {
    expect(liveFormsIn('<form method="post" data-live><p data-live-status></p></form>')).toHaveLength(1)
  })

  test('a comment describing one is not', () => {
    expect(liveFormsIn('{{-- data-live opts a form in, see form-live.js --}}')).toHaveLength(0)
    expect(liveFormsIn('<!-- <form data-live> --> <form method="post"></form>')).toHaveLength(0)
  })

  test('and the sibling attributes do not look like the flag', () => {
    // `data-live-was` without `data-live` is a form that is not opted in, so
    // requiring a status element of it would be a false failure.
    expect(liveFormsIn('<form method="post" data-live-was="chris"></form>')).toHaveLength(0)
    expect(liveFormsIn('<form method="post" data-live-says="a.b"></form>')).toHaveLength(0)
  })

  test('a missing status element is what this catches', () => {
    const [form] = liveFormsIn('<form method="post" data-live><button>Save</button></form>')

    expect(form).toBeDefined()
    expect(/data-live-status/.test(form!)).toBe(false)
  })
})

describe('every live form in the product', () => {
  const files = ROOTS.flatMap(root => templates(root))

  test('there are templates to read', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  test('has an element to write the answer into', () => {
    const missing: string[] = []

    for (const file of files) {
      for (const form of liveFormsIn(readFileSync(file, 'utf8'))) {
        if (!/data-live-status/.test(form))
          missing.push(`${file}: a data-live form with no data-live-status`)
      }
    }

    expect(missing).toEqual([])
  })

  test('and the ones that exist are the ones meant to be live', () => {
    // A roster rather than a count. Adding a live form is a decision about
    // where its answer goes, so it should be a line in this list and not a
    // number that goes up.
    const live = files
      .filter(file => liveFormsIn(readFileSync(file, 'utf8')).length > 0)
      .sort()

    expect(live).toEqual([
      'resources/views/[owner]/[repository]/settings.stx',
      'resources/views/settings/notifications.stx',
      'resources/views/settings/profile.stx',
    ])
  })
})

describe('a form that can move the page says so', () => {
  test('`data-live-was` and `data-live-moved` travel together', () => {
    // One without the other is a dead check: a remembered value nothing is
    // compared against, or a field named with nothing to compare it to.
    const problems: string[] = []

    for (const file of ROOTS.flatMap(root => templates(root))) {
      for (const form of liveFormsIn(readFileSync(file, 'utf8'))) {
        const head = form.slice(0, 400)
        const was = /data-live-was=/.test(head)
        const moved = /data-live-moved=/.test(head)

        if (was !== moved)
          problems.push(`${file}: data-live-was and data-live-moved must both be set or neither`)
      }
    }

    expect(problems).toEqual([])
  })
})
