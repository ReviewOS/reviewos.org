// Every button that does its work outside a form says so while it is working.
//
// `public/js/form-busy.js` covers the other hundred-odd, and it covers them
// properly: one listener on the document, every posting form, the submitter
// marked and guarded. It works off the `submit` event, though, so a button
// that does its work in a click handler is invisible to it - and there is no
// navigation coming to replace the page either, so nothing else will say
// anything. The product has four of these: three push controls in
// `settings/notifications.stx` and the preview in `WikiEditor.stx`.
//
// They each set `:disabled` while they run, which greys the button out. That
// on its own reads as "you may not press this" rather than "this is already
// going", which is the wrong sentence for a control that is mid-request. So
// they also carry the ring every other busy control in the product carries,
// and `aria-busy` to go with it.
//
// Read as text, like the sibling scanners in `form-live-markup.test.ts` and
// `form-controls-named.test.ts`: the mistake is in the markup, and there is no
// page to render here. Each of those keeps its own small walker rather than
// sharing one, because each wants its own roots.

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
 * The parts of a template that are markup.
 *
 * Comments are not, and the comments here are about exactly these attributes:
 * the note above the push buttons explains why the object form of `:class` is
 * the one to use, in prose that contains the string form. A scanner that
 * reads its own explanation fails on the explanation.
 */
export function markupOf(source: string): string {
  return source
    .replace(/\{\{--[\s\S]*?--\}\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
}

/**
 * Each `<button>` opening tag, whole.
 *
 * Scanned to the closing angle bracket rather than matched with `[^>]*`,
 * because these tags carry expressions: `:class="{ 'is-busy': busy }"` and a
 * ternary with a comparison in it both hold characters that stop a lazy
 * matcher in the wrong place.
 */
export function buttonTagsIn(source: string): string[] {
  const markup = markupOf(source)
  const tags: string[] = []
  const opening = /<button\b/g
  let found = opening.exec(markup)

  while (found !== null) {
    let quote = ''
    let at = found.index

    for (; at < markup.length; at++) {
      const char = markup[at]

      if (quote !== '') {
        if (char === quote)
          quote = ''
      }
      else if (char === '"' || char === '\'') {
        quote = char
      }
      else if (char === '>') {
        break
      }
    }

    tags.push(markup.slice(found.index, at + 1))
    opening.lastIndex = at
    found = opening.exec(markup)
  }

  return tags
}

/** One attribute's value, or `null` where the tag does not carry it. */
export function valueOf(tag: string, attribute: string): string | null {
  const found = new RegExp(`(?:^|\\s)${attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`).exec(tag)

  return found === null ? null : found[1] ?? ''
}

/**
 * Whether a control is disabled because it is working, rather than because it
 * cannot be used.
 *
 * Substring, not `\b(?:busy|loading)\b`. That was the first spelling here and
 * it exempted the one button in another file: there is no word boundary
 * inside `wikiPreviewLoading`, so the rule quietly applied to three of the
 * four controls it was written for. The reason to prefer the loose match is
 * that a false positive is a sentence somebody reads and argues with, while a
 * false negative is a button nobody notices until it is pressed.
 */
function disabledWhileWorking(tag: string): boolean {
  const bound = valueOf(tag, ':disabled')

  return bound !== null && /busy|loading/i.test(bound)
}

const BUTTONS = ROOTS
  .flatMap(root => templates(root))
  .flatMap(file => buttonTagsIn(readFileSync(file, 'utf8')).map(tag => ({ file, tag })))

function offenders(wrong: (tag: string) => boolean): string[] {
  return BUTTONS.filter(({ tag }) => wrong(tag)).map(({ file, tag }) => `${file}: ${tag.replace(/\s+/g, ' ')}`)
}

describe('a button that works outside a form', () => {
  test('there are buttons to check at all', () => {
    // The scanner silently passing everything is the one failure this file
    // cannot report, so it reports the count instead.
    expect(BUTTONS.length).toBeGreaterThan(50)

    // The four the file is about. A fifth is welcome; three means one stopped
    // matching the rule rather than stopped needing it, which is how the
    // first version of this scanner passed while exempting a whole file.
    expect(BUTTONS.filter(({ tag }) => disabledWhileWorking(tag)).length).toBeGreaterThanOrEqual(4)
  })

  test('is disabled while it works, if it awaits anything', () => {
    // A click handler that awaits can be entered twice: the second press
    // arrives while the first request is still out. `form-busy.js` refuses
    // that at the second submit event, which never fires here, so the only
    // guard left is the attribute.
    expect(offenders(tag => (valueOf(tag, '@click') ?? '').includes('await') && valueOf(tag, ':disabled') === null)).toEqual([])
  })

  test('shows the ring, not just the grey', () => {
    expect(offenders(tag => disabledWhileWorking(tag) && !(valueOf(tag, ':class') ?? '').includes('is-busy'))).toEqual([])
  })

  test('tells a screen reader, and not only the eye', () => {
    /*
     * The ring is a spinning pseudo-element and nothing else. `aria-busy` is
     * the same news for somebody who is not looking at it, it is one
     * attribute, and there is no reason for a control to carry one and not
     * the other.
     *
     * Bound plainly. A bound boolean is written out as the words -
     * `aria-busy="false"`, then `aria-busy="true"` - on both of the binding
     * paths this product uses, the `x-data` scopes and the `state()` signals.
     * That was checked in a browser against the real pipeline rather than
     * read off the runtime source, which carries a third implementation that
     * would have written `aria-busy=""` and turns out to bind only custom
     * elements, of which this product has none.
     */
    const ring = (tag: string) => (valueOf(tag, ':class') ?? '').includes('is-busy')

    expect(offenders(tag => ring(tag) && valueOf(tag, ':aria-busy') === null)).toEqual([])
  })
})
