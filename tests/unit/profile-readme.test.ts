/**
 * Reading a profile page out of a repository, against real git.
 *
 * The two failures worth pinning here are both invisible from the outside: a
 * profile that does not render looks exactly like a profile nobody wrote, and
 * the page has no way to tell the reader which it was. Both were found on a
 * live instance, where `/stacks` showed nothing under a heading that said 114
 * repositories.
 *
 * Built with real git rather than a stubbed reader, because both bugs are
 * about what git does and not about what this code believes it does: git is
 * case-sensitive on the server whatever the laptop that committed the file
 * was, and `HEAD` is a real ref that a row cached wrongly.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readReadme, refsToRead } from '../../app/Actions/Profile/read'

let work = ''
let bare = ''

function git(cwd: string, ...args: string[]): void {
  spawnSync('git', args, { cwd, encoding: 'utf8' })
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'reviewos-profile-'))
  bare = join(work, 'profile.git')

  const checkout = join(work, 'checkout')
  mkdirSync(checkout)

  // `master`, deliberately: the repository row this is read through says
  // `main`, which is what a mirror is created with and what an import that
  // asked nobody records.
  git(checkout, 'init', '-q', '--initial-branch=master', '.')
  git(checkout, 'config', 'user.email', 'test@example.com')
  git(checkout, 'config', 'user.name', 'Test')

  mkdirSync(join(checkout, 'profile'))
  // Lowercase, which is what people commit and what a case-insensitive
  // filesystem lets them get away with until the file reaches a server.
  writeFileSync(join(checkout, 'profile', 'readme.md'), '# Who we are\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-qm', 'the page this organization shows')

  spawnSync('git', ['clone', '-q', '--bare', checkout, bare], { encoding: 'utf8' })
})

afterAll(() => {
  // Only the directory this file made, by the name it made it with.
  if (work)
    rmSync(work, { recursive: true, force: true })
})

describe('which refs a profile is looked for in', () => {
  test('the branch the row recorded, then what the repository itself says', () => {
    expect(refsToRead('main')).toEqual(['main', 'HEAD'])
  })

  test('a row that recorded nothing still has somewhere to look', () => {
    expect(refsToRead('')).toEqual(['HEAD'])
    expect(refsToRead(null)).toEqual(['HEAD'])
    expect(refsToRead(undefined)).toEqual(['HEAD'])
  })

  test('and a row that already says HEAD does not say it twice', () => {
    expect(refsToRead('HEAD')).toEqual(['HEAD'])
  })
})

describe('reading the file', () => {
  test('a name spelled with different case is still the file', async () => {
    const found = await readReadme(bare, 'HEAD', 'profile/README.md')

    expect(found?.path).toBe('profile/readme.md')
    expect(found?.text).toContain('Who we are')
  })

  test('the ref the row got wrong finds nothing, and HEAD finds it', async () => {
    // This is the pair, in the order `profileReadme` tries them: a mirror
    // created with `main` against an upstream on `master` rendered an empty
    // profile page for as long as nobody looked.
    expect(await readReadme(bare, 'main', 'profile/README.md')).toBeNull()
    expect(await readReadme(bare, 'HEAD', 'profile/README.md')).not.toBeNull()
  })

  test('a file that is not there is not there', async () => {
    expect(await readReadme(bare, 'HEAD', 'profile/CONTRIBUTING.md')).toBeNull()
    expect(await readReadme(bare, 'HEAD', 'README.md')).toBeNull()
  })
})
