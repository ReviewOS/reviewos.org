// A mirror fetch, against two real repositories.
//
// `sync.ts` decides what a change *means* and is unit tested against literals.
// This is the half only git can answer: that `--prune` actually removes a
// branch deleted upstream, that a rewritten history is followed and reported as
// rewritten rather than absorbed, and - the one that matters most - that a
// fetch which fails leaves the repository exactly as it was rather than
// half-updated.
//
// The last one is why this file exists at all. A half-updated mirror is worse
// than a stale one: stale is visibly old, half-updated is a repository whose
// branches disagree with each other and whose reader has no way to tell.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchMirror, isAncestor, snapshotRefs } from '../../app/Actions/Mirror/fetch'
import { diffRefs, isForcePush } from '../../app/Actions/Mirror/sync'
import { initBare } from '../../app/Actions/Git/git'

let root: string
let upstream: string
let mirror: string
let work: string

function git(cwd: string, ...args: string[]): string {
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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-mirror-'))
  upstream = join(root, 'upstream.git')
  mirror = join(root, 'mirror.git')
  work = join(root, 'work')

  await initBare(upstream)
  await initBare(mirror)

  git(root, 'clone', upstream, work)
  await Bun.write(join(work, 'README.md'), '# upstream\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'first')
  git(work, 'push', 'origin', 'HEAD:main')

  git(work, 'checkout', '-b', 'feature')
  await Bun.write(join(work, 'a.txt'), 'a\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'add a')
  git(work, 'push', 'origin', 'feature')

  // The first sync, which every case below starts from.
  await fetchMirror(mirror, upstream)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('a deleted upstream branch', () => {
  test('disappears here', async () => {
    /*
     * `--prune` is what does this, and without it the branch lingers forever.
     * A branch list that only grows stops meaning anything: every abandoned
     * topic branch from the repository's whole history sits in the picker, and
     * the reader cannot tell which ones still exist upstream.
     */
    expect(Object.keys(await snapshotRefs(mirror))).toContain('refs/heads/feature')

    git(work, 'push', 'origin', '--delete', 'feature')
    const outcome = await fetchMirror(mirror, upstream)

    expect(outcome.ok).toBe(true)
    expect(Object.keys(outcome.after)).not.toContain('refs/heads/feature')

    const changes = diffRefs(outcome.before, outcome.after)
    expect(changes.find(change => change.ref === 'refs/heads/feature')?.kind).toBe('deleted')
  })
})

describe('a force push upstream', () => {
  test('is followed, and reported as a rewrite rather than absorbed', async () => {
    if (!upstream)
      return

    const before = git(work, 'rev-parse', 'feature')

    // Rewrite the branch: same name, different history.
    git(work, 'checkout', 'feature')
    await Bun.write(join(work, 'a.txt'), 'rewritten\n')
    git(work, 'add', '.')
    git(work, 'commit', '--amend', '-m', 'add a, differently')
    git(work, 'push', '--force', 'origin', 'feature')

    const outcome = await fetchMirror(mirror, upstream)
    expect(outcome.ok).toBe(true)

    const change = diffRefs(outcome.before, outcome.after).find(c => c.ref === 'refs/heads/feature')
    expect(change?.kind).toBe('updated')
    expect(change?.before).toBe(before)

    /*
     * And it is *known* to be a rewrite, which is the reportable part. A force
     * push and an ordinary advance are both "updated" until somebody asks git
     * whether the old commit is still reachable - and a mirror that says
     * "3 commits" for a rewrite tells the reader nothing happened to the
     * history they already read.
     */
    const stillReachable = await isAncestor(mirror, change!.before!, change!.after!)
    expect(stillReachable).toBe(false)
    expect(isForcePush(change!, stillReachable)).toBe(true)
  })

  test('and an ordinary advance is not called one', async () => {
    // The control. Calling every update a rewrite is as useless as calling none
    // of them one.
    git(work, 'checkout', 'main')
    await Bun.write(join(work, 'b.txt'), 'b\n')
    git(work, 'add', '.')
    git(work, 'commit', '-m', 'add b')
    git(work, 'push', 'origin', 'main')

    const outcome = await fetchMirror(mirror, upstream)
    const change = diffRefs(outcome.before, outcome.after).find(c => c.ref === 'refs/heads/main')

    const stillReachable = await isAncestor(mirror, change!.before!, change!.after!)
    expect(isForcePush(change!, stillReachable)).toBe(false)
  })
})

describe('a failed sync', () => {
  test('leaves the previous state intact and readable', async () => {
    /*
     * The case this file exists for. A half-updated mirror is worse than a
     * stale one: stale is visibly old, half-updated is a repository whose
     * branches disagree with each other and whose reader cannot tell.
     *
     * `git fetch` is atomic per ref and this asserts the outcome rather than
     * the mechanism - after a fetch of a remote that does not exist, every ref
     * is exactly where it was.
     */
    const before = await snapshotRefs(mirror)

    const outcome = await fetchMirror(mirror, join(root, 'no-such-remote.git'))

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBeTruthy()

    // Reported as unchanged, so a caller diffing before against after sees
    // nothing rather than inventing a deletion of every branch.
    expect(outcome.after).toEqual(before)
    expect(diffRefs(outcome.before, outcome.after)).toEqual([])

    // And on disk, which is the claim that matters.
    expect(await snapshotRefs(mirror)).toEqual(before)
  })

  test('and the repository is still readable afterwards', async () => {
    await fetchMirror(mirror, join(root, 'no-such-remote.git'))

    // `git log` rather than a ref read: a repository whose refs survived but
    // whose objects did not would pass the assertion above and still be broken.
    const log = spawnSync('git', ['--git-dir', mirror, 'log', '--format=%s', 'refs/heads/main'])

    expect(log.status).toBe(0)
    expect(log.stdout.toString()).toContain('first')
  })
})
