// The wire protocol, and which repository it actually serves.
//
// This file exists because of one shipped bug that nothing else would have
// caught. `upload-pack` and `receive-pack` take the repository as their own
// positional argument and resolve it themselves - they do not read `--git-dir`
// - and the routes passed `.`, so every request operated on the server
// process's working directory instead of the repository in the URL.
//
// Everything about that looks fine from outside. git speaks the protocol
// correctly, `git clone` succeeds and checks out a real tree, `git push`
// succeeds and reports a new branch, the permission checks all pass. They pass
// on the repository that was *asked for*, and a different one is handed over:
// a clone of any URL served the forge's own source, including for private
// repositories the caller could not read.
//
// So these tests run the argument list the routes build, from a working
// directory that is a different repository, and assert the answer belongs to
// the repository that was named.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBare, serviceArgs } from '../../app/Actions/Git/git'

let root: string
/** The repository a request names. */
let wanted: string
/** The one the server process happens to be sitting in. */
let elsewhere: string

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

/** Seed a bare repository with one branch, named so it can be told apart. */
function seed(bare: string, branch: string) {
  const work = `${bare}-work`
  mkdirSync(work, { recursive: true })
  git(work, 'init', `--initial-branch=${branch}`)
  writeFileSync(join(work, `${branch}.txt`), `${branch}\n`)
  git(work, 'add', '.')
  git(work, 'commit', '-m', `${branch} commit`)
  git(work, 'remote', 'add', 'origin', bare)
  git(work, 'push', 'origin', branch)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-http-'))
  wanted = join(root, 'wanted.git')
  elsewhere = join(root, 'elsewhere.git')

  await initBare(wanted, 'alpha')
  await initBare(elsewhere, 'beta')

  seed(wanted, 'alpha')
  seed(elsewhere, 'beta')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('serviceArgs', () => {
  test('names the repository rather than the working directory', () => {
    expect(serviceArgs('/srv/repos/acme/app.git', 'upload-pack'))
      .toEqual(['upload-pack', '--stateless-rpc', '/srv/repos/acme/app.git'])
  })

  test('adds the advertisement flag before the repository', () => {
    expect(serviceArgs('/srv/repos/acme/app.git', 'receive-pack', { advertiseRefs: true }))
      .toEqual(['receive-pack', '--stateless-rpc', '--advertise-refs', '/srv/repos/acme/app.git'])
  })

  /** The bug, stated directly: `.` must never be what git is handed. */
  test('never passes a relative path', () => {
    for (const service of ['upload-pack', 'receive-pack'] as const) {
      for (const advertiseRefs of [true, false]) {
        expect(serviceArgs('/srv/repos/acme/app.git', service, { advertiseRefs }))
          .not.toContain('.')
      }
    }
  })
})

/**
 * The property that actually matters, checked the way the bug would have been
 * caught: run the real command from the wrong directory.
 */
describe('the advertisement belongs to the repository that was named', () => {
  function advertise(repositoryPath: string, cwd: string): string {
    const result = spawnSync('git', serviceArgs(repositoryPath, 'upload-pack', { advertiseRefs: true }), { cwd })

    return result.stdout.toString()
  }

  test('serves the named repository even when run from another one', () => {
    const output = advertise(wanted, elsewhere)

    expect(output).toContain('refs/heads/alpha')
    expect(output).not.toContain('refs/heads/beta')
  })

  test('and the other way round, so the test is not passing by accident', () => {
    const output = advertise(elsewhere, wanted)

    expect(output).toContain('refs/heads/beta')
    expect(output).not.toContain('refs/heads/alpha')
  })

  /**
   * The shipped behaviour, pinned as a demonstration rather than as a
   * requirement: this is what `.` did, and it is why the bug was invisible -
   * the command *works*, it just answers about somewhere else.
   */
  test('`.` answers about the working directory, which is the whole bug', () => {
    const result = spawnSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', '.'], { cwd: elsewhere })
    const output = result.stdout.toString()

    expect(output).toContain('refs/heads/beta')
    expect(output).not.toContain('refs/heads/alpha')
  })

  test('`--git-dir` does not fix it, which is why it looked correct', () => {
    const result = spawnSync(
      'git',
      ['--git-dir', wanted, 'upload-pack', '--stateless-rpc', '--advertise-refs', '.'],
      { cwd: elsewhere },
    )
    const output = result.stdout.toString()

    // Named `wanted`, answered about `elsewhere`.
    expect(output).toContain('refs/heads/beta')
    expect(output).not.toContain('refs/heads/alpha')
  })
})

/**
 * `receive-pack` has the same argument rule as `upload-pack`, and got it wrong
 * the same way - so a push over HTTP wrote its refs into the application's own
 * checkout rather than into the repository it was addressed to.
 *
 * Checked through its advertisement rather than by driving a full push: the
 * advertisement is what `receive-pack` answers about, so if it names the right
 * repository's refs it is operating on the right repository. Driving a real
 * push through the routes needs the router, the database and a listening
 * server, which is a different kind of test than this file is.
 */
describe('receive-pack resolves the repository the same way', () => {
  function advertise(repositoryPath: string, cwd: string): string {
    const result = spawnSync('git', serviceArgs(repositoryPath, 'receive-pack', { advertiseRefs: true }), { cwd })

    return result.stdout.toString()
  }

  test('answers about the named repository, not the working directory', () => {
    const output = advertise(wanted, elsewhere)

    expect(output).toContain('refs/heads/alpha')
    expect(output).not.toContain('refs/heads/beta')
  })

  test('and `.` answers about the working directory, as it did in production', () => {
    const result = spawnSync('git', ['receive-pack', '--stateless-rpc', '--advertise-refs', '.'], { cwd: elsewhere })

    expect(result.stdout.toString()).toContain('refs/heads/beta')
  })
})
