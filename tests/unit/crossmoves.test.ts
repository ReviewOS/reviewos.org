// Cross-file moves, tested the way classify.test.ts tests: mostly by what
// the detector refuses to call a move, because a false "this just moved"
// hides a real change inside a diff somebody was told is safe to skim.

import { describe, expect, test } from 'bun:test'
import { parseDiff } from '../../app/Actions/Pull/diff'
import { CROSS_FILE_RUN_MINIMUM, crossFileMoves, moveNotes } from '../../app/Actions/Pull/crossmoves'
import { renderDiffFile } from '../../app/Actions/Pull/rows'

const BLOCK = ['function carried() {', '  const a = 1', '  const b = 2', '  return a + b', '}']

/** A diff where BLOCK leaves a.ts and arrives, byte for byte, in b.ts. */
function movedAcross(extraArrival = false): string {
  const removed = BLOCK.map(line => `-${line}`).join('\n')
  const added = BLOCK.map(line => `+${line}`).join('\n')

  return `diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -1,${BLOCK.length + 1} +1,1 @@
${removed}
 const stays = true
diff --git a/b.ts b/b.ts
index 0000000..1111111 100644
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,${BLOCK.length + 1} @@
 const existing = true
${added}
${extraArrival
  ? `diff --git a/c.ts b/c.ts
index 0000000..1111111 100644
--- a/c.ts
+++ b/c.ts
@@ -1,1 +1,${BLOCK.length + 1} @@
 const other = true
${added}
`
  : ''}`
}

describe('crossFileMoves', () => {
  test('a block leaving one file and arriving in another is a move, named both ways', () => {
    const files = parseDiff(movedAcross())
    const moves = crossFileMoves(files)

    expect(moves.length).toBe(1)
    expect(moves[0]!.from.path).toBe('a.ts')
    expect(moves[0]!.to.path).toBe('b.ts')
    expect(moves[0]!.lines).toBe(BLOCK.length)

    const notes = moveNotes(moves)
    expect(notes.get(0)?.get(0)).toBe('moved to b.ts')
    expect(notes.get(1)?.get(0)).toBe('moved from a.ts')
  })

  test('a block that arrived twice claims nothing - that is a copy, not a move', () => {
    const files = parseDiff(movedAcross(true))

    expect(crossFileMoves(files)).toEqual([])
  })

  test('below the cross-file minimum is a coincidence, not a move', () => {
    const short = BLOCK.slice(0, CROSS_FILE_RUN_MINIMUM - 1)
    const removed = short.map(line => `-${line}`).join('\n')
    const added = short.map(line => `+${line}`).join('\n')

    const files = parseDiff(`diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -1,${short.length + 1} +1,1 @@
${removed}
 const stays = true
diff --git a/b.ts b/b.ts
index 0000000..1111111 100644
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,${short.length + 1} @@
 const existing = true
${added}
`)

    expect(crossFileMoves(files)).toEqual([])
  })

  test('a move within one file is movedRuns’ subject, not this one’s', () => {
    const removed = BLOCK.map(line => `-${line}`).join('\n')
    const added = BLOCK.map(line => `+${line}`).join('\n')

    const files = parseDiff(`diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -1,${BLOCK.length + 1} +1,1 @@
${removed}
 const stays = true
@@ -20,1 +20,${BLOCK.length + 1} @@
 const anchor = true
${added}
`)

    expect(crossFileMoves(files)).toEqual([])
  })

  test('the load-bearing refusal: one edited line breaks the move', () => {
    const removed = BLOCK.map(line => `-${line}`).join('\n')
    const edited = [...BLOCK.slice(0, -2), '  return a - b', '}']
    const added = edited.map(line => `+${line}`).join('\n')

    const files = parseDiff(`diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -1,${BLOCK.length + 1} +1,1 @@
${removed}
 const stays = true
diff --git a/b.ts b/b.ts
index 0000000..1111111 100644
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,${edited.length + 1} @@
 const existing = true
${added}
`)

    expect(crossFileMoves(files)).toEqual([])
  })

  test('the note lands on the separator the reader’s eye stops at', () => {
    const files = parseDiff(movedAcross())
    const notes = moveNotes(crossFileMoves(files))

    const html = renderDiffFile(files[0]!, { hunkNotes: notes.get(0) })
    expect(html).toContain('moved to b.ts')

    const arrival = renderDiffFile(files[1]!, { hunkNotes: notes.get(1) })
    expect(arrival).toContain('moved from a.ts')
  })
})
