// The diff says it is working, before any script runs.
//
// The wait this covers is git computing the diff, and it is the longest wait
// in the product: the note on `FIRST_BATCH_MS` in `diffviewer.ts` records git
// needing 7.5 seconds before the first record exists on `v6.0...v7.0`.
// Everything after that first record is capped at half a second by the same
// constant, so the window worth marking is the one before it - which is also
// the window before `diffviewer.js` has loaded and had a chance to say
// anything.
//
// That is why both halves are checked here and why neither is in JavaScript.
// The files view ships `data-tone="working"` in its own markup, and the layout
// gives that attribute the ring. Take either away and the page sits under a
// muted line that reads exactly the same whether git is working or has died,
// which is the state this replaced.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const FILES_VIEW = 'resources/views/[owner]/[repository]/pull/[number]/files.stx'
const LAYOUT = 'resources/views/layouts/app.stx'

/** The opening tag of the status element in a template, whole. */
export function diffStatusTag(source: string): string | null {
  const at = source.indexOf('data-diff-status')
  if (at === -1)
    return null

  const start = source.lastIndexOf('<', at)
  const end = source.indexOf('>', at)

  return start === -1 || end === -1 ? null : source.slice(start, end + 1)
}

describe('the diff status while git is working', () => {
  test('the files view ships the working tone in its markup', () => {
    // Server-rendered, not set by the viewer on mount. A tone applied by
    // script arrives after the module loads, and the module loading was never
    // the part of the wait that hurt.
    const tag = diffStatusTag(readFileSync(FILES_VIEW, 'utf8'))

    expect(tag).not.toBeNull()
    expect(tag).toContain('data-tone="working"')
  })

  test('the layout gives that tone a ring', () => {
    const layout = readFileSync(LAYOUT, 'utf8')

    expect(layout).toContain("[data-diff-status][data-tone='working']::before")
    expect(layout).toMatch(/\[data-diff-status\]\[data-tone='working'\]::before\s*\{[^}]*animation:\s*busy-spin/)
  })

  test('and gives it to that tone only', () => {
    // `done`, `warn` and `error` are terminal. A ring on any of them is a page
    // that claims to still be working after it has stopped.
    const layout = readFileSync(LAYOUT, 'utf8')

    for (const tone of ['done', 'warn', 'error'])
      expect(layout).not.toContain(`[data-diff-status][data-tone='${tone}']::before`)
  })
})
