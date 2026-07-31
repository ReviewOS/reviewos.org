// Writing commits into a bare repository, against a real one.
//
// A bare repository has no work tree, which rules out most of the ways a commit
// is normally made and is the reason this goes through a temporary index. What
// is worth checking is that nested paths and deletions both survive that route,
// and that the ref guard actually refuses a stale write rather than quietly
// overwriting somebody else's commit.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBare, runGit } from '../../app/Actions/Git/git'
import { branchSha, createCommit, isSafePath } from '../../app/Actions/Git/write'

let root: string
let bare: string

const author = { name: 'Test', email: 'test@example.com', date: '2026-01-01T00:00:00+00:00' }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-write-'))
  bare = join(root, 'demo.git')

  await initBare(bare, 'main')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('createCommit', () => {
  test('writes the first commit into an empty repository', async () => {
    const result = await createCommit(bare, {
      branch: 'main',
      parentSha: null,
      message: 'first',
      author,
      files: { 'README.md': '# Demo\n' },
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('nested paths work, which is the reason for the temporary index', async () => {
    const parent = await branchSha(bare, 'main')

    const result = await createCommit(bare, {
      branch: 'main',
      parentSha: parent,
      message: 'add a nested file',
      author,
      files: { 'src/deep/nested.ts': 'export const a = 1\n' },
    })

    expect(result.ok).toBe(true)

    const listed = await runGit(bare, ['ls-tree', '-r', '--name-only', 'refs/heads/main'])

    expect(listed.stdout.trim().split('\n').sort()).toEqual(['README.md', 'src/deep/nested.ts'])
  })

  test('an unchanged path is carried forward rather than dropped', async () => {
    // The index starts from the parent's tree, so a commit that touches one
    // file does not delete every other file. Getting this wrong would look
    // fine in the commit and catastrophic in the diff.
    const listed = await runGit(bare, ['ls-tree', '-r', '--name-only', 'refs/heads/main'])

    expect(listed.stdout).toContain('README.md')
  })

  test('a null value deletes the path', async () => {
    const parent = await branchSha(bare, 'main')

    const result = await createCommit(bare, {
      branch: 'main',
      parentSha: parent,
      message: 'remove the readme',
      author,
      files: { 'README.md': null },
    })

    expect(result.ok).toBe(true)

    const listed = await runGit(bare, ['ls-tree', '-r', '--name-only', 'refs/heads/main'])

    expect(listed.stdout).not.toContain('README.md')
    expect(listed.stdout).toContain('src/deep/nested.ts')
  })

  test('a new branch is created off an existing commit', async () => {
    // The parent and the ref guard are different questions here: there is a
    // parent commit, and no existing ref to compare against.
    const parent = await branchSha(bare, 'main')

    const result = await createCommit(bare, {
      branch: 'feature',
      parentSha: parent,
      expectedBranchSha: null,
      message: 'change the nested file',
      author,
      files: { 'src/deep/nested.ts': 'export const a = 2\n' },
    })

    expect(result.ok).toBe(true)
    expect(await branchSha(bare, 'feature')).toBe(result.ok ? result.sha : '')
  })

  test('the commit produces a real diff against its parent', async () => {
    const main = await branchSha(bare, 'main')
    const feature = await branchSha(bare, 'feature')

    const diff = await runGit(bare, ['diff', '--unified=3', main!, feature!])

    expect(diff.stdout).toContain('-export const a = 1')
    expect(diff.stdout).toContain('+export const a = 2')
  })

  test('the author is stamped rather than inherited from whoever runs the server', async () => {
    const shown = await runGit(bare, ['log', '-1', '--format=%an <%ae> %cn <%ce>', 'refs/heads/feature'])

    expect(shown.stdout.trim()).toBe('Test <test@example.com> Test <test@example.com>')
  })

  test('a stale expected sha is refused rather than overwriting', async () => {
    const main = await branchSha(bare, 'main')

    const result = await createCommit(bare, {
      branch: 'feature',
      parentSha: main,
      // `feature` has moved past this, so the compare-and-swap has to fail.
      expectedBranchSha: main,
      message: 'stale',
      author,
      files: { 'x.txt': 'x\n' },
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('Could not move the branch')
  })

  test('a branch that already exists cannot be created again', async () => {
    const main = await branchSha(bare, 'main')

    const result = await createCommit(bare, {
      branch: 'feature',
      parentSha: main,
      expectedBranchSha: null,
      message: 'clobber',
      author,
      files: { 'y.txt': 'y\n' },
    })

    expect(result.ok).toBe(false)
  })

  test('a hostile branch name never reaches git', async () => {
    const result = await createCommit(bare, {
      branch: '--upload-pack=touch /tmp/pwned',
      parentSha: null,
      message: 'no',
      author,
      files: { 'a.txt': 'a' },
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('branch name')
  })

  test('a traversing path is refused', async () => {
    const main = await branchSha(bare, 'main')

    const result = await createCommit(bare, {
      branch: 'main',
      parentSha: main,
      message: 'no',
      author,
      files: { '../escaped.txt': 'no' },
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('path cannot be used')
  })
})

describe('isSafePath', () => {
  test('ordinary paths are fine', () => {
    expect(isSafePath('README.md')).toBe(true)
    expect(isSafePath('src/deep/nested.ts')).toBe(true)
  })

  test('traversal, absolute paths, and the git directory are not', () => {
    expect(isSafePath('../escaped')).toBe(false)
    expect(isSafePath('/etc/passwd')).toBe(false)
    expect(isSafePath('.git/config')).toBe(false)
    expect(isSafePath('a/./b')).toBe(false)
    expect(isSafePath('a//b')).toBe(false)
  })

  test('an empty path and a null byte are not', () => {
    expect(isSafePath('')).toBe(false)
    expect(isSafePath('a\0b')).toBe(false)
  })

  test('a file called gitignore is not the git directory', () => {
    expect(isSafePath('.gitignore')).toBe(true)
  })
})

describe('branchSha', () => {
  test('returns null for a branch that does not exist', async () => {
    expect(await branchSha(bare, 'nope')).toBeNull()
  })

  test('returns null for a hostile ref rather than running git', async () => {
    expect(await branchSha(bare, '--upload-pack=x')).toBeNull()
  })
})
