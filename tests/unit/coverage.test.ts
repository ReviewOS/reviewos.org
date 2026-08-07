// Coverage, parsed and rendered. The honesty rule is most of what is held:
// absence of data must render nothing, because a marker that defaults to
// "covered" is the diff lying about the one thing this exists to say.

import { describe, expect, test } from 'bun:test'
import { parseLcov } from '../../app/Actions/Checks/coverage'
import { parseDiff } from '../../app/Actions/Pull/diff'
import { renderDiffRows } from '../../app/Actions/Pull/rows'

describe('parseLcov', () => {
  test('splits hits from misses, per file', () => {
    const report = [
      'TN:',
      'SF:src/app.ts',
      'DA:1,5',
      'DA:2,0',
      'DA:3,1',
      'end_of_record',
      'SF:src/other.ts',
      'DA:10,0',
      'end_of_record',
    ].join('\n')

    const parsed = parseLcov(report)

    expect(parsed.get('src/app.ts')?.covered).toEqual([1, 3])
    expect(parsed.get('src/app.ts')?.uncovered).toEqual([2])
    expect(parsed.get('src/other.ts')?.uncovered).toEqual([10])
  })

  test('skips what it does not speak, and survives CRLF', () => {
    const report = 'SF:a.ts\r\nFN:1,main\r\nBRDA:1,0,0,1\r\nDA:junk,1\r\nDA:4,0\r\nend_of_record\r\n'

    const parsed = parseLcov(report)

    expect(parsed.get('a.ts')?.uncovered).toEqual([4])
    expect(parsed.get('a.ts')?.covered).toEqual([])
  })

  test('an empty report names no files', () => {
    expect(parseLcov('').size).toBe(0)
  })
})

const DIFF = `diff --git a/app.ts b/app.ts
index 0000000..1111111 100644
--- a/app.ts
+++ b/app.ts
@@ -1,3 +1,4 @@
 const keep = 1
-const old = 2
+const changed = 2
+const added = 3
 const tail = 4
`

describe('the marker in the diff', () => {
  test('lands only on added lines the report calls uncovered', () => {
    const file = parseDiff(DIFF)[0]!

    // Line 2 is the changed line, line 3 the added one; only 3 is uncovered.
    const html = renderDiffRows(file, { layout: 'unified', uncoveredLines: new Set([3]) })

    const rows = html.split('<tr')
    const flagged = rows.filter(row => row.includes('is-uncovered'))

    expect(flagged.length).toBe(1)
    expect(flagged[0]).toContain('untested')
    expect(flagged[0]!.replace(/<[^>]+>/g, '')).toContain('added')
  })

  test('a removed line whose old number collides with the set is never marked', () => {
    const file = parseDiff(DIFF)[0]!

    // Old line 2 is removed; new line 2 is in the set. Only the ADDED line 2
    // may carry the mark.
    const html = renderDiffRows(file, { layout: 'unified', uncoveredLines: new Set([2]) })
    const flagged = html.split('<tr').filter(row => row.includes('is-uncovered'))

    expect(flagged.length).toBe(1)
    expect(flagged[0]).toContain('line-added')
  })

  test('no report renders byte-identical markup to before the feature', () => {
    const file = parseDiff(DIFF)[0]!

    const plain = renderDiffRows(file, { layout: 'unified' })
    const empty = renderDiffRows(file, { layout: 'unified', uncoveredLines: new Set() })

    expect(empty).toBe(plain)
    expect(plain).not.toContain('is-uncovered')
  })

  test('the split layout marks the same line, on the new side only', () => {
    const file = parseDiff(DIFF)[0]!

    const html = renderDiffRows(file, { layout: 'split', uncoveredLines: new Set([3]) })
    const flagged = html.split('<tr').filter(row => row.includes('is-uncovered'))

    expect(flagged.length).toBe(1)
    expect(flagged[0]).toContain('data-side="new"')
  })
})
