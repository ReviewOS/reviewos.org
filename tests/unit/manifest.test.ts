// The manifest: one record per file, emitted as the patch is parsed.
//
// Tested against a fake stream rather than a repository, because what matters
// here is the record shape, the collapse policy, and the promise that there is
// always exactly one terminal record. The git side is covered in
// diff-stream.test.ts.

import { describe, expect, test } from 'bun:test'
import { parseDiff } from '../../app/Actions/Pull/diff'
import {
  COLLAPSE_ABOVE_CHANGED_LINES,
  type ManifestRecord,
  manifestFile,
  manifestToNdjson,
  streamManifest,
} from '../../app/Actions/Pull/manifest'
import { renderDiffFile } from '../../app/Actions/Pull/rows'

const TWO_FILES = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1,2 +1,2 @@
-const a = 1
+const a = 2
 const b = 3
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-old
+new
`

/** A stream that hands the text over in fixed-size pieces. */
function fakeSource(text: string, chunkSize = 16, ok = true, stderr = '') {
  return {
    chunks: {
      async* [Symbol.asyncIterator]() {
        for (let index = 0; index < text.length; index += chunkSize)
          yield text.slice(index, index + chunkSize)
      },
    },
    done: Promise.resolve({ ok, code: ok ? 0 : 128, stderr }),
  }
}

async function collect(
  source: Parameters<typeof streamManifest>[0],
  options?: Parameters<typeof streamManifest>[1],
): Promise<ManifestRecord[]> {
  const records: ManifestRecord[] = []
  for await (const record of streamManifest(source, options))
    records.push(record)
  return records
}

/** A diff with `count` changed lines in one file. */
function bigDiff(count: number): string {
  const added = Array.from({ length: count }, (_, index) => `+line ${index}`).join('\n')
  return `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,${count} @@\n${added}\n`
}

describe('manifestFile', () => {
  const [one] = parseDiff(TWO_FILES)

  test('carries what the list needs to lay a file out', () => {
    expect(manifestFile(one!, 0)).toMatchObject({
      t: 'file',
      i: 0,
      path: 'one.ts',
      from: null,
      status: 'modified',
      binary: false,
      additions: 1,
      deletions: 1,
      hunks: 1,
      collapsed: false,
    })
  })

  test('carries row counts for both layouts, so switching costs no round trip', () => {
    const { rows } = manifestFile(one!, 0)

    expect(rows.unified).toBeGreaterThan(0)
    expect(rows.split).toBeGreaterThan(0)
    expect(rows.split).toBeLessThanOrEqual(rows.unified)
  })

  test('a lockfile arrives collapsed', () => {
    const lock = parseDiff(`diff --git a/bun.lock b/bun.lock
--- a/bun.lock
+++ b/bun.lock
@@ -1 +1 @@
-a
+b
`)[0]!

    expect(manifestFile(lock, 0).collapsed).toBe(true)
  })

  test('a very large file arrives collapsed, and one line under the line does not', () => {
    const over = parseDiff(bigDiff(COLLAPSE_ABOVE_CHANGED_LINES + 1))[0]!
    const under = parseDiff(bigDiff(COLLAPSE_ABOVE_CHANGED_LINES))[0]!

    expect(manifestFile(over, 0).collapsed).toBe(true)
    expect(manifestFile(under, 0).collapsed).toBe(false)
  })

  test('a rename keeps both paths, so the reader can see what moved', () => {
    const renamed = parseDiff(`diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`)[0]!

    expect(manifestFile(renamed, 0)).toMatchObject({ path: 'new.ts', from: 'old.ts', status: 'renamed' })
  })

  /**
   * The contract between the classifier and the browser. The record carries the
   * reason, not just the fold, because a file folded with no reason asks the
   * reviewer to trust a judgement nobody stated - and the sidebar counts these
   * so the number is said out loud rather than silently subtracted.
   */
  test('a file that is only formatting folds, and says why', () => {
    const formatting = parseDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-  const a = 1
-  const b = 2
+    const a = 1
+    const b = 2
`)[0]!

    expect(manifestFile(formatting, 0)).toMatchObject({ collapsed: true, mechanical: 'formatting' })
  })

  test('a file whose every line is one renamed symbol folds, and says why', () => {
    const renamed = parseDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
-oldThing.a()
-oldThing.b()
-oldThing.c()
+newThing.a()
+newThing.b()
+newThing.c()
`)[0]!

    expect(manifestFile(renamed, 0)).toMatchObject({ collapsed: true, mechanical: 'renamed-symbol' })
  })

  /**
   * The one that has to stay open. Two mechanical hunks and one real edit is
   * not a mechanical file, and folding it would hide the only line anybody
   * needed to read behind a badge saying it was safe to skip.
   */
  test('a file that is only partly mechanical stays open and claims nothing', () => {
    const mixed = parseDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-  const a = 1
+    const a = 1
@@ -10,1 +10,1 @@
-const limit = 1
+const limit = 2
`)[0]!

    const record = manifestFile(mixed, 0)

    expect(record.collapsed).toBe(false)
    expect(record.mechanical).toBeUndefined()
  })
})

describe('streamManifest', () => {
  test('emits one record per file, in diff order, then an end', async () => {
    const records = await collect(fakeSource(TWO_FILES))

    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({ t: 'file', i: 0, path: 'one.ts' })
    expect(records[1]).toMatchObject({ t: 'file', i: 1, path: 'two.ts' })
    expect(records[2]).toMatchObject({ t: 'end', files: 2 })
  })

  test('totals the counts across files', async () => {
    const [end] = (await collect(fakeSource(TWO_FILES))).filter(record => record.t === 'end')

    expect(end).toMatchObject({ additions: 2, deletions: 2 })
  })

  test('chunk size does not change the result, at any size', async () => {
    const reference = await collect(fakeSource(TWO_FILES, 4096))

    for (const chunkSize of [1, 2, 7, 13, 64])
      expect(await collect(fakeSource(TWO_FILES, chunkSize))).toEqual(reference)
  })

  test('an empty diff still ends, so nothing-changed is distinguishable from broken', async () => {
    const records = await collect(fakeSource(''))

    expect(records).toEqual([{ t: 'end', files: 0, additions: 0, deletions: 0 }])
  })

  test('git failing becomes an error record rather than a silent short read', async () => {
    const records = await collect(fakeSource('', 16, false, 'fatal: bad revision\n'))

    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({ t: 'error', message: 'fatal: bad revision' })
  })

  test('git dying partway keeps the files already parsed and says it failed', async () => {
    const records = await collect(fakeSource(TWO_FILES, 16, false, 'fatal: object missing\n'))

    expect(records.filter(record => record.t === 'file')).toHaveLength(2)
    expect(records[records.length - 1]).toMatchObject({ t: 'error' })
  })

  test('a failure with nothing on stderr still says something useful', async () => {
    const [record] = await collect(fakeSource('', 16, false, ''))

    expect(record).toEqual({ t: 'error', message: 'git exited with code 128.' })
  })
})

describe('manifestToNdjson', () => {
  test('one record per line, each parseable on its own', async () => {
    let text = ''
    for await (const line of manifestToNdjson(streamManifest(fakeSource(TWO_FILES))))
      text += line

    const lines = text.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)

    for (const line of lines)
      expect(() => JSON.parse(line)).not.toThrow()

    expect(JSON.parse(lines[0]!).path).toBe('one.ts')
  })

  test('a path containing a newline does not break the framing', async () => {
    // Legal on every filesystem this runs on, and it is why the framing is
    // JSON per line rather than the path per line.
    const raw = 'diff --git "a/we\\nird.ts" "b/we\\nird.ts"\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'

    let text = ''
    for await (const line of manifestToNdjson(streamManifest(fakeSource(raw))))
      text += line

    expect(text.split('\n').filter(Boolean)).toHaveLength(2)
  })
})

describe('inline rows', () => {
  /**
   * Rows come out in file order, and they come out *after* the records - both
   * of which are properties rather than an interleaving to assert literally.
   *
   * The exact interleaving used to be `file, rows, file, rows`, because each
   * file was highlighted before the next was parsed. It is now several records
   * and then their rows, because the highlighting of a few files runs at once
   * while the records stream ahead of it. That is the point of the look-ahead,
   * and pinning the old sequence would have been pinning the serial pipeline.
   */
  test('every file gets a record, and every one of them gets its rows', async () => {
    const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified' } })

    expect(records.filter(record => record.t === 'file').map(record => record.i)).toEqual([0, 1])
    expect(records.filter(record => record.t === 'rows').map(record => record.i)).toEqual([0, 1])
    expect(records[records.length - 1]).toMatchObject({ t: 'end' })
  })

  test('a file\'s rows never arrive before its record', async () => {
    const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified' } })
    const seen = new Set<number>()

    for (const record of records) {
      if (record.t === 'file')
        seen.add(record.i)
      else if (record.t === 'rows')
        expect(seen.has(record.i)).toBe(true)
    }
  })

  test('the markup is the file, ready to mount', async () => {
    const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified' } })
    const rows = records.find(record => record.t === 'rows') as { html: string }

    expect(rows.html).toContain('one.ts')
    expect(rows.html).toContain('<table')
  })

  test('split rows are asked for and delivered as split', async () => {
    const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'split' } })

    expect(records.find(record => record.t === 'rows')).toMatchObject({ layout: 'split' })
  })

  test('no rows at all unless they are asked for', async () => {
    const records = await collect(fakeSource(TWO_FILES))

    expect(records.some(record => record.t === 'rows')).toBe(false)
  })

  /**
   * The truncation names the file the budget actually ran out on, and that is
   * why the look-ahead reorders the *tokenizing* and not the emission: the
   * budget is spent in file order, so the boundary is exact even though
   * several files were being highlighted at once when it was reached.
   */
  test('rows stop at the budget and say where they stopped', async () => {
    const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified', budgetBytes: 1 } })

    expect(records.filter(record => record.t === 'rows')).toHaveLength(0)
    expect(records.find(record => record.t === 'rows-truncated')).toEqual({ t: 'rows-truncated', from: 0 })
  })

  test('past the budget the file records keep flowing, so the scrollbar stays right', async () => {
    const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified', budgetBytes: 1 } })

    expect(records.filter(record => record.t === 'file')).toHaveLength(2)
    expect(records[records.length - 1]).toMatchObject({ t: 'end', files: 2 })
  })

  /**
   * A file that arrives folded up costs a header and nothing else.
   *
   * It used to cost everything: the record said collapsed, the rows were
   * rendered anyway, and the client laid out a header's worth of space and
   * mounted eight thousand lines into it. That overlapped every file below and
   * made the scrollbar wrong, and it spent the inline row budget on markup
   * nobody had asked to see.
   */
  test('a collapsed file is sent no rows', async () => {
    const withLock = `${TWO_FILES}diff --git a/bun.lock b/bun.lock\n--- a/bun.lock\n+++ b/bun.lock\n@@ -1 +1 @@\n-a\n+b\n`
    const records = await collect(fakeSource(withLock), { rows: { layout: 'unified', skipCollapsed: true } })

    const lock = records.find(record => record.t === 'file' && record.path === 'bun.lock')
    expect(lock).toMatchObject({ collapsed: true })

    const rowsFor = records.filter(record => record.t === 'rows').map(record => record.i)
    expect(rowsFor).toEqual([0, 1])
  })

  /**
   * The rows endpoint answers a request for named files, and that request is
   * the reader opening the file. Skipping there would leave a collapsed file
   * with no way to ever be read.
   */
  test('asked for by name, a collapsed file still gets its rows', async () => {
    const lock = `diff --git a/bun.lock b/bun.lock\n--- a/bun.lock\n+++ b/bun.lock\n@@ -1 +1 @@\n-a\n+b\n`
    const records = await collect(fakeSource(lock), { rows: { layout: 'unified' } })

    expect(records.some(record => record.t === 'rows')).toBe(true)
  })

  test('and its markup, when it is asked for directly, is the header alone', async () => {
    const [file] = parseDiff(`diff --git a/bun.lock b/bun.lock\n--- a/bun.lock\n+++ b/bun.lock\n@@ -1 +1 @@\n-a\n+b\n`)

    const html = renderDiffFile(file!, { collapsed: true })
    expect(html).toContain('bun.lock')
    expect(html).not.toContain('<table')
  })

  test('truncation is announced once, not per file', async () => {
    const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified', budgetBytes: 1 } })

    expect(records.filter(record => record.t === 'rows-truncated')).toHaveLength(1)
  })
})

describe('notices', () => {
  test('a warning git wrote while succeeding reaches the reader', async () => {
    const stderr = 'warning: exhaustive rename detection was skipped due to too many files.\n'
      + 'warning: you may want to set your diff.renameLimit variable to at least 3399 and retry.\n'
    const records = await collect({
      chunks: fakeSource(TWO_FILES).chunks,
      done: Promise.resolve({ ok: true, code: 0, stderr }),
    })

    const notice = records.find(record => record.t === 'notice')
    expect(notice).toBeDefined()
    // What it means for the diff on screen, not git's advice to whoever runs
    // the server about a configuration variable.
    expect((notice as { message: string }).message).toContain('moved files')
    expect((notice as { message: string }).message).not.toContain('renameLimit')
  })

  test('the notice comes before the end, so a reader has it when the diff settles', async () => {
    const records = await collect({
      chunks: fakeSource(TWO_FILES).chunks,
      done: Promise.resolve({ ok: true, code: 0, stderr: 'warning: exhaustive rename detection was skipped\n' }),
    })

    expect(records[records.length - 2]).toMatchObject({ t: 'notice' })
    expect(records[records.length - 1]).toMatchObject({ t: 'end' })
  })

  test('nothing on stderr means no notice', async () => {
    const records = await collect(fakeSource(TWO_FILES))

    expect(records.some(record => record.t === 'notice')).toBe(false)
  })

  test('chatter git writes that changes nothing is not shown', async () => {
    const records = await collect({
      chunks: fakeSource(TWO_FILES).chunks,
      done: Promise.resolve({ ok: true, code: 0, stderr: 'warning: LF will be replaced by CRLF\n' }),
    })

    expect(records.some(record => record.t === 'notice')).toBe(false)
  })
})

describe('the inline budget', () => {
  test('an operator can move it, so the harness can pin which mode runs', async () => {
    const previous = process.env.DIFF_INLINE_ROWS_BUDGET

    try {
      process.env.DIFF_INLINE_ROWS_BUDGET = '1'
      const pinned = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified' } })
      expect(pinned.some(record => record.t === 'rows-truncated')).toBe(true)

      process.env.DIFF_INLINE_ROWS_BUDGET = String(10 * 1024 * 1024)
      const generous = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified' } })
      expect(generous.some(record => record.t === 'rows-truncated')).toBe(false)
    }
    finally {
      if (previous === undefined)
        delete process.env.DIFF_INLINE_ROWS_BUDGET
      else
        process.env.DIFF_INLINE_ROWS_BUDGET = previous
    }
  })

  test('nonsense in the environment falls back to the default rather than to zero', async () => {
    const previous = process.env.DIFF_INLINE_ROWS_BUDGET

    try {
      process.env.DIFF_INLINE_ROWS_BUDGET = 'not a number'
      const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified' } })

      // A budget read as 0 would truncate every diff, which is the opposite of
      // what an unparseable value should mean.
      expect(records.some(record => record.t === 'rows-truncated')).toBe(false)
    }
    finally {
      if (previous === undefined)
        delete process.env.DIFF_INLINE_ROWS_BUDGET
      else
        process.env.DIFF_INLINE_ROWS_BUDGET = previous
    }
  })

  test('an explicit budget in the options wins over the environment', async () => {
    const records = await collect(fakeSource(TWO_FILES), {
      rows: { layout: 'unified', budgetBytes: Number.POSITIVE_INFINITY },
    })

    expect(records.some(record => record.t === 'rows-truncated')).toBe(false)
  })
})
