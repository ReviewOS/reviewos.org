// The markup for a file's diff.
//
// One renderer serves both the server-rendered first screen and the rows
// streamed to the virtualized list, so what is asserted here is mostly that the
// two layouts agree with the row counts the list lays itself out from, and that
// nothing from a patch can escape into the page as markup.

import { describe, expect, test } from 'bun:test'
import { parseDiff } from '../../app/Actions/Pull/diff'
import { countRows } from '../../app/Actions/Pull/metrics'
import { escapeHtml, renderDiffShell } from '../../app/Actions/Pull/shell'
import {
  highlightDiffFile,
  renderDiffFile,
  renderDiffNote,
  renderDiffRows,
  tokenKey,
} from '../../app/Actions/Pull/rows'

const uneven = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
`

const fileOf = (raw: string) => parseDiff(raw)[0]!

/** Count `<tr>` openings, which is what the list's row arithmetic predicts. */
function countTableRows(html: string): number {
  return (html.match(/<tr[\s>]/g) ?? []).length
}

describe('escapeHtml', () => {
  test('closes every hole a patch could come through', () => {
    expect(escapeHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

  test('escapes the ampersand first, so an entity is not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})

describe('tokenKey', () => {
  test('keys a removal by its old line and everything else by its new line', () => {
    expect(tokenKey({ origin: 'removed', oldLine: 4, newLine: null })).toBe('-4')
    expect(tokenKey({ origin: 'added', oldLine: null, newLine: 7 })).toBe('+7')
    expect(tokenKey({ origin: 'context', oldLine: 4, newLine: 7 })).toBe('+7')
  })
})

describe('renderDiffRows', () => {
  test('unified renders exactly the rows the list was told to expect', () => {
    const file = fileOf(uneven)
    const html = renderDiffRows(file, { layout: 'unified' })

    expect(countTableRows(html)).toBe(countRows(file).unified)
  })

  test('split renders exactly the rows the list was told to expect', () => {
    const file = fileOf(uneven)
    const html = renderDiffRows(file, { layout: 'split' })

    expect(countTableRows(html)).toBe(countRows(file).split)
  })

  test('the two layouts genuinely differ, which is why both are counted', () => {
    const file = fileOf(uneven)

    expect(countTableRows(renderDiffRows(file, { layout: 'split' })))
      .toBeLessThan(countTableRows(renderDiffRows(file, { layout: 'unified' })))
  })

  test('a change block pads the shorter side rather than stacking the two', () => {
    const html = renderDiffRows(fileOf(uneven), { layout: 'split' })

    // One removal against two additions, so one row carries an empty left cell.
    expect(html).toContain('is-empty')
  })

  test('carries both line numbers in unified, since a thread anchors to a side', () => {
    const html = renderDiffRows(fileOf(uneven), { layout: 'unified' })
    const firstRow = /<tr class="line line-context">(.*?)<\/tr>/.exec(html)![1]!
    const gutters = [...firstRow.matchAll(/data-side="(left|right)"[^>]*>[\s\S]*?>(\d+)</g)]

    expect(gutters.map(match => [match[1], match[2]])).toEqual([['left', '1'], ['right', '1']])
  })

  test('every numbered line is a link to itself', () => {
    // So a reader can copy the link from the context menu without the page
    // running any JavaScript at all.
    const html = renderDiffRows(fileOf(uneven))

    expect(html).toContain('class="line-anchor" href="#a.ts:R:1"')
    expect(html).toContain('aria-label="Line 1"')
  })

  test('a line that exists on one side only is a link on that side only', () => {
    const html = renderDiffRows(fileOf(uneven))
    const addedRow = /<tr class="line line-added">(.*?)<\/tr>/.exec(html)![1]!

    expect((addedRow.match(/line-anchor/g) ?? []).length).toBe(1)
    expect(addedRow).toContain('data-side="right"')
  })

  test('markers say which side a line is on', () => {
    const html = renderDiffRows(fileOf(uneven), { layout: 'unified' })

    expect(html).toContain('>+</span>')
    expect(html).toContain('>-</span>')
  })

  test('content is escaped, so a patch cannot write markup into the page', () => {
    const raw = `diff --git a/x.html b/x.html
--- a/x.html
+++ b/x.html
@@ -1 +1 @@
-<b>old</b>
+<img src=x onerror="alert(1)">
`
    const html = renderDiffRows(fileOf(raw))

    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  test('a path containing a quote cannot break out of an attribute', () => {
    const raw = `diff --git "a/we\\"ird.ts" "b/we\\"ird.ts"
--- a/x
+++ b/x
@@ -1 +1 @@
-a
+b
`
    const html = renderDiffFile(fileOf(raw))

    expect(html).not.toMatch(/id="file-[^"]*"[^>]*"/)
    expect(html).toContain('&quot;')
  })

  test('tokens are used when given and the raw line when not', () => {
    const file = fileOf(uneven)
    const tokens = { '+1': [{ type: 'keyword', content: 'const a = 1' }] }
    const html = renderDiffRows(file, { tokens })

    expect(html).toContain('<span class="t-keyword">const a = 1</span>')
    // A line with no entry still renders, rather than rendering blank.
    expect(html).toContain('const d = 5')
  })

  test('whitespace in the source survives exactly', () => {
    const raw = `diff --git a/w.ts b/w.ts
--- a/w.ts
+++ b/w.ts
@@ -1,2 +1,2 @@
-\tif (a) {
+  if (a) {
 }
`
    // Asserted on the text rather than on one span: intra-line marking splits a
    // line wherever the change starts and stops, so the indentation here is its
    // own span. What must hold is that the characters are all still there and
    // still in order.
    const codeCells = [...renderDiffRows(fileOf(raw)).matchAll(/<td class="code mono">(.*?)<\/td>/g)]
      .map(match => match[1]!.replace(/<[^>]+>/g, ''))

    expect(codeCells[0]).toBe('-\tif (a) {')
    expect(codeCells[1]).toBe('+  if (a) {')
  })

  test('a binary file renders no rows at all', () => {
    const raw = `diff --git a/i.png b/i.png
Binary files a/i.png and b/i.png differ
`
    expect(renderDiffRows(fileOf(raw))).toBe('')
  })

  test('threads are placed under the line they were written about', () => {
    const html = renderDiffRows(fileOf(uneven), {
      threadsAt: line => (line.newLine === 3 ? '<div class="thread">a comment</div>' : ''),
    })

    const threadIndex = html.indexOf('thread-row')
    const lineIndex = html.indexOf('const b = 3')

    expect(threadIndex).toBeGreaterThan(lineIndex)
  })

  test('a file with no threads emits no thread rows', () => {
    expect(renderDiffRows(fileOf(uneven), { threadsAt: () => '' })).not.toContain('thread-row')
  })
})

describe('renderDiffNote', () => {
  test('a binary file says so rather than showing an empty panel', () => {
    const raw = `diff --git a/i.png b/i.png
Binary files a/i.png and b/i.png differ
`
    expect(renderDiffNote(fileOf(raw))).toContain('Binary file')
  })

  test('a mode change names both modes', () => {
    const raw = `diff --git a/s.sh b/s.sh
old mode 100644
new mode 100755
`
    const note = renderDiffNote(fileOf(raw))

    expect(note).toContain('100644')
    expect(note).toContain('100755')
  })

  test('a pure rename says what moved', () => {
    const raw = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`
    expect(renderDiffNote(fileOf(raw))).toContain('Renamed from old.ts')
  })

  test('a file with hunks has no note', () => {
    expect(renderDiffNote(fileOf(uneven))).toBe('')
  })
})

describe('renderDiffFile', () => {
  test('carries the header a reader needs before opening anything', () => {
    const html = renderDiffFile(fileOf(uneven))

    expect(html).toContain('a.ts')
    expect(html).toContain('+2')
    expect(html).toContain('-1')
    expect(html).toContain('pill-modified')
  })

  test('shows both paths for a rename', () => {
    const raw = `diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
`
    const html = renderDiffFile(fileOf(raw))

    expect(html).toContain('old.ts')
    expect(html).toContain('new.ts')
  })

  test('a file with nothing to show renders its note instead of an empty table', () => {
    const raw = `diff --git a/i.png b/i.png
Binary files a/i.png and b/i.png differ
`
    const html = renderDiffFile(fileOf(raw))

    expect(html).not.toContain('<table')
    expect(html).toContain('Binary file')
  })
})

describe('highlightDiffFile', () => {
  test('keys tokens by side, and the tokens reproduce their line', async () => {
    const file = fileOf(uneven)
    const tokens = await highlightDiffFile(file)

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const rendered = tokens[tokenKey(line)]
        if (!rendered || rendered.length === 0)
          continue

        // The property the whole diff rests on: the tokens are the line. A
        // highlighter that drops a space is showing code that is not in the
        // file, and in a diff the whitespace is often the entire change.
        expect(rendered.map(token => token.content).join('')).toBe(line.content)
      }
    }
  })

  /**
   * The benchmark harness's stubbed mode. The point of it is that the *markup*
   * differs in exactly one way - no classes on the spans - so a layout or paint
   * measurement taken in it is comparable to one taken with highlighting on.
   * A stub that dropped a line, merged two, or changed the row count would make
   * the two modes measure different pages.
   */
  test('stubbed out, every line is one plain token and still exactly the line', async () => {
    const file = fileOf(uneven)
    const coloured = await highlightDiffFile(file)
    const plain = await highlightDiffFile(file, { highlight: false })

    expect(Object.keys(plain).sort()).toEqual(Object.keys(coloured).sort())

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const rendered = plain[tokenKey(line)]!

        expect(rendered).toEqual([{ type: 'text', content: line.content }])
        expect(rendered.map(token => token.content).join('')).toBe(line.content)
      }
    }
  })

  test('stubbing is off unless asked for, so nobody gets an uncoloured diff by default', async () => {
    const file = fileOf(uneven)

    expect(await highlightDiffFile(file, {})).toEqual(await highlightDiffFile(file))
  })

  test('highlights each side as its own document', async () => {
    const raw = `diff --git a/old.py b/new.ts
rename from old.py
rename to new.ts
--- a/old.py
+++ b/new.ts
@@ -1 +1 @@
-def f(): pass
+function f() {}
`
    const tokens = await highlightDiffFile(fileOf(raw))

    // The removal came from a .py file and the addition from a .ts one, so the
    // two are tokenized against different languages rather than as one stream.
    expect(tokens['-1']).toBeDefined()
    expect(tokens['+1']).toBeDefined()
  })

  test('a file with no hunks asks the highlighter for nothing', async () => {
    const raw = `diff --git a/i.png b/i.png
Binary files a/i.png and b/i.png differ
`
    expect(await highlightDiffFile(fileOf(raw))).toEqual({})
  })
})

describe('intra-line marking', () => {
  const oneWord = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-const total = subtotal + tax
+const total = subtotal + vat
`

  /** The text of each code cell, with the markup taken back off. */
  function codeText(html: string): string[] {
    return [...html.matchAll(/<td class="code mono[^"]*">(.*?)<\/td>/g)]
      .map(match => match[1]!.replace(/<[^>]+>/g, ''))
  }

  test('marks the word that changed and nothing else', () => {
    const html = renderDiffRows(fileOf(oneWord))
    const marks = [...html.matchAll(/<span class="[^"]*\bw\b[^"]*">([^<]*)<\/span>/g)].map(m => m[1])

    expect(marks).toEqual(['tax', 'vat'])
  })

  test('the line still reads exactly as it does in the file', () => {
    // The invariant marking could break: cutting a token in two must not lose,
    // duplicate or reorder a character.
    expect(codeText(renderDiffRows(fileOf(oneWord)))).toEqual([
      '-const total = subtotal + tax',
      '+const total = subtotal + vat',
    ])
  })

  test('marking survives syntax tokens carving the line differently', () => {
    const tokens = {
      '-1': [{ type: 'keyword', content: 'const total = subtotal + t' }, { type: 'text', content: 'ax' }],
    }
    const html = renderDiffRows(fileOf(oneWord), { tokens })

    // The mark starts inside the first token and ends inside the second, so
    // both have to be cut. Neither carving may win outright.
    expect(codeText(html)[0]).toBe('-const total = subtotal + tax')
    expect(html).toContain('t-keyword w')
  })

  test('can be turned off', () => {
    expect(renderDiffRows(fileOf(oneWord), { inlineChanges: false })).not.toContain(' w"')
  })

  test('two unrelated adjacent lines are not marked', () => {
    const unrelated = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-import { readFile } from 'node:fs'
+export const RETRY_LIMIT = 5
`
    expect(renderDiffRows(fileOf(unrelated))).not.toContain(' w"')
  })

  test('a pure addition marks nothing, since nothing was replaced', () => {
    const added = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
 keep
+brand new
`
    expect(renderDiffRows(fileOf(added))).not.toContain(' w"')
  })

  test('split renders the same marks as unified', () => {
    const unified = renderDiffRows(fileOf(oneWord), { layout: 'unified' })
    const split = renderDiffRows(fileOf(oneWord), { layout: 'split' })
    const marksOf = (html: string) =>
      [...html.matchAll(/<span class="[^"]*\bw\b[^"]*">([^<]*)<\/span>/g)].map(m => m[1])

    expect(marksOf(split)).toEqual(marksOf(unified))
  })
})

describe('expansion controls', () => {
  const twoHunks = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,2 +10,2 @@
-old
+new
@@ -40,2 +40,2 @@
-gone
+here
`

  test('offers to show the lines above a hunk when there are some', () => {
    const html = renderDiffRows(fileOf(twoHunks), { expandable: true })

    expect(html).toContain('data-expand-from="1"')
    expect(html).toContain('data-expand-to="9"')
  })

  test('carries the drift between the two sides, so expanded lines number correctly', () => {
    const html = renderDiffRows(fileOf(twoHunks), { expandable: true })

    expect(html).toContain('data-expand-offset="0"')
  })

  test('says how many lines are hidden rather than just offering a control', () => {
    expect(renderDiffRows(fileOf(twoHunks), { expandable: true })).toContain('9 lines')
  })

  test('a hunk with nothing above it offers nothing', () => {
    const atTop = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-a
+b
`
    expect(renderDiffRows(fileOf(atTop), { expandable: true })).not.toContain('hunk-expand')
  })

  test('off by default, so a row rendered as expanded context offers no expansion of its own', () => {
    expect(renderDiffRows(fileOf(twoHunks))).not.toContain('hunk-expand')
  })

  test('split offers it too', () => {
    const html = renderDiffRows(fileOf(twoHunks), { expandable: true, layout: 'split' })

    expect(html).toContain('hunk-expand')
  })

  test('the control is reachable without a mouse and says what it does', () => {
    const html = renderDiffRows(fileOf(twoHunks), { expandable: true })

    expect(html).toContain('<button type="button" class="hunk-expand"')
    expect(html).toContain('Show the 9 lines above this hunk')
  })
})

/**
 * The header, which both machines render.
 *
 * The server renders it for a file it has parsed; the browser renders it for a
 * file it has only a manifest record for. One function, so a collapsed file and
 * an open one are the same product.
 */
describe('renderDiffShell', () => {
  const entry = { path: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 }

  test('is a header and an empty body', () => {
    const html = renderDiffShell(entry, { collapsed: true })

    expect(html).toContain('src/app.ts')
    expect(html).toContain('+3')
    expect(html).toContain('-1')
    expect(html).not.toContain('<table')
  })

  test('says it is closed, so the control points the right way', () => {
    expect(renderDiffShell(entry, { collapsed: true })).toContain('aria-expanded="false"')
    expect(renderDiffShell(entry)).toContain('aria-expanded="true"')
  })

  test('a file still on its way is marked as such rather than looking collapsed', () => {
    expect(renderDiffShell(entry, { pending: true })).toContain('is-pending')
  })

  test('a rename shows what it used to be called', () => {
    const html = renderDiffShell({ ...entry, previousPath: 'src/old.ts', status: 'renamed' })

    expect(html).toContain('src/old.ts')
    expect(html).toContain('src/app.ts')
  })

  test('a path that is also markup is escaped', () => {
    const html = renderDiffShell({ ...entry, path: 'a<script>.ts' })

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

/**
 * Two ways to fold a file, one per page.
 *
 * The streamed viewer fetches the rows when a reader opens a folded file, so
 * sending them would be sending markup nobody has looked at. The conversation
 * page runs no client script at all, so a header on its own there is a file
 * that can never be read - which is what it was, until this.
 */
describe('folding a file', () => {
  const file = fileOf(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-const a = 1
+const a = 2
`)

  test('fetch renders the header and nothing else', () => {
    const html = renderDiffFile(file, { collapsed: 'fetch' })

    expect(html).toContain('a.ts')
    expect(html).not.toContain('<table')
  })

  test('true still means fetch, which is what it always meant', () => {
    expect(renderDiffFile(file, { collapsed: true })).toBe(renderDiffFile(file, { collapsed: 'fetch' }))
  })

  test('fold keeps the rows, closed, in something that opens without script', () => {
    const html = renderDiffFile(file, { collapsed: 'fold' })

    expect(html).toContain('<details class="diff-file panel"')
    expect(html).toContain('<summary')
    expect(html).toContain('<table')
    expect(html).not.toContain('open>')
  })

  test('a folded summary carries the path and the counts, and no second control', () => {
    const html = renderDiffFile(file, { collapsed: 'fold' })

    expect(html).toContain('a.ts')
    expect(html).toContain('+1')
    expect(html).not.toContain('diff-toggle')
  })

  test('an unfolded file is a section, as it was', () => {
    const html = renderDiffFile(file)

    expect(html).toContain('<section class="diff-file panel"')
    expect(html).toContain('<table')
  })
})
