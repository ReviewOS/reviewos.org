// The git layer, against a real repository.
//
// The unit tests above cover the strings; this covers the part that only shows
// up when git is actually running: that a bare repository is created, that refs
// and merge bases come back as expected, and that a hostile ref name never
// reaches the binary as an option.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { initBare, isEmpty, listBranches, mergeBase, runGit } from '../../app/Actions/Git/git'

let root: string
let bare: string
let work: string

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.toString()
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-git-'))
  bare = join(root, 'chris', 'demo.git')
  work = join(root, 'work')

  await initBare(bare)

  // A history with a fork: main gets one commit, a branch leaves and gets
  // another, so there is a real merge base to find.
  git(root, 'clone', bare, work)
  await Bun.write(join(work, 'README.md'), '# demo\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'first')
  git(work, 'push', 'origin', 'HEAD:refs/heads/main')

  git(work, 'checkout', '-b', 'feature')
  await Bun.write(join(work, 'feature.txt'), 'work\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'second')
  git(work, 'push', 'origin', 'feature')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('initBare', () => {
  test('creates a repository git itself recognises', async () => {
    const result = await runGit(bare, ['rev-parse', '--is-bare-repository'])

    expect(result.ok).toBe(true)
    expect(result.stdout.trim()).toBe('true')
  })
})

describe('isEmpty', () => {
  test('is false once the repository has commits', async () => {
    expect(await isEmpty(bare)).toBe(false)
  })

  test('is true for a repository with no commits', async () => {
    const fresh = join(root, 'fresh.git')
    await initBare(fresh)

    expect(await isEmpty(fresh)).toBe(true)
  })
})

describe('listBranches', () => {
  test('lists what was pushed', async () => {
    const branches = await listBranches(bare)

    expect(branches).toContain('main')
    expect(branches).toContain('feature')
  })
})

describe('mergeBase', () => {
  test('finds the commit the branch left from', async () => {
    const base = await mergeBase(bare, 'main', 'feature')
    const mainHead = (await runGit(bare, ['rev-parse', 'main'])).stdout.trim()

    // feature descends from main's only commit, so the base is main's head.
    expect(base).toBe(mainHead)
  })

  test('refuses a revision that would be read as an option', async () => {
    // If this ever returned a value, a crafted branch name would be passing
    // flags to git.
    expect(await mergeBase(bare, '--upload-pack=id', 'main')).toBeNull()
  })

  test('returns null for a ref that does not exist', async () => {
    expect(await mergeBase(bare, 'main', 'no-such-branch')).toBeNull()
  })
})

describe('runGit', () => {
  test('passes arguments without a shell, so metacharacters are literal', async () => {
    // If this ran through a shell, the `;` would end the command and the file
    // would be created. It should simply be an unknown ref.
    const result = await runGit(bare, ['rev-parse', '--verify', 'main; touch /tmp/reviewos-pwned'])

    expect(result.ok).toBe(false)
    expect(await Bun.file('/tmp/reviewos-pwned').exists()).toBe(false)
  })

  test('reports a failure rather than throwing', async () => {
    const result = await runGit(bare, ['cat-file', '-p', 'deadbeef'])

    expect(result.ok).toBe(false)
    expect(result.code).not.toBe(0)
  })
})
