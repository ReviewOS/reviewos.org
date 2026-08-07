// The three merge strategies, against a real bare repository.
//
// The rules that decide whether a merge may happen are unit tested elsewhere.
// This is the part that only git can answer: that a merge commit has two
// parents, that a squash has one and carries every change, that a rebase keeps
// the individual commits, that a conflict is refused, and that a branch which
// moved underneath the merge is not clobbered.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performMerge } from '../../app/Actions/Pull/apply'
import { initBare, runGit } from '../../app/Actions/Git/git'

let root: string
let bare: string
let work: string

const author = { authorName: 'Chris', authorEmail: 'chris@example.com' }

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

async function sha(ref: string): Promise<string> {
  const result = await runGit(bare, ['rev-parse', ref])
  return result.stdout.trim()
}

async function commitsOn(ref: string): Promise<string[]> {
  const result = await runGit(bare, ['log', '--format=%s', ref])
  return result.stdout.trim().split('\n').filter(Boolean)
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-merge-'))
  bare = join(root, 'demo.git')
  work = join(root, 'work')

  await initBare(bare)
  git(root, 'clone', bare, work)

  // main: one commit. feature: two more, so a rebase has something to keep
  // separate and a squash has something to collapse.
  Bun.write(join(work, 'README.md'), '# demo\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'first')
  git(work, 'push', 'origin', 'HEAD:refs/heads/main')

  git(work, 'checkout', '-b', 'feature')
  Bun.write(join(work, 'a.txt'), 'a\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'add a')
  Bun.write(join(work, 'b.txt'), 'b\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'add b')
  git(work, 'push', 'origin', 'feature')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('performMerge, merge strategy', () => {
  test('moves the base branch to a commit with two parents', async () => {
    const baseSha = await sha('refs/heads/main')
    const headSha = await sha('refs/heads/feature')

    const result = await performMerge(bare, {
      strategy: 'merge',
      base: 'main',
      baseSha,
      headSha,
      subject: 'Merge pull request #1 from feature',
      body: 'Add a and b',
      ...author,
    })

    expect(result.ok).toBe(true)
    expect(await sha('refs/heads/main')).toBe(result.ok ? result.sha : '')

    const parents = (await runGit(bare, ['rev-list', '--parents', '-n', '1', 'refs/heads/main'])).stdout.trim().split(' ')
    expect(parents).toHaveLength(3)
    expect(parents.slice(1)).toEqual([baseSha, headSha])
  })

  test('brings the branch content with it', async () => {
    const result = await performMerge(bare, {
      strategy: 'merge',
      base: 'main',
      baseSha: await sha('refs/heads/main'),
      headSha: await sha('refs/heads/feature'),
      subject: 'Merge',
      body: '',
      ...author,
    })

    expect(result.ok).toBe(true)
    const files = (await runGit(bare, ['ls-tree', '--name-only', 'refs/heads/main'])).stdout.trim().split('\n')
    expect(files.sort()).toEqual(['README.md', 'a.txt', 'b.txt'])
  })

  test('writes the message it was given', async () => {
    await performMerge(bare, {
      strategy: 'merge',
      base: 'main',
      baseSha: await sha('refs/heads/main'),
      headSha: await sha('refs/heads/feature'),
      subject: 'Merge pull request #7 from feature',
      body: 'The title',
      ...author,
    })

    const message = (await runGit(bare, ['log', '-1', '--format=%B', 'refs/heads/main'])).stdout.trim()
    expect(message).toBe('Merge pull request #7 from feature\n\nThe title')
  })

  test('records the person who merged as the author', async () => {
    await performMerge(bare, {
      strategy: 'merge',
      base: 'main',
      baseSha: await sha('refs/heads/main'),
      headSha: await sha('refs/heads/feature'),
      subject: 'Merge',
      body: '',
      ...author,
    })

    const who = (await runGit(bare, ['log', '-1', '--format=%an <%ae>', 'refs/heads/main'])).stdout.trim()
    expect(who).toBe('Chris <chris@example.com>')
  })
})

describe('performMerge, squash strategy', () => {
  test('produces one commit whose only parent is the base', async () => {
    const baseSha = await sha('refs/heads/main')

    const result = await performMerge(bare, {
      strategy: 'squash',
      base: 'main',
      baseSha,
      headSha: await sha('refs/heads/feature'),
      subject: 'Add a and b (#1)',
      body: '* add a\n* add b',
      ...author,
    })

    expect(result.ok).toBe(true)
    const parents = (await runGit(bare, ['rev-list', '--parents', '-n', '1', 'refs/heads/main'])).stdout.trim().split(' ')
    expect(parents.slice(1)).toEqual([baseSha])
  })

  test('keeps every change from the branch', async () => {
    await performMerge(bare, {
      strategy: 'squash',
      base: 'main',
      baseSha: await sha('refs/heads/main'),
      headSha: await sha('refs/heads/feature'),
      subject: 'Add a and b (#1)',
      body: '',
      ...author,
    })

    const files = (await runGit(bare, ['ls-tree', '--name-only', 'refs/heads/main'])).stdout.trim().split('\n')
    expect(files.sort()).toEqual(['README.md', 'a.txt', 'b.txt'])
  })

  test('leaves main two commits long, not four', async () => {
    await performMerge(bare, {
      strategy: 'squash',
      base: 'main',
      baseSha: await sha('refs/heads/main'),
      headSha: await sha('refs/heads/feature'),
      subject: 'Add a and b (#1)',
      body: '',
      ...author,
    })

    expect(await commitsOn('refs/heads/main')).toEqual(['Add a and b (#1)', 'first'])
  })
})

describe('performMerge, rebase strategy', () => {
  test('replays each commit rather than collapsing them', async () => {
    const result = await performMerge(bare, {
      strategy: 'rebase',
      base: 'main',
      baseSha: await sha('refs/heads/main'),
      headSha: await sha('refs/heads/feature'),
      subject: '',
      body: '',
      ...author,
    })

    expect(result.ok).toBe(true)
    expect(await commitsOn('refs/heads/main')).toEqual(['add b', 'add a', 'first'])
  })

  test('produces a linear history, with no merge commit', async () => {
    await performMerge(bare, {
      strategy: 'rebase',
      base: 'main',
      baseSha: await sha('refs/heads/main'),
      headSha: await sha('refs/heads/feature'),
      subject: '',
      body: '',
      ...author,
    })

    const merges = (await runGit(bare, ['rev-list', '--merges', 'refs/heads/main'])).stdout.trim()
    expect(merges).toBe('')
  })

  test('brings the branch content with it', async () => {
    await performMerge(bare, {
      strategy: 'rebase',
      base: 'main',
      baseSha: await sha('refs/heads/main'),
      headSha: await sha('refs/heads/feature'),
      subject: '',
      body: '',
      ...author,
    })

    const files = (await runGit(bare, ['ls-tree', '--name-only', 'refs/heads/main'])).stdout.trim().split('\n')
    expect(files.sort()).toEqual(['README.md', 'a.txt', 'b.txt'])
  })
})

describe('performMerge, refusals', () => {
  test('refuses a conflict rather than committing one', async () => {
    // Both branches change the same line of the same file.
    git(work, 'checkout', 'main')
    Bun.write(join(work, 'conflict.txt'), 'from main\n')
    git(work, 'add', '.')
    git(work, 'commit', '-m', 'main version')
    git(work, 'push', 'origin', 'main')

    git(work, 'checkout', 'feature')
    Bun.write(join(work, 'conflict.txt'), 'from feature\n')
    git(work, 'add', '.')
    git(work, 'commit', '-m', 'feature version')
    git(work, 'push', 'origin', 'feature')

    const baseSha = await sha('refs/heads/main')

    const result = await performMerge(bare, {
      strategy: 'merge',
      base: 'main',
      baseSha,
      headSha: await sha('refs/heads/feature'),
      subject: 'Merge',
      body: '',
      ...author,
    })

    expect(result.ok).toBe(false)
    // Nothing moved.
    expect(await sha('refs/heads/main')).toBe(baseSha)
  })

  test('refuses a rebase when the base moved, too', async () => {
    const staleBase = await sha('refs/heads/main')

    git(work, 'checkout', 'main')
    Bun.write(join(work, 'meanwhile.txt'), 'pushed\n')
    git(work, 'add', '.')
    git(work, 'commit', '-m', 'meanwhile')
    git(work, 'push', 'origin', 'main')

    const moved = await sha('refs/heads/main')

    const result = await performMerge(bare, {
      strategy: 'rebase',
      base: 'main',
      baseSha: staleBase,
      headSha: await sha('refs/heads/feature'),
      subject: '',
      body: '',
      ...author,
    })

    expect(result.ok).toBe(false)
    expect(await sha('refs/heads/main')).toBe(moved)
  })

  test('refuses when the base moved after the rules were checked', async () => {
    const staleBase = await sha('refs/heads/main')

    // Somebody pushes to main between the check and the merge.
    git(work, 'checkout', 'main')
    Bun.write(join(work, 'meanwhile.txt'), 'pushed\n')
    git(work, 'add', '.')
    git(work, 'commit', '-m', 'meanwhile')
    git(work, 'push', 'origin', 'main')

    const moved = await sha('refs/heads/main')

    const result = await performMerge(bare, {
      strategy: 'merge',
      base: 'main',
      baseSha: staleBase,
      headSha: await sha('refs/heads/feature'),
      subject: 'Merge',
      body: '',
      ...author,
    })

    expect(result.ok).toBe(false)
    // The push that arrived first is still there.
    expect(await sha('refs/heads/main')).toBe(moved)
  })
})

/**
 * Two pull requests merging at once. The update-ref guard is the whole
 * concurrency story, and until here it was only ever tested one merge at a
 * time - the raced case is the one the roadmap said was missing.
 *
 * The race is real: performMerge shells out, so the contenders are separate
 * git processes serialized by the ref lock on disk, not by anything in this
 * process. What must hold is not who wins - either may - but that exactly one
 * does, and that the loser changed nothing.
 */
describe('performMerge, raced', () => {
  /** A second branch off main, so the two merges are not the same merge. */
  async function secondBranch(): Promise<string> {
    git(work, 'checkout', 'main')
    git(work, 'checkout', '-b', 'feature2')
    Bun.write(join(work, 'c.txt'), 'c\n')
    git(work, 'add', '.')
    git(work, 'commit', '-m', 'add c')
    git(work, 'push', 'origin', 'feature2')

    return await sha('refs/heads/feature2')
  }

  test('two merges from the same observed base: exactly one lands', async () => {
    const baseSha = await sha('refs/heads/main')
    const featureSha = await sha('refs/heads/feature')
    const feature2Sha = await secondBranch()

    // Both hold the same observed base, as two requests that both passed the
    // rules would. A squash against a rebase, so both strategies' paths to
    // update-ref are in the race.
    const [first, second] = await Promise.all([
      performMerge(bare, {
        strategy: 'squash',
        base: 'main',
        baseSha,
        headSha: featureSha,
        subject: 'Squash feature',
        body: '',
        ...author,
      }),
      performMerge(bare, {
        strategy: 'rebase',
        base: 'main',
        baseSha,
        headSha: feature2Sha,
        subject: 'Rebase feature2',
        body: '',
        ...author,
      }),
    ])

    const winners = [first, second].filter(result => result.ok)
    expect(winners.length).toBe(1)

    // The ref is exactly where the winner put it - the loser moved nothing.
    expect(await sha('refs/heads/main')).toBe((winners[0] as { ok: true, sha: string }).sha)
  })

  test('the loser is refused for the right reason, and takes nothing with it', async () => {
    const baseSha = await sha('refs/heads/main')
    const featureSha = await sha('refs/heads/feature')
    const feature2Sha = await secondBranch()

    const first = await performMerge(bare, {
      strategy: 'squash',
      base: 'main',
      baseSha,
      headSha: featureSha,
      subject: 'Squash feature',
      body: '',
      ...author,
    })

    expect(first.ok).toBe(true)

    // The second request checked its rules against the same base, and the
    // base has moved: the merge that would clobber the first one is refused.
    const second = await performMerge(bare, {
      strategy: 'rebase',
      base: 'main',
      baseSha,
      headSha: feature2Sha,
      subject: 'Rebase feature2',
      body: '',
      ...author,
    })

    expect(second.ok).toBe(false)
    if (!second.ok)
      expect(second.error).toContain('moved')

    // The winner's merge is the tip, and the loser's branch content is not in
    // the tree - a refusal that had already written something would be worse
    // than a clobber, because nothing would ever notice it.
    expect(await sha('refs/heads/main')).toBe((first as { ok: true, sha: string }).sha)
    const files = (await runGit(bare, ['ls-tree', '--name-only', 'refs/heads/main'])).stdout.trim().split('\n')
    expect(files).not.toContain('c.txt')
  })
})
