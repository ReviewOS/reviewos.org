// The server-rendered pull request page's diff, bounded.
//
// `pullRequestDiff` used to be `runGit` returning the whole patch as one
// string - the main way a large diff killed the box. It rides the streaming
// path now, and these tests pin the two properties that matter: a diff past
// the budget comes back truncated with well-formed partial text, and a normal
// diff is byte-identical to what the unbounded implementation produced.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { commitDiff, pullRequestDiff } from '../../app/Actions/Pull/load'
import { initBare, mergeBase, runGit } from '../../app/Actions/Git/git'
import { REPOSITORY_ROOT, repositoryPath } from '../../app/Actions/Git/storage'

// Under the real repository root, because `pullRequestDiff` resolves owner and
// name through `repositoryPath` - handing it a temp directory would test a
// function nothing calls. The owner is unique enough not to collide.
const OWNER = `phase16-m2-fixture-${process.pid}`
const NAME = 'diffs'

let bare: string
let work: string
let baseSha: string
let headSha: string

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
  return result.stdout.toString().trim()
}

beforeAll(async () => {
  const resolved = repositoryPath(OWNER, NAME)
  if (!resolved.ok)
    throw new Error('fixture path did not resolve')

  bare = resolved.path!
  work = resolve(REPOSITORY_ROOT, OWNER, 'work')

  mkdirSync(resolve(REPOSITORY_ROOT, OWNER), { recursive: true })
  await initBare(bare)

  git(resolve(REPOSITORY_ROOT, OWNER), 'clone', bare, work)
  await Bun.write(join(work, 'README.md'), '# fixture\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'base')
  git(work, 'push', 'origin', 'HEAD:refs/heads/main')
  baseSha = git(work, 'rev-parse', 'HEAD')

  // A branch whose diff is comfortably over a small test budget: a hundred
  // thousand distinct lines, so partial text still parses as a diff.
  git(work, 'checkout', '-b', 'feature')
  const lines = Array.from({ length: 100_000 }, (unused, index) => `line number ${index} of the change`)
  await Bun.write(join(work, 'big.txt'), `${lines.join('\n')}\n`)
  await Bun.write(join(work, 'small.txt'), 'one honest line\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'the change')
  git(work, 'push', 'origin', 'feature')
  headSha = git(work, 'rev-parse', 'HEAD')
})

afterAll(() => {
  rmSync(resolve(REPOSITORY_ROOT, OWNER), { recursive: true, force: true })
})

describe('pullRequestDiff', () => {
  test('a diff past the budget returns truncated, well-formed partial text', async () => {
    const bounded = await pullRequestDiff(OWNER, NAME, baseSha, headSha, { maxBytes: 64 * 1024 })

    expect(bounded.truncated).toBe(true)
    expect(bounded.text.length).toBeGreaterThan(0)

    // Well-formed: it starts where a patch starts and holds whole lines of
    // the file it was cut in - a cut mid-chunk still lands on real content.
    expect(bounded.text.startsWith('diff --git')).toBe(true)
    expect(bounded.text).toContain('big.txt')
  })

  test('a normal diff is byte-identical to the unbounded output', async () => {
    const bounded = await pullRequestDiff(OWNER, NAME, baseSha, headSha)

    // What the old implementation ran: merge-base by hand, then one buffered
    // `git diff` with the same flags.
    const base = await mergeBase(bare, baseSha, headSha)
    const reference = await runGit(bare, [
      'diff',
      '--unified=3',
      '--find-renames',
      '--find-copies',
      '--no-color',
      '--no-ext-diff',
      base!,
      headSha,
    ], { maxBytes: 64 * 1024 * 1024 })

    expect(bounded.truncated).toBe(false)
    expect(reference.truncated).not.toBe(true)
    expect(bounded.text.length).toBeGreaterThan(0)
    expect(bounded.text).toBe(reference.stdout)
  })

  test('a missing repository answers empty rather than throwing', async () => {
    const bounded = await pullRequestDiff(OWNER, 'no-such-repository', baseSha, headSha)

    expect(bounded).toEqual({ text: '', truncated: false })
  })
})

describe('commitDiff', () => {
  test('one commit against its first parent, byte-identical to the unbounded output', async () => {
    const bounded = await commitDiff(OWNER, NAME, headSha)

    const reference = await runGit(bare, [
      'diff',
      '--unified=3',
      '--find-renames',
      '--find-copies',
      '--no-color',
      '--no-ext-diff',
      `${headSha}^!`,
    ], { maxBytes: 64 * 1024 * 1024 })

    expect(bounded.truncated).toBe(false)
    expect(bounded.text.length).toBeGreaterThan(0)
    expect(bounded.text).toBe(reference.stdout)
  })

  test('a commit past the budget returns truncated partial text', async () => {
    const bounded = await commitDiff(OWNER, NAME, headSha, { maxBytes: 64 * 1024 })

    expect(bounded.truncated).toBe(true)
    expect(bounded.text.startsWith('diff --git')).toBe(true)
  })
})
