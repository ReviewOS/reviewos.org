/**
 * Rendering part of a file, by row number.
 *
 * A file of four hundred thousand lines cannot go in the document at once, so
 * the client asks for a window of rows and sizes the rest with spacers. That
 * only works while one number means the same thing everywhere: the row index
 * `countRows` counts, the row index the renderer emits, and the row index the
 * client asks for.
 *
 * If those drifted by one, every window would be off by a line and the file
 * would appear to scroll past itself - so the property is pinned here rather
 * than maintained by hand.
 */

import { describe, expect, test } from 'bun:test'
import { parseDiff } from '../../app/Actions/Pull/diff'
import { countRows } from '../../app/Actions/Pull/metrics'
import { renderDiffRows } from '../../app/Actions/Pull/rows'
import { threadSlotFor } from '../../app/Actions/Pull/threads'

/** A file with several hunks, changed blocks of different shapes, and context. */
function sample(): string {
  const hunks: string[] = []

  for (let hunk = 0; hunk < 5; hunk++) {
    const start = hunk * 20 + 1
    hunks.push(`@@ -${start},8 +${start},9 @@ section ${hunk}`)
    hunks.push(' context one')
    hunks.push('-removed one')
    hunks.push('-removed two')
    hunks.push('+added one')
    hunks.push('+added two')
    hunks.push('+added three')
    hunks.push(' context two')
    hunks.push('-only removed')
    hunks.push(' context three')
  }

  return `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n${hunks.join('\n')}\n`
}

const [file] = parseDiff(sample())
const counts = countRows(file!)

function rowsIn(html: string): number {
  return (html.match(/<tr class="(?:line|hunk-head)/g) ?? []).length
}

describe('the row numbering agrees with the counter', () => {
  for (const layout of ['unified', 'split'] as const) {
    test(`in ${layout}, rendering everything gives exactly the counted rows`, () => {
      expect(rowsIn(renderDiffRows(file!, { layout }))).toBe(counts[layout])
    })

    test(`in ${layout}, the windows tile the file with no gap and no overlap`, () => {
      const total = counts[layout]
      const whole = renderDiffRows(file!, { layout })

      let stitched = ''
      for (let from = 0; from < total; from += 7)
        stitched += renderDiffRows(file!, { layout, range: { from, to: from + 7 } })

      // Byte for byte the same as rendering it in one go, which is the only
      // check that catches a row emitted in two windows or in neither.
      expect(stitched).toBe(whole)
    })

    test(`in ${layout}, a window has as many rows as it asked for`, () => {
      expect(rowsIn(renderDiffRows(file!, { layout, range: { from: 3, to: 11 } }))).toBe(8)
    })
  }
})

describe('the edges', () => {
  test('a range past the end is empty rather than an error', () => {
    expect(renderDiffRows(file!, { range: { from: 9000, to: 9100 } })).toBe('')
  })

  test('a range that runs off the end stops at the end', () => {
    const html = renderDiffRows(file!, { range: { from: counts.unified - 3, to: counts.unified + 50 } })

    expect(rowsIn(html)).toBe(3)
  })

  test('an empty range renders nothing', () => {
    expect(renderDiffRows(file!, { range: { from: 5, to: 5 } })).toBe('')
  })

  test('no range at all is the whole file, as it always was', () => {
    expect(renderDiffRows(file!)).toBe(renderDiffRows(file!, { range: { from: 0, to: counts.unified } }))
  })
})

describe('a thread stays with its line', () => {
  const threads = [{
    id: 1,
    path: 'big.ts',
    line: 2,
    side: 'right' as const,
    resolved: false,
    outdated: false,
    comments: [{ id: 1, authorHandle: 'reviewer', bodyHtml: '<p>why</p>', createdAt: 'now' }],
  }]

  /**
   * A thread row is not counted as a row of its own, so it has to travel with
   * the line above it. A window boundary that separated the two would show a
   * comment with no code, or code whose comment had vanished.
   */
  test('the window carrying the line carries the conversation', () => {
    const threadsAt = threadSlotFor(threads, 'big.ts')
    const whole = renderDiffRows(file!, { threadsAt })

    let stitched = ''
    for (let from = 0; from < counts.unified; from += 4)
      stitched += renderDiffRows(file!, { threadsAt, range: { from, to: from + 4 } })

    expect(stitched).toBe(whole)
    expect(stitched).toContain('thread-row')
  })
})
