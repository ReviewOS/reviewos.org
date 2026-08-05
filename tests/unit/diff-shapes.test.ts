/**
 * The diff shapes that break parsers.
 *
 * Every one of these is legal `git diff` output that a parser written against
 * an ordinary modification gets wrong, and every one of them is silent: the
 * file still renders, it is just wrong about something. They are collected here
 * rather than spread through the other suites so that adding a new one is a
 * matter of adding a case rather than deciding where it belongs.
 */

import { describe, expect, test } from 'bun:test'
import { parseDiff, parseDiffFile } from '../../app/Actions/Pull/diff'
import { createPatchSplitter, splitPatchFiles } from '../../app/Actions/Pull/patch'
import { renderDiffRows } from '../../app/Actions/Pull/rows'

describe('a rename with no content change', () => {
  const raw = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`

  test('keeps both paths and reports no changed lines', () => {
    const [file] = parseDiff(raw)

    expect(file).toMatchObject({
      path: 'new.ts',
      previousPath: 'old.ts',
      status: 'renamed',
      additions: 0,
      deletions: 0,
    })
    expect(file!.hunks).toHaveLength(0)
  })

  test('says so rather than rendering an empty panel', () => {
    const [file] = parseDiff(raw)

    expect(renderDiffRows(file!)).toBe('')
    expect(file!.lineEndings).toBeNull()
  })
})

describe('a mode change with no content change', () => {
  const raw = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`

  test('carries both modes', () => {
    const [file] = parseDiff(raw)

    expect(file).toMatchObject({ oldMode: '100644', newMode: '100755', status: 'modified' })
  })
})

describe('line endings', () => {
  const withEndings = (lines: string[]) =>
    parseDiff(`diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.join('\n')}\n`)[0]!

  test('a CRLF file is reported as CRLF', () => {
    expect(withEndings([' one\r', '-two\r', '+three\r']).lineEndings).toBe('crlf')
  })

  test('an LF file is reported as LF', () => {
    expect(withEndings([' one', '-two', '+three']).lineEndings).toBe('lf')
  })

  /**
   * Usually an accident, and usually the thing the reviewer is trying to work
   * out when half the file shows as changed. Worth reporting as its own answer
   * rather than as whichever ending happened to come first.
   */
  test('a file with both is reported as mixed rather than as one of them', () => {
    expect(withEndings([' one\r', '-two', '+three\r']).lineEndings).toBe('mixed')
  })

  test('a file with no lines in the patch has no answer, which is not the same as LF', () => {
    const [file] = parseDiff('diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n')

    expect(file!.lineEndings).toBeNull()
  })

  test('the carriage return stays in the content, because the line is what it is', () => {
    const file = withEndings([' one\r'])

    expect(file.hunks[0]!.lines[0]!.content).toBe('one\r')
  })
})

describe('a file with no trailing newline', () => {
  const raw = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
\\ No newline at end of file
+one
`

  test('the marker is not counted as a line', () => {
    const [file] = parseDiff(raw)

    expect(file!.hunks[0]!.lines).toHaveLength(2)
    expect(file!.additions).toBe(1)
    expect(file!.deletions).toBe(1)
  })

  test('it marks the line it belongs to, which is the one before it', () => {
    const [file] = parseDiff(raw)
    const [removed, added] = file!.hunks[0]!.lines

    expect(removed!.noNewline).toBe(true)
    expect(added!.noNewline).toBeUndefined()
  })

  /**
   * The whole reason to keep it. Both sides of this diff read `one`; the only
   * difference is the newline, and a viewer that drops the marker shows a
   * change with no visible cause.
   */
  test('and it reaches the markup, so the change is visible', () => {
    const [file] = parseDiff(raw)

    expect(renderDiffRows(file!)).toContain('no-newline')
  })
})

describe('a mailbox-format patch', () => {
  const sha = 'a'.repeat(40)
  const other = 'b'.repeat(40)
  const raw = `From ${sha} Mon Sep 17 00:00:00 2001
From: Someone <someone@example.com>
Subject: [PATCH 1/2] the first change

---
 one.txt | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/one.txt b/one.txt
--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-before
+after
--
2.39.0

From ${other} Mon Sep 17 00:00:00 2001
From: Someone <someone@example.com>
Subject: [PATCH 2/2] the second change

---
 two.txt | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/two.txt b/two.txt
--- a/two.txt
+++ b/two.txt
@@ -1 +1 @@
-before
+after
--
2.39.0
`

  test('splits into two files, not one file and a mess', () => {
    const files = parseDiff(raw)

    expect(files.map(file => file.path)).toEqual(['one.txt', 'two.txt'])
  })

  /**
   * The failure this exists to prevent. The diffstat line ` two.txt | 2 +-`
   * begins with a space, so without a commit boundary it is a context line
   * appended to the previous file - along with the blank lines around it.
   */
  test('the second commit\'s mail headers do not become lines of the first file', () => {
    const [first] = parseDiff(raw)

    expect(first!.additions).toBe(1)
    expect(first!.deletions).toBe(1)
    expect(first!.hunks[0]!.lines).toHaveLength(2)
    expect(first!.hunks[0]!.lines.map(line => line.content)).toEqual(['before', 'after'])
  })

  test('a `From ` that is not a commit header does not split anything', () => {
    const prose = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 From the beginning
-From here
+From there
`
    const files = parseDiff(prose)

    expect(files).toHaveLength(1)
    expect(files[0]!.hunks[0]!.lines).toHaveLength(3)
  })

  test('the same answer whatever size the chunks arrive in', () => {
    const reference = splitPatchFiles(raw)

    for (const size of [1, 3, 17, 46, 47, 512]) {
      const splitter = createPatchSplitter()
      const files: string[] = []

      for (let index = 0; index < raw.length; index += size) {
        splitter.push(raw.slice(index, index + size))
        for (;;) {
          const file = splitter.take()
          if (file === undefined)
            break
          files.push(file)
        }
      }

      files.push(...splitter.finish().files)
      expect(files).toEqual(reference)
    }
  })
})

describe('a filename that fights the parser', () => {
  test('a quoted path with a space', () => {
    const [file] = parseDiff('diff --git "a/my file.ts" "b/my file.ts"\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')

    expect(file!.path).toBe('my file.ts')
  })

  test('a path containing a newline, which git quotes and escapes', () => {
    const [file] = parseDiff('diff --git "a/we\\nird.ts" "b/we\\nird.ts"\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')

    expect(file!.path).toContain('ird.ts')
  })

  test('a path containing a quote does not run past its own header', () => {
    const files = parseDiff('diff --git "a/q\\"uote.ts" "b/q\\"uote.ts"\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')

    expect(files).toHaveLength(1)
    expect(files[0]!.hunks[0]!.lines).toHaveLength(2)
  })
})

describe('a large single-file diff', () => {
  const lines = 5000
  const raw = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,${lines} +1,${lines} @@\n${
    Array.from({ length: lines }, (_, index) => `+line ${index}`).join('\n')}\n`

  test('parses every line and numbers the last one correctly', () => {
    const [file] = parseDiff(raw)

    expect(file!.additions).toBe(lines)
    expect(file!.hunks[0]!.lines).toHaveLength(lines)
    expect(file!.hunks[0]!.lines[lines - 1]!.newLine).toBe(lines)
  })

  test('the per-file parser gives the same answer as the whole-patch one', () => {
    expect(parseDiffFile(raw)).toEqual(parseDiff(raw)[0]!)
  })
})
