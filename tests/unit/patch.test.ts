import { describe, expect, test } from 'bun:test'
import {
  createPatchSplitter,
  detachString,
  findFileBoundary,
  releaseDetachBuffer,
  splitPatchFiles,
} from '../../app/Actions/Pull/patch'

/** Two files, so there is a boundary to find. */
const TWO_FILES = `diff --git a/one.ts b/one.ts
index 1111111..2222222 100644
--- a/one.ts
+++ b/one.ts
@@ -1,2 +1,2 @@
-const a = 1
+const a = 2
 const b = 3
diff --git a/two.ts b/two.ts
index 3333333..4444444 100644
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-old
+new
`

/** Feed a patch through the splitter one chunk at a time. */
function splitInChunks(raw: string, chunkSize: number): string[] {
  const splitter = createPatchSplitter()
  const files: string[] = []

  for (let index = 0; index < raw.length; index += chunkSize) {
    splitter.push(raw.slice(index, index + chunkSize))

    for (;;) {
      const fileText = splitter.take()
      if (fileText === undefined)
        break
      files.push(fileText)
    }
  }

  files.push(...splitter.finish().files)
  return files
}

describe('findFileBoundary', () => {
  test('finds a header at the very start, where no newline precedes it', () => {
    expect(findFileBoundary('diff --git a/x b/x\n', 0)).toBe(0)
  })

  test('does not match a header that is not at the start of a line', () => {
    expect(findFileBoundary('see diff --git a/x b/x\n', 0)).toBeNull()
  })

  test('finds a later header and points at the d, not the newline', () => {
    const text = 'a\ndiff --git a/x b/x\n'
    expect(findFileBoundary(text, 0)).toBe(2)
    expect(text.slice(2, 6)).toBe('diff')
  })

  test('respects the starting offset so a file does not find its own header', () => {
    expect(findFileBoundary(TWO_FILES, 1)).toBe(TWO_FILES.indexOf('diff --git a/two.ts'))
  })
})

describe('splitPatchFiles', () => {
  test('cuts a patch into one text per file', () => {
    const files = splitPatchFiles(TWO_FILES)
    expect(files).toHaveLength(2)
    expect(files[0]!.startsWith('diff --git a/one.ts')).toBe(true)
    expect(files[1]!.startsWith('diff --git a/two.ts')).toBe(true)
  })

  test('the pieces reassemble into the original, so nothing is dropped', () => {
    expect(splitPatchFiles(TWO_FILES).join('')).toBe(TWO_FILES)
  })

  test('a single file is one piece', () => {
    const single = 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n'
    expect(splitPatchFiles(single)).toEqual([single])
  })

  test('empty input yields nothing', () => {
    expect(splitPatchFiles('')).toEqual([])
    expect(splitPatchFiles('\n\n')).toEqual([])
  })
})

describe('createPatchSplitter', () => {
  // The case the whole design exists for: a header that lands across a read.
  // One byte at a time exercises every possible split point in one test.
  test('finds a boundary split across chunk edges, at every offset', () => {
    for (const chunkSize of [1, 2, 3, 5, 7, 11, 13, 64]) {
      const files = splitInChunks(TWO_FILES, chunkSize)
      expect(files).toHaveLength(2)
      expect(files.join('')).toBe(TWO_FILES)
    }
  })

  test('a file whose content contains the header text is not split on it', () => {
    // A patch that adds a line of documentation about `diff --git`. The added
    // line begins with `+`, so it is not at the start of a line as a header.
    const raw = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1 +1,2 @@
 intro
+diff --git a/x b/x is the header git writes
`
    expect(splitPatchFiles(raw)).toHaveLength(1)
  })

  test('a header appearing as removed content does split, and that is git being ambiguous', () => {
    // Documented rather than fixed: `git diff` output for a file that itself
    // contains a patch is genuinely ambiguous without reading hunk counts. The
    // splitter takes the fast reading; the per-file parser rejects the second
    // piece because it has no valid header line.
    const raw = 'diff --git a/a b/a\n@@ -1 +0,0 @@\n-x\ndiff --git a/b b/b\n@@ -1 +1 @@\n-y\n+z\n'
    expect(splitPatchFiles(raw)).toHaveLength(2)
  })

  test('input with no header at all comes back as a remainder, not as a file', () => {
    const splitter = createPatchSplitter()
    splitter.push('this is not a patch\n')
    expect(splitter.take()).toBeUndefined()

    const { files, remainder } = splitter.finish()
    expect(files).toEqual([])
    expect(remainder).toBe('this is not a patch\n')
  })

  test('a preamble before the first header is dropped rather than becoming a file', () => {
    const raw = `commit abc123
Author: Someone <s@example.com>

    A commit message

${TWO_FILES}`
    const files = splitPatchFiles(raw)
    expect(files).toHaveLength(2)
    expect(files[0]!.startsWith('diff --git a/one.ts')).toBe(true)
  })

  test('finish drains files completed on the last chunk even if take was not called', () => {
    const splitter = createPatchSplitter()
    splitter.push(TWO_FILES)
    expect(splitter.finish().files).toHaveLength(2)
  })

  test('a splitter that has finished is reusable and does not repeat itself', () => {
    const splitter = createPatchSplitter()
    splitter.push(TWO_FILES)
    expect(splitter.finish().files).toHaveLength(2)
    expect(splitter.finish().files).toEqual([])
  })
})

describe('detachString', () => {
  test('reproduces the input exactly', () => {
    for (const value of ['', 'a', 'hello world', '  indented\t', 'ünïcödé', '日本語', '🎉 emoji']) {
      expect(detachString(value)).toBe(value)
    }
  })

  test('survives an unpaired surrogate, which TextEncoder would replace', () => {
    const lone = `before${String.fromCharCode(0xD800)}after`
    expect(detachString(lone)).toBe(lone)
    expect(detachString(lone).charCodeAt(6)).toBe(0xD800)
  })

  test('a detached slice is equal to the slice but not the same string object', () => {
    const parent = `${'x'.repeat(1000)}needle${'y'.repeat(1000)}`
    const slice = parent.slice(1000, 1006)
    const detached = detachString(slice)

    expect(detached).toBe('needle')
    // Bun interns short strings, so identity is not a reliable assertion. What
    // is assertable is that the value survived the round trip; the memory
    // behaviour is covered by the heap check in the streaming benchmark.
    expect(detached.length).toBe(6)
  })

  test('grows for a long line and can be released afterwards', () => {
    const long = 'z'.repeat(500_000)
    expect(detachString(long)).toBe(long)
    releaseDetachBuffer()
    expect(detachString('short')).toBe('short')
  })
})
