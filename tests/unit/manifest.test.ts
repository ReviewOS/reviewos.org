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
  test('rows follow their file record, in order', async () => {
    const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified' } })

    expect(records.map(record => record.t)).toEqual(['file', 'rows', 'file', 'rows', 'end'])
    expect(records[1]).toMatchObject({ t: 'rows', i: 0, layout: 'unified' })
    expect(records[3]).toMatchObject({ t: 'rows', i: 1, layout: 'unified' })
  })

  test('the markup is the file, ready to mount', async () => {
    const [, rows] = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified' } })

    expect((rows as { html: string }).html).toContain('one.ts')
    expect((rows as { html: string }).html).toContain('<table')
  })

  test('split rows are asked for and delivered as split', async () => {
    const [, rows] = await collect(fakeSource(TWO_FILES), { rows: { layout: 'split' } })

    expect(rows).toMatchObject({ layout: 'split' })
  })

  test('no rows at all unless they are asked for', async () => {
    const records = await collect(fakeSource(TWO_FILES))

    expect(records.some(record => record.t === 'rows')).toBe(false)
  })

  test('rows stop at the budget and say where they stopped', async () => {
    const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified', budgetBytes: 1 } })

    expect(records.map(record => record.t)).toEqual(['file', 'rows-truncated', 'file', 'end'])
    expect(records[1]).toEqual({ t: 'rows-truncated', from: 0 })
  })

  test('past the budget the file records keep flowing, so the scrollbar stays right', async () => {
    const records = await collect(fakeSource(TWO_FILES), { rows: { layout: 'unified', budgetBytes: 1 } })

    expect(records.filter(record => record.t === 'file')).toHaveLength(2)
    expect(records[records.length - 1]).toMatchObject({ t: 'end', files: 2 })
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
