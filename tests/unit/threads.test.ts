// Where a review thread goes, and what it looks like when it gets there.
//
// The placement rule is the part that matters: a thread on the right matches
// the new line number and one on the left matches the old, and matching both at
// once prints a comment about a deleted line under the line that replaced it,
// which makes it say the opposite of what its author meant.

import { describe, expect, test } from 'bun:test'
import { parseDiff } from '../../app/Actions/Pull/diff'
import { anchorThreads, anchorThreadsToFile, type StoredThread } from '../../app/Actions/Pull/loadThreads'
import { renderDiffRows } from '../../app/Actions/Pull/rows'
import {
  renderThread,
  renderThreads,
  type ReviewThreadView,
  threadSlotFor,
  threadsForLine,
} from '../../app/Actions/Pull/threads'

const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
`

function thread(overrides: Partial<ReviewThreadView> = {}): ReviewThreadView {
  return {
    id: 1,
    path: 'a.ts',
    line: 2,
    side: 'right',
    resolved: false,
    outdated: false,
    comments: [{ id: 1, authorHandle: 'anna', bodyHtml: '<p>Why?</p>', createdAt: '2026-08-05' }],
    ...overrides,
  }
}

function stored(overrides: Partial<StoredThread> = {}): StoredThread {
  return {
    id: 1,
    path: 'a.ts',
    line: 2,
    originalLine: 2,
    side: 'right',
    resolved: false,
    comments: [{ id: 1, authorHandle: 'anna', bodyHtml: '<p>Why?</p>', createdAt: '2026-08-05' }],
    ...overrides,
  }
}

describe('threadsForLine', () => {
  test('a right-side thread matches the new line number', () => {
    const threads = [thread({ side: 'right', line: 2 })]

    expect(threadsForLine(threads, 'a.ts', { oldLine: 9, newLine: 2 })).toHaveLength(1)
    expect(threadsForLine(threads, 'a.ts', { oldLine: 2, newLine: 9 })).toHaveLength(0)
  })

  test('a left-side thread matches the old line number', () => {
    const threads = [thread({ side: 'left', line: 2 })]

    expect(threadsForLine(threads, 'a.ts', { oldLine: 2, newLine: 9 })).toHaveLength(1)
    expect(threadsForLine(threads, 'a.ts', { oldLine: 9, newLine: 2 })).toHaveLength(0)
  })

  test('a thread on another file never appears on this one', () => {
    expect(threadsForLine([thread({ path: 'b.ts' })], 'a.ts', { oldLine: 2, newLine: 2 })).toHaveLength(0)
  })

  test('a thread with nowhere to go is placed nowhere rather than everywhere', () => {
    expect(threadsForLine([thread({ line: null })], 'a.ts', { oldLine: 2, newLine: 2 })).toHaveLength(0)
  })
})

describe('renderThread', () => {
  test('carries the conversation and where it is anchored', () => {
    const html = renderThread(thread())

    expect(html).toContain('anna')
    expect(html).toContain('<p>Why?</p>')
    expect(html).toContain('a.ts:2')
  })

  test('an outdated thread says so rather than being dropped', () => {
    const html = renderThread(thread({ outdated: true }))

    expect(html).toContain('Outdated')
  })

  test('a resolved thread is marked and offers to be unresolved', () => {
    const html = renderThread(thread({ resolved: true }))

    expect(html).toContain('is-resolved')
    expect(html).toContain('Resolved')
    expect(html).toContain('>Unresolve<')
  })

  test('an unresolved thread offers to be resolved', () => {
    expect(renderThread(thread())).toContain('>Resolve<')
  })

  test('the reply form works without any JavaScript', () => {
    const html = renderThread(thread())

    expect(html).toContain('method="post"')
    expect(html).toContain('action="/api/repos/pulls/comments"')
    expect(html).toContain('formaction="/api/repos/pulls/threads"')
  })

  test('a hostile author handle cannot write markup into the page', () => {
    const html = renderThread(thread({
      comments: [{ id: 1, authorHandle: '<img src=x onerror=alert(1)>', bodyHtml: '<p>hi</p>', createdAt: '' }],
    }))

    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  test('the body is not escaped, because it is already rendered markdown', () => {
    expect(renderThread(thread())).toContain('<p>Why?</p>')
  })

  test('several threads on one line render in order', () => {
    const html = renderThreads([thread({ id: 1 }), thread({ id: 2 })])

    expect(html.indexOf('reply-1')).toBeLessThan(html.indexOf('reply-2'))
  })
})

describe('threadSlotFor', () => {
  test('places a thread under the line it is about', () => {
    const html = renderDiffRows(parseDiff(diff)[0]!, {
      threadsAt: threadSlotFor([thread({ side: 'right', line: 2 })], 'a.ts'),
    })

    const threadIndex = html.indexOf('thread-row')
    const lineIndex = html.indexOf('const b = 3')

    expect(threadIndex).toBeGreaterThan(lineIndex)
  })

  test('a file with no threads costs nothing and renders no rows', () => {
    const html = renderDiffRows(parseDiff(diff)[0]!, {
      threadsAt: threadSlotFor([thread({ path: 'elsewhere.ts' })], 'a.ts'),
    })

    expect(html).not.toContain('thread-row')
  })

  test('the split layout places it too', () => {
    const html = renderDiffRows(parseDiff(diff)[0]!, {
      layout: 'split',
      threadsAt: threadSlotFor([thread({ side: 'right', line: 2 })], 'a.ts'),
    })

    expect(html).toContain('thread-row')
  })
})

describe('anchorThreads', () => {
  const files = parseDiff(diff)

  test('a thread on an untouched line keeps its place', () => {
    const [placed] = anchorThreads([stored({ line: 1, side: 'right' })], files)

    expect(placed).toMatchObject({ outdated: false, path: 'a.ts' })
  })

  test('a thread on a line that is gone becomes outdated rather than disappearing', () => {
    // Line 2 on the left was `const b = 2`, which this diff removes.
    const [placed] = anchorThreads([stored({ line: 2, side: 'left', originalLine: 2 })], files)

    expect(placed!.outdated).toBe(true)
    expect(placed!.line).toBe(2)
  })

  test('a file this diff does not touch leaves its threads where they were', () => {
    const [placed] = anchorThreads([stored({ path: 'untouched.ts', line: 7 })], files)

    expect(placed).toMatchObject({ path: 'untouched.ts', line: 7, outdated: false })
  })

  test('a rename carries the thread to the new path', () => {
    const renamed = parseDiff(`diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
`)
    const [placed] = anchorThreads([stored({ path: 'old.ts', line: 1 })], renamed)

    expect(placed!.path).toBe('new.ts')
  })
})

describe('anchorThreadsToFile', () => {
  const [file] = parseDiff(diff)

  test('anchors only the threads that belong to the file', () => {
    const threads = [stored({ id: 1, path: 'a.ts' }), stored({ id: 2, path: 'b.ts' })]

    expect(anchorThreadsToFile(threads, file!).map(t => t.id)).toEqual([1])
  })

  test('gives the same answer as anchoring against the whole diff', () => {
    const threads = [stored({ line: 2, side: 'left', originalLine: 2 })]

    expect(anchorThreadsToFile(threads, file!)).toEqual(anchorThreads(threads, [file!]))
  })

  test('a file with no threads does no work', () => {
    expect(anchorThreadsToFile([stored({ path: 'b.ts' })], file!)).toEqual([])
  })

  test('follows a rename by the path the thread was written against', () => {
    const [renamed] = parseDiff(`diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
`)

    expect(anchorThreadsToFile([stored({ path: 'old.ts', line: 1 })], renamed!)).toHaveLength(1)
  })
})
