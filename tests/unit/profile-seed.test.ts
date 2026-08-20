/**
 * Writing a profile page into a bare repository, with real git.
 *
 * The two behaviours worth pinning are the plumbing and the refusal. The
 * plumbing, because a blob/tree/commit/ref sequence that is subtly wrong
 * produces a repository git will not read and nothing here would notice - the
 * page would simply stay blank, which is the state this exists to fix.
 *
 * The refusal, because this runs on every deploy: once there is a commit, a
 * second run must do nothing. A step that rewrote the page each release would
 * quietly undo an edit somebody made through the interface, and they would
 * have no way to tell what happened.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let work = ''
let bare = ''

function git(...args: string[]): string {
  return spawnSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8' }).stdout ?? ''
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'reviewos-seed-'))
  bare = join(work, 'profile.git')
  spawnSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare], { encoding: 'utf8' })
})

afterAll(() => {
  // Only the directory this file made, by the name it made it with.
  if (work)
    rmSync(work, { recursive: true, force: true })
})

describe('the commit a first page is', () => {
  test('is a commit git can read, with the file in it', async () => {
    const { writeInitialCommitForTest } = await import('../../app/Actions/Profile/seed')
    const written = await writeInitialCommitForTest(bare, '# Who we are\n\nA sentence.\n', 'the page this owner shows')

    expect(written.ok).toBe(true)

    expect(git('cat-file', '-t', 'HEAD').trim()).toBe('commit')
    expect(git('show', '-s', '--format=%s', 'HEAD').trim()).toBe('the page this owner shows')
    expect(git('cat-file', 'blob', 'HEAD:README.md')).toContain('Who we are')
  })

  test('carries an author, which a bare repository nobody configured does not have', () => {
    // `commit-tree` fails with `unable to auto-detect email address` unless the
    // identity is in the environment, and a deploy step has no `git config`.
    expect(git('show', '-s', '--format=%an <%ae>', 'HEAD').trim()).toBe('ReviewOS <noreply@reviewos.org>')
  })

  test('lands on the branch HEAD already pointed at', () => {
    // Not a second opinion about the default branch: `init --bare` was told
    // one, and a commit on a different branch is a repository whose page is
    // there and whose page does not render.
    expect(git('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main')
    expect(git('rev-parse', 'refs/heads/main').trim()).toBe(git('rev-parse', 'HEAD').trim())
  })
})
