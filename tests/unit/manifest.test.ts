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

async function collect(source: Parameters<typeof streamManifest>[0]): Promise<ManifestRecord[]> {
  const records: ManifestRecord[] = []
  for await (const record of streamManifest(source))
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
