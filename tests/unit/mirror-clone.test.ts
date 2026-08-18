// The mirror clone, which every import rides on.
//
// This existed because the general-purpose `runGit` cannot do it: `runGit`
// prepends `--git-dir`, which a clone reads as its destination, and its 30
// second timeout kills any real import mid-transfer. Both properties are
// invisible from outside the spawn, so the argv builder is asserted directly
// and the behavior against a real repository.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { initBare, mirrorClone, mirrorCloneArgs, runGit } from '../../app/Actions/Git/git'

let root: string
let source: string

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
  root = mkdtempSync(join(tmpdir(), 'reviewos-mirror-clone-'))
  source = join(root, 'source.git')

  // A source with a branch and a tag, because `--mirror` is the whole point:
  // a plain clone would bring the default branch and nothing else.
  await initBare(source)

  const work = join(root, 'work')
  git(root, 'clone', source, work)
  await Bun.write(join(work, 'README.md'), '# source\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'first')
  git(work, 'push', 'origin', 'HEAD:refs/heads/main')
  git(work, 'checkout', '-b', 'feature')
  await Bun.write(join(work, 'feature.txt'), 'work\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'second')
  git(work, 'push', 'origin', 'feature')
  git(work, 'tag', 'v1.0.0')
  git(work, 'push', 'origin', 'v1.0.0')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('mirrorCloneArgs', () => {
  /**
   * The property that shipped broken: a clone routed through `runGit` carried
   * `--git-dir <parent>`, which clone reads as the repository it is cloning
   * into. The argv must say exactly what it means and nothing else.
   */
  test('never contains --git-dir', () => {
    const args = mirrorCloneArgs('https://example.com/a/b.git', '/tmp/dest.git')

    expect(args).toEqual(['clone', '--mirror', 'https://example.com/a/b.git', '/tmp/dest.git'])
    expect(args.join(' ')).not.toContain('--git-dir')
  })
})

describe('mirrorClone', () => {
  test('brings every ref: branches and tags', async () => {
    const destination = join(root, 'cloned.git')
    const result = await mirrorClone(source, destination)

    expect(result.ok).toBe(true)

    const refs = await runGit(destination, ['for-each-ref', '--format=%(refname)'])
    const names = refs.stdout.split('\n').map(line => line.trim()).filter(Boolean)

    expect(names).toContain('refs/heads/main')
    expect(names).toContain('refs/heads/feature')
    expect(names).toContain('refs/tags/v1.0.0')

    // A mirror of a bare repository is itself bare.
    const bare = await runGit(destination, ['rev-parse', '--is-bare-repository'])
    expect(bare.stdout.trim()).toBe('true')
  })

  /**
   * A half-written destination is worse than a failure: the import stages are
   * re-entrant, and a directory that exists reads as a finished clone.
   */
  test('a failed clone leaves no directory', async () => {
    const destination = join(root, 'failed.git')
    const result = await mirrorClone(join(root, 'does-not-exist.git'), destination)

    expect(result.ok).toBe(false)
    expect(result.stderr.length).toBeGreaterThan(0)
    expect(existsSync(destination)).toBe(false)
  })
})
