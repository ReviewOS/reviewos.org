// Folding mechanical hunks: the arithmetic and the honesty.
//
// The number a fold changes - how many rows a file contributes - is the same
// number in three places by design: what countRows counts, what the renderer
// emits, and what the manifest tells the client. These tests hold the three
// to one another, because the drift between them is a file that appears to
// scroll past itself.

import { describe, expect, test } from 'bun:test'
import { classifyFile, foldedHunkIndexes } from '../../app/Actions/Pull/classify'
import { parseDiff } from '../../app/Actions/Pull/diff'
import { countRows, hunkBodyRows } from '../../app/Actions/Pull/metrics'
import { defaultFoldsFor } from '../../app/Actions/Pull/manifest'
import { renderDiffFile, renderDiffRows } from '../../app/Actions/Pull/rows'

/**
 * A mixed file: one formatting-only hunk (indentation change, three pairs so
 * the substitution minimum is met), one logic hunk. The fixture the fold
 * policy exists for.
 */
const MIXED = `diff --git a/app.ts b/app.ts
index 0000000..1111111 100644
--- a/app.ts
+++ b/app.ts
@@ -1,4 +1,4 @@
-const a  = 1
-const b  = 2
-const c  = 3
+const a = 1
+const b = 2
+const c = 3
 const keep = 4
@@ -10,3 +10,4 @@
 function real() {
-  return 1
+  return 2
+  // and something new
 }
`

function mixedFile() {
  const files = parseDiff(MIXED)
  expect(files.length).toBe(1)
  return files[0]!
}

describe('the fold policy', () => {
  test('folds the mechanical hunks of a mixed file and nothing else', () => {
    const file = mixedFile()
    const classification = classifyFile(file)

    expect(classification.reason).toBeNull()

    const folded = foldedHunkIndexes(classification)
    expect([...folded]).toEqual([0])
  })

  test('a hunk carrying a thread never folds', () => {
    const file = mixedFile()
    const folds = defaultFoldsFor(file, [
      { id: 1, path: 'app.ts', line: 2, originalLine: 2, side: 'right', resolved: false } as any,
    ])

    expect(folds.folded.size).toBe(0)
  })

  test('a single-reason file folds whole, never per hunk', () => {
    const file = mixedFile()
    const classification = classifyFile(file)

    expect(foldedHunkIndexes({ ...classification, reason: 'formatting' }).size).toBe(0)
  })
})

describe('the fold arithmetic', () => {
  test('folded counts are the full counts minus each folded body', () => {
    const file = mixedFile()
    const folded = new Set([0])

    const full = countRows(file)
    const effective = countRows(file, folded)
    const hidden = hunkBodyRows(file.hunks[0]!)

    expect(effective.unified).toBe(full.unified - hidden.unified)
    expect(effective.split).toBe(full.split - hidden.split)
  })

  test('the renderer emits exactly the folded count of rows', () => {
    const file = mixedFile()
    const folded = new Set([0])

    const html = renderDiffRows(file, { layout: 'unified', foldedHunks: folded })
    const rendered = html.split('<tr').length - 1

    expect(rendered).toBe(countRows(file, folded).unified)
  })

  test('the manifest count and the renderer agree through defaultFoldsFor', () => {
    const file = mixedFile()
    const folds = defaultFoldsFor(file)

    const html = renderDiffRows(file, { layout: 'unified', foldedHunks: folds.folded })
    const rendered = html.split('<tr').length - 1

    expect(rendered).toBe(countRows(file, folds.folded).unified)
  })
})

describe('what the fold says', () => {
  test('the folded separator says what it hides and offers the way in', () => {
    const file = mixedFile()

    const html = renderDiffRows(file, { layout: 'unified', foldedHunks: new Set([0]) })

    expect(html).toContain('hunk-unfold')
    expect(html).toContain(`${hunkBodyRows(file.hunks[0]!).unified} hidden lines`)
  })

  test('the no-script page folds as a details with the rows inside', () => {
    const file = mixedFile()

    const html = renderDiffFile(file, { hunkFolds: 'details' })

    expect(html).toContain('<details class="hunk-fold">')
    expect(html).toContain('hidden lines')
    // Nothing is removed: the folded hunk's rows are in the page, closed.
    // Tags stripped, because the renderer splits content across token spans.
    expect(html.replace(/<[^>]+>/g, '')).toContain('const a')
    // And a details never sits inside a table, where browsers would silently
    // foster-parent it out.
    expect(html.indexOf('<details class="hunk-fold">')).toBeLessThan(html.indexOf('<table', html.indexOf('<details class="hunk-fold">')))
  })

  test('a file with nothing to fold renders exactly as before', () => {
    const file = mixedFile()

    const plain = renderDiffFile(file, {})
    const offered = renderDiffFile({ ...file, hunks: [file.hunks[1]!] }, { hunkFolds: 'details' })

    expect(plain).not.toContain('hunk-fold')
    expect(offered).not.toContain('<details class="hunk-fold">')
  })
})
