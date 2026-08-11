// Which commit a mirrored pull request is diffed against.
//
// Built on a real repository rather than a stub, because the whole question is
// what git holds: a stubbed `cat-file` would answer whatever the test wanted
// and the bug being guarded against is precisely a sha nobody checked.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { branchTips, presentObjects, resolveBaseShas } from '../../app/Actions/Mirror/bases'
import { proposalRefspec } from '../../app/Actions/Mirror/fetch'

const ABSENT = 'f'.repeat(40)

let temp = ''
let repo = ''
let mainTip = ''
let older = ''

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })

  const [stdout, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args[0]} exited ${code}`)

  return stdout.trim()
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'reviewos-bases-'))

  // A *bare* repository, because that is what a mirror is and what these
  // functions are handed: `runGit` passes the path as `--git-dir`.
  repo = join(temp, 'mirror.git')
  const work = join(temp, 'work')
  mkdirSync(work, { recursive: true })

  await git(temp, 'init', '--bare', '--initial-branch=main', 'mirror.git')

  await git(work, 'init', '--initial-branch=main')
  writeFileSync(join(work, 'a.txt'), 'one\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'one')
  older = await git(work, 'rev-parse', 'HEAD')

  writeFileSync(join(work, 'a.txt'), 'two\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'two')
  mainTip = await git(work, 'rev-parse', 'HEAD')

  await git(work, 'push', repo, 'main')
})

afterAll(() => {
  if (temp)
    rmSync(temp, { recursive: true, force: true })
})

describe('presentObjects', () => {
  test('reports the commits the repository holds', async () => {
    const present = await presentObjects(repo, [mainTip, older, ABSENT])

    expect(present.has(mainTip)).toBe(true)
    expect(present.has(older)).toBe(true)
    expect(present.has(ABSENT)).toBe(false)
  })

  test('and answers for an empty ask without running git', async () => {
    expect((await presentObjects(repo, [])).size).toBe(0)
    expect((await presentObjects(repo, ['not-a-sha'])).size).toBe(0)
  })
})

describe('branchTips', () => {
  test('resolves the branches that exist and skips the ones that do not', async () => {
    const tips = await branchTips(repo, ['main', 'no-such-branch'])

    expect(tips.get('main')).toBe(mainTip)
    expect(tips.has('no-such-branch')).toBe(false)
  })
})

describe('resolveBaseShas', () => {
  const pull = (number: number, baseSha: string | null, baseRef: string | null) => ({
    number,
    title: '',
    body: '',
    state: 'open' as const,
    draft: false,
    headRef: 'feature',
    baseRef,
    headSha: null,
    baseSha,
    attribution: { userId: null, displayName: null } as any,
    createdAt: null,
    mergedAt: null,
  })

  test('keeps upstream\'s base when the repository has that commit', async () => {
    const resolved = await resolveBaseShas(repo, [pull(1, older, 'main')])

    expect(resolved.get(1)).toBe(older)
  })

  /*
   * The case this exists for. `base.sha` is the base branch's tip when the
   * pull request was opened, and a mirror never fetches it - so stored
   * unchanged it gives a row that looks complete and a diff that dies with
   * `fatal: Invalid symmetric difference expression`.
   */
  test('falls back to the local branch tip when it does not', async () => {
    const resolved = await resolveBaseShas(repo, [pull(2, ABSENT, 'main')])

    expect(resolved.get(2)).toBe(mainTip)
  })

  test('and records nothing when neither resolves, rather than a commit nobody has', async () => {
    const resolved = await resolveBaseShas(repo, [pull(3, ABSENT, 'no-such-branch')])

    expect(resolved.get(3)).toBeNull()
  })

  test('answers for every pull request in one pass', async () => {
    const resolved = await resolveBaseShas(repo, [
      pull(10, older, 'main'),
      pull(11, ABSENT, 'main'),
      pull(12, ABSENT, 'gone'),
    ])

    expect([...resolved.entries()].sort()).toEqual([[10, older], [11, mainTip], [12, null]])
  })
})

describe('proposalRefspec', () => {
  test('knows where each forge publishes a proposal', () => {
    expect(proposalRefspec('github')).toBe('+refs/pull/*/head:refs/pull/*/head')
    expect(proposalRefspec('gitea')).toBe('+refs/pull/*/head:refs/pull/*/head')
    expect(proposalRefspec('forgejo')).toBe('+refs/pull/*/head:refs/pull/*/head')
    expect(proposalRefspec('gitlab')).toBe('+refs/merge-requests/*/head:refs/merge-requests/*/head')
  })

  // A plain git remote has no proposals, and handing its server a refspec it
  // does not publish fails the whole fetch - including the branches.
  test('and asks a plain remote for nothing it does not have', () => {
    expect(proposalRefspec('git')).toBeNull()
    expect(proposalRefspec(null)).toBeNull()
    expect(proposalRefspec('')).toBeNull()
  })
})
