// What a push changed, read out of a real repository.
//
// `paths:` and `paths-ignore:` are the two filters people rely on most, and
// both had been inert: the dispatcher passed an empty list with a comment
// saying the paths were not known, and `pushStartsRun` reads empty as "no
// information, so run". A documentation-only push started the whole test suite,
// which is the one thing `paths-ignore` exists to prevent.
//
// The cases that matter are the two where the answer is not a plain diff: a
// brand new branch, which has no `before` to diff against, and a push too large
// to be worth reading.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { changedPaths } from '../../app/Actions/Workflow/changed'

const state = { temp: '', bare: '', work: '' }

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    },
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)

  return stdout.trim()
}

async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split('/')

    if (parts.length > 1)
      mkdirSync(join(state.work, ...parts.slice(0, -1)), { recursive: true })

    writeFileSync(join(state.work, path), contents)
  }

  await git(state.work, 'add', '-A')
  await git(state.work, 'commit', '-m', message)
  await git(state.work, 'push', state.bare, 'HEAD:refs/heads/main', '--force')

  return await git(state.work, 'rev-parse', 'HEAD')
}

beforeAll(async () => {
  state.temp = mkdtempSync(join(tmpdir(), 'reviewos-changed-'))
  state.bare = join(state.temp, 'bare.git')
  state.work = join(state.temp, 'work')

  mkdirSync(state.work, { recursive: true })

  await git(state.temp, 'init', '--bare', '--initial-branch=main', 'bare.git')
  await git(state.work, 'init', '--initial-branch=main')
}, 60_000)

afterAll(() => {
  if (state.temp)
    rmSync(state.temp, { recursive: true, force: true })
})

describe('the paths a push changed', () => {
  test('are the files between two commits', async () => {
    const first = await commit({ 'README.md': '# one\n', 'app/thing.ts': 'export const thing = 1\n' }, 'first')
    const second = await commit({ 'docs/guide.md': '# guide\n' }, 'second')

    expect(await changedPaths(state.bare, first, second)).toEqual(['docs/guide.md'])
  })

  test('and every file in a range, not only the last commit', async () => {
    // A push is usually several commits, and a filter has to see all of them:
    // reading only the tip would let a source change hide behind a
    // documentation commit pushed after it.
    const before = await git(state.work, 'rev-parse', 'HEAD')

    await commit({ 'app/one.ts': 'export const one = 1\n' }, 'one')
    const after = await commit({ 'docs/two.md': '# two\n' }, 'two')

    expect((await changedPaths(state.bare, before, after)).sort()).toEqual(['app/one.ts', 'docs/two.md'])
  })

  /*
   * A new ref has no `before`. Diffing against the empty tree would list every
   * file in the repository, so pushing a one-commit branch would look like it
   * changed everything - and a `paths-ignore` workflow would run on all of them.
   */
  test('a new branch is what its own commit introduced', async () => {
    const zero = '0'.repeat(40)
    const head = await commit({ 'app/three.ts': 'export const three = 3\n' }, 'three')

    expect(await changedPaths(state.bare, zero, head)).toEqual(['app/three.ts'])
  })

  test('an unknown revision is unknown rather than an error', async () => {
    // Empty means "no information" to the caller, which reads it as "run" -
    // the visible failure rather than the invisible one.
    expect(await changedPaths(state.bare, 'not-a-sha', 'also-not-a-sha')).toEqual([])
  })
})
