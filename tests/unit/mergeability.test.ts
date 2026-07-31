// Whether a pull request merges cleanly.
//
// The parser is tested against the exact shapes git emits, and then against a
// real repository, because the two failure modes are different: the parser can
// be wrong about output it has never seen, and the invocation can be wrong
// about a repository with no work tree.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBare, runGit } from '../../app/Actions/Git/git'
import { createCommit } from '../../app/Actions/Git/write'
import {
  checkMergeability,
  isCurrent,
  parseMergeTree,
  toMergeableState,
} from '../../app/Actions/Pull/mergeability'

const TREE = 'e59d183df3a87cccb701d85cd91aef33019e33c9'

describe('parseMergeTree', () => {
  test('a clean merge is the tree oid and exit 0', () => {
    expect(parseMergeTree(`${TREE}\n`, 0)).toEqual({
      state: 'clean',
      treeSha: TREE,
      conflictingPaths: [],
    })
  })

  test('a conflict names the files', () => {
    const output = `${TREE}\nsrc/cart.ts\ndocs/pricing.md\n\nAuto-merging src/cart.ts\nCONFLICT (content): Merge conflict in src/cart.ts\n`

    expect(parseMergeTree(output, 1)).toEqual({
      state: 'conflicted',
      treeSha: TREE,
      conflictingPaths: ['src/cart.ts', 'docs/pricing.md'],
    })
  })

  test('the blank line ends the file list', () => {
    // Without that, "Auto-merging src/cart.ts" is reported as a conflicting
    // file and the interface tells somebody to resolve a file called that.
    const output = `${TREE}\nsrc/cart.ts\n\nAuto-merging src/cart.ts\n`

    expect(parseMergeTree(output, 1).conflictingPaths).toEqual(['src/cart.ts'])
  })

  test('a path with a space survives', () => {
    const output = `${TREE}\ndocs/a file.md\n\nCONFLICT\n`

    expect(parseMergeTree(output, 1).conflictingPaths).toEqual(['docs/a file.md'])
  })

  test('an exit code git does not use is unknown, not clean', () => {
    // Reporting "clean" because git fell over is a claim about the branches
    // that nothing checked.
    expect(parseMergeTree('', 128).state).toBe('unknown')
    expect(parseMergeTree('fatal: not a valid object name', -1).state).toBe('unknown')
  })

  test('exit 0 without a tree oid is unknown rather than clean', () => {
    expect(parseMergeTree('', 0).state).toBe('unknown')
    expect(parseMergeTree('not-a-sha\n', 0).state).toBe('unknown')
  })

  test('git refusing outright is unknown, not a conflict', () => {
    // git exits 1 for this too, but writes no tree. Without checking for the
    // tree, a deleted branch reads as a conflict in a file named after the
    // error message.
    const output = 'merge-tree: 0000000000000000000000000000000000000000 - not something we can merge\n'

    expect(parseMergeTree(output, 1)).toEqual({
      state: 'unknown',
      treeSha: null,
      conflictingPaths: [],
    })
  })
})

describe('toMergeableState', () => {
  test('maps onto the column vocabulary', () => {
    expect(toMergeableState({ state: 'clean', treeSha: TREE, conflictingPaths: [] })).toBe('clean')
    expect(toMergeableState({ state: 'conflicted', treeSha: null, conflictingPaths: ['a'] })).toBe('dirty')
    expect(toMergeableState({ state: 'unrelated', treeSha: null, conflictingPaths: [] })).toBe('dirty')
    expect(toMergeableState({ state: 'unknown', treeSha: null, conflictingPaths: [] })).toBe('unknown')
  })
})

describe('isCurrent', () => {
  test('an answer computed from the same two commits still applies', () => {
    expect(isCurrent({ baseSha: 'a', headSha: 'b' }, { baseSha: 'a', headSha: 'b' })).toBe(true)
  })

  test('either side moving makes it stale, which is how a push invalidates it', () => {
    expect(isCurrent({ baseSha: 'a', headSha: 'b' }, { baseSha: 'a', headSha: 'c' })).toBe(false)
    expect(isCurrent({ baseSha: 'a', headSha: 'b' }, { baseSha: 'z', headSha: 'b' })).toBe(false)
  })

  test('never computed is not current', () => {
    expect(isCurrent({ baseSha: null, headSha: null }, { baseSha: 'a', headSha: 'b' })).toBe(false)
  })
})

describe('checkMergeability, against a real repository', () => {
  let root: string
  let bare: string
  let base: string
  let clean: string
  let conflicting: string

  const author = { name: 'Test', email: 'test@example.com', date: '2026-01-01T00:00:00+00:00' }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'reviewos-merge-'))
    bare = join(root, 'demo.git')
    await initBare(bare, 'main')

    const first = await createCommit(bare, {
      branch: 'main',
      parentSha: null,
      expectedBranchSha: null,
      message: 'base',
      author,
      files: { 'file.txt': 'line one\n', 'other.txt': 'untouched\n' },
    })
    base = first.ok ? first.sha : ''

    // Touches a different file, so it merges.
    const good = await createCommit(bare, {
      branch: 'clean',
      parentSha: base,
      expectedBranchSha: null,
      message: 'clean',
      author,
      files: { 'other.txt': 'changed elsewhere\n' },
    })
    clean = good.ok ? good.sha : ''

    // Touches the same line as the change about to land on main.
    const bad = await createCommit(bare, {
      branch: 'conflicting',
      parentSha: base,
      expectedBranchSha: null,
      message: 'right',
      author,
      files: { 'file.txt': 'right change\n' },
    })
    conflicting = bad.ok ? bad.sha : ''

    const moved = await createCommit(bare, {
      branch: 'main',
      parentSha: base,
      message: 'left',
      author,
      files: { 'file.txt': 'left change\n' },
    })
    base = moved.ok ? moved.sha : ''
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('a branch touching another file merges cleanly', async () => {
    const result = await checkMergeability(bare, base, clean)

    expect(result.state).toBe('clean')
    expect(result.conflictingPaths).toEqual([])
  })

  test('a branch touching the same line conflicts, and says which file', async () => {
    const result = await checkMergeability(bare, base, conflicting)

    expect(result.state).toBe('conflicted')
    expect(result.conflictingPaths).toEqual(['file.txt'])
  })

  test('a commit that does not exist is unknown rather than an error', async () => {
    const result = await checkMergeability(bare, base, '0'.repeat(40))

    expect(result.state).toBe('unknown')
  })

  test('a hostile revision never reaches git', async () => {
    const result = await checkMergeability(bare, base, '--upload-pack=touch /tmp/pwned')

    expect(result.state).toBe('unknown')
  })

  test('computing mergeability does not move any branch', async () => {
    // The whole reason for merge-tree over a temporary worktree and a real
    // merge: this must be incapable of changing the repository.
    const refs = async () => (await runGit(bare, ['for-each-ref', '--format=%(refname) %(objectname)'])).stdout

    const before = await refs()
    await checkMergeability(bare, base, conflicting)

    expect(await refs()).toBe(before)
  })
})
