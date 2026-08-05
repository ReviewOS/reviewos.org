// Forking, on disk.
//
// The naming rule is unit-tested next door in `repo-settings.test.ts`. What is
// here is the copy itself, because a fork has two properties that are easy to
// get wrong and invisible once wrong: it has to contain the source's history,
// and it has to be cheap. A fork that silently copied every byte would pass
// every test that only checked the commits are there, right up until somebody
// forked a repository with a decade of history.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneBare, initBare, listBranches } from '../../app/Actions/Git/git'

let root: string
let source: string

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, env })

  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)

  return result.stdout.toString()
}

/** Every loose object and pack file under a bare repository. */
function objectFiles(bare: string): string[] {
  const found: string[] = []

  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)

      if (entry.isDirectory()) {
        // `info` holds text files git writes per repository, never objects.
        if (entry.name !== 'info')
          walk(full)
      }
      else {
        found.push(full)
      }
    }
  }

  walk(join(bare, 'objects'))

  return found
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-fork-'))
  source = join(root, 'source.git')

  await initBare(source, 'main')

  const work = join(root, 'work')
  mkdirSync(work)
  git(work, 'init', '--initial-branch=main')
  writeFileSync(join(work, 'README.md'), '# source\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'first')
  git(work, 'checkout', '-b', 'topic')
  writeFileSync(join(work, 'topic.txt'), 'topic\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'topic work')
  git(work, 'push', source, 'main', 'topic')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('cloneBare', () => {
  test('the fork has the source history and every branch', async () => {
    const fork = join(root, 'fork.git')
    const result = await cloneBare(source, fork)

    expect(result.ok).toBe(true)
    expect((await listBranches(fork)).sort()).toEqual(['main', 'topic'])

    const log = git(fork, '--git-dir', fork, 'log', '--format=%s', 'main')
    expect(log).toContain('first')
  })

  test('it is bare, so nothing checked out a working tree next to it', async () => {
    const fork = join(root, 'bare-check.git')
    await cloneBare(source, fork)

    expect(git(fork, '--git-dir', fork, 'rev-parse', '--is-bare-repository').trim()).toBe('true')
  })

  /**
   * The cheapness, checked as the thing that makes it cheap rather than as a
   * claim about it: `--local` hardlinks the object store, so after the clone the
   * source's own object files have more than one link to them. Without
   * `--local` - or with `--no-hardlinks`, or across a filesystem boundary -
   * every one of them would still read 1, and the fork would cost a full copy.
   */
  test('shares objects with the source rather than copying them', async () => {
    const fork = join(root, 'linked.git')
    await cloneBare(source, fork)

    expect(git(fork, '--git-dir', fork, 'rev-list', '--objects', '--all').length).toBeGreaterThan(0)

    const linked = objectFiles(source).filter(file => statSync(file).nlink > 1)

    expect(objectFiles(source).length).toBeGreaterThan(0)
    expect(linked.length).toBeGreaterThan(0)
  })

  test('refuses rather than overwriting an existing directory', async () => {
    const fork = join(root, 'occupied.git')
    mkdirSync(fork)
    writeFileSync(join(fork, 'in-the-way.txt'), 'x')

    const result = await cloneBare(source, fork)

    expect(result.ok).toBe(false)
  })

  test('a source that is not a repository fails rather than producing an empty fork', async () => {
    const result = await cloneBare(join(root, 'nothing-here'), join(root, 'doomed.git'))

    expect(result.ok).toBe(false)
  })
})
