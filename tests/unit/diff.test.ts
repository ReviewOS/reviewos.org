// The diff parser and the thread anchoring built on it.
//
// These two decide what a reviewer sees and where their comments end up, so
// the cases here are the ones that break review interfaces in practice: a file
// with no trailing newline, a rename, a binary file, a comment near the bottom
// of a file edited at the top, and a line that is genuinely gone.

import { describe, expect, test } from 'bun:test'
import { diffTotals, isGenerated, isWhitespaceOnly, parseDiff } from '../../app/Actions/Pull/diff'
import { approvalsSatisfied, mapLine, reanchor, reviewIsStale } from '../../app/Actions/Pull/anchoring'

const simple = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ function main()
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
`

describe('parseDiff', () => {
  test('reads a file and its hunk', () => {
    const files = parseDiff(simple)

    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe('src/app.ts')
    expect(files[0]!.hunks).toHaveLength(1)
  })

  test('counts additions and deletions', () => {
    const [file] = parseDiff(simple)

    expect(file!.additions).toBe(2)
    expect(file!.deletions).toBe(1)
  })

  test('numbers lines on both sides', () => {
    const [file] = parseDiff(simple)
    const lines = file!.hunks[0]!.lines

    expect(lines[0]).toMatchObject({ origin: 'context', oldLine: 1, newLine: 1 })
    expect(lines[1]).toMatchObject({ origin: 'removed', oldLine: 2, newLine: null })
    expect(lines[2]).toMatchObject({ origin: 'added', oldLine: null, newLine: 2 })
    expect(lines[3]).toMatchObject({ origin: 'added', oldLine: null, newLine: 3 })
  })

  test('keeps the hunk heading, which names the enclosing function', () => {
    expect(parseDiff(simple)[0]!.hunks[0]!.heading).toBe('function main()')
  })

  test('recognises an added file', () => {
    const raw = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
`
    const [file] = parseDiff(raw)

    expect(file!.status).toBe('added')
    expect(file!.additions).toBe(2)
  })

  test('recognises a deleted file', () => {
    const raw = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`
    expect(parseDiff(raw)[0]!.status).toBe('deleted')
  })

  test('recognises a rename and keeps both paths', () => {
    const raw = `diff --git a/old.ts b/new.ts
similarity index 96%
rename from old.ts
rename to new.ts
`
    const [file] = parseDiff(raw)

    expect(file!.status).toBe('renamed')
    expect(file!.previousPath).toBe('old.ts')
    expect(file!.path).toBe('new.ts')
  })

  test('recognises a binary file rather than trying to show it', () => {
    const raw = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`
    expect(parseDiff(raw)[0]!.binary).toBe(true)
  })

  test('records a mode change with no content change', () => {
    const raw = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`
    const [file] = parseDiff(raw)

    expect(file!.oldMode).toBe('100644')
    expect(file!.newMode).toBe('100755')
  })

  test('does not treat a missing final newline as a line', () => {
    const raw = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`
    const [file] = parseDiff(raw)

    expect(file!.additions).toBe(1)
    expect(file!.deletions).toBe(1)
    expect(file!.hunks[0]!.lines).toHaveLength(2)
  })

  test('handles several files in one diff', () => {
    const raw = simple + `diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y
`
    expect(parseDiff(raw)).toHaveLength(2)
  })

  test('handles a single-line hunk header with no count', () => {
    const raw = `diff --git a/a b/a
--- a/a
+++ b/a
@@ -5 +5 @@
-a
+b
`
    const hunk = parseDiff(raw)[0]!.hunks[0]!

    expect(hunk.oldStart).toBe(5)
    expect(hunk.oldLines).toBe(1)
  })

  test('returns nothing for empty input', () => {
    expect(parseDiff('')).toEqual([])
  })
})

describe('diffTotals', () => {
  test('sums across files', () => {
    expect(diffTotals(parseDiff(simple))).toEqual({ additions: 2, deletions: 1, files: 1 })
  })
})

describe('isGenerated', () => {
  test('collapses lockfiles', () => {
    expect(isGenerated('bun.lock')).toBe(true)
    expect(isGenerated('package-lock.json')).toBe(true)
    expect(isGenerated('sub/dir/Cargo.lock')).toBe(true)
  })

  test('collapses build output and vendored code', () => {
    expect(isGenerated('dist/app.js')).toBe(true)
    expect(isGenerated('vendor/lib.rb')).toBe(true)
    expect(isGenerated('app.min.js')).toBe(true)
  })

  test('leaves ordinary source alone', () => {
    expect(isGenerated('src/app.ts')).toBe(false)
    expect(isGenerated('README.md')).toBe(false)
    // A file merely named like a lock is not one.
    expect(isGenerated('src/lockfile-parser.ts')).toBe(false)
  })
})

describe('isWhitespaceOnly', () => {
  test('is true when only indentation changed', () => {
    const raw = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-  const a = 1
+    const a = 1
 const b = 2
`
    expect(isWhitespaceOnly(parseDiff(raw)[0]!.hunks[0]!)).toBe(true)
  })

  test('is false when anything else changed', () => {
    expect(isWhitespaceOnly(parseDiff(simple)[0]!.hunks[0]!)).toBe(false)
  })
})

describe('mapLine', () => {
  const [file] = parseDiff(simple)

  test('a line before the hunk keeps its number', () => {
    expect(mapLine(1, file!)).toBe(1)
  })

  test('a removed line has nowhere to go', () => {
    expect(mapLine(2, file!)).toBeNull()
  })

  test('a line after the hunk shifts by the size change', () => {
    // The hunk adds one line net, so line 5 becomes line 6.
    expect(mapLine(5, file!)).toBe(6)
  })
})

describe('reanchor', () => {
  const files = parseDiff(simple)

  test('a file untouched by the diff keeps its anchor', () => {
    const result = reanchor({ path: 'other.ts', line: 10, side: 'right' }, files)

    expect(result.status).toBe('unchanged')
    expect(result.anchor.line).toBe(10)
  })

  test('a line after an edit moves rather than being lost', () => {
    const result = reanchor({ path: 'src/app.ts', line: 5, side: 'right' }, files)

    expect(result.status).toBe('moved')
    expect(result.anchor.line).toBe(6)
  })

  test('a removed line makes the thread outdated, not deleted', () => {
    const result = reanchor({ path: 'src/app.ts', line: 2, side: 'right' }, files)

    expect(result.status).toBe('outdated')
    // The anchor is still returned, so the thread stays readable.
    expect(result.anchor.path).toBe('src/app.ts')
  })

  test('a rename carries the thread to the new path', () => {
    const renamed = parseDiff(`diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
`)
    const result = reanchor({ path: 'old.ts', line: 3, side: 'right' }, renamed)

    expect(result.anchor.path).toBe('new.ts')
  })

  test('a deleted file makes every thread on it outdated', () => {
    const deleted = parseDiff(`diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-x
`)
    expect(reanchor({ path: 'gone.ts', line: 1, side: 'right' }, deleted).status).toBe('outdated')
  })
})

describe('reviewIsStale', () => {
  test('an approval of the current head is not stale', () => {
    expect(reviewIsStale('abc', 'abc')).toBe(false)
  })

  test('an approval of an earlier commit is stale', () => {
    expect(reviewIsStale('abc', 'def')).toBe(true)
  })

  test('a missing sha counts as stale, since it cannot be shown otherwise', () => {
    expect(reviewIsStale(null, 'abc')).toBe(true)
    expect(reviewIsStale('abc', null)).toBe(true)
  })
})

describe('approvalsSatisfied', () => {
  const head = 'head-sha'

  test('meets the requirement with enough approvals', () => {
    const result = approvalsSatisfied({
      reviews: [
        { reviewerId: 1, state: 'approved', commitSha: head },
        { reviewerId: 2, state: 'approved', commitSha: head },
      ],
      headSha: head,
      requiredApprovals: 2,
      dismissStaleReviews: false,
    })

    expect(result.satisfied).toBe(true)
    expect(result.approvals).toBe(2)
  })

  test('one change request blocks, however many approvals there are', () => {
    const result = approvalsSatisfied({
      reviews: [
        { reviewerId: 1, state: 'approved', commitSha: head },
        { reviewerId: 2, state: 'approved', commitSha: head },
        { reviewerId: 3, state: 'changes_requested', commitSha: head },
      ],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: false,
    })

    expect(result.satisfied).toBe(false)
    expect(result.blocking).toBe(1)
  })

  test('only the latest review from a reviewer counts', () => {
    const result = approvalsSatisfied({
      reviews: [
        { reviewerId: 1, state: 'changes_requested', commitSha: head },
        { reviewerId: 1, state: 'approved', commitSha: head },
      ],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: false,
    })

    expect(result.satisfied).toBe(true)
    expect(result.blocking).toBe(0)
  })

  test('a stale approval stops counting when the rule says so', () => {
    const result = approvalsSatisfied({
      reviews: [{ reviewerId: 1, state: 'approved', commitSha: 'older' }],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: true,
    })

    expect(result.satisfied).toBe(false)
  })

  test('a stale approval still counts when the rule allows it', () => {
    const result = approvalsSatisfied({
      reviews: [{ reviewerId: 1, state: 'approved', commitSha: 'older' }],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: false,
    })

    expect(result.satisfied).toBe(true)
  })

  test('pending and dismissed reviews count for nothing', () => {
    const result = approvalsSatisfied({
      reviews: [
        { reviewerId: 1, state: 'pending', commitSha: head },
        { reviewerId: 2, state: 'dismissed', commitSha: head },
      ],
      headSha: head,
      requiredApprovals: 1,
      dismissStaleReviews: false,
    })

    expect(result.satisfied).toBe(false)
    expect(result.approvals).toBe(0)
  })

  test('no approvals are needed when none are required', () => {
    expect(approvalsSatisfied({
      reviews: [],
      headSha: head,
      requiredApprovals: 0,
      dismissStaleReviews: false,
    }).satisfied).toBe(true)
  })
})
