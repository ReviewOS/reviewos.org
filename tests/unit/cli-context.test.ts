/**
 * Working out where the CLI is pointed.
 *
 * A remote URL has three spellings for the same repository, and a contributor
 * who cloned over ssh and one who cloned over https are working on the same
 * thing. The CLI must not disagree about that, and URL parsing is exactly the
 * part that is wrong in an edge case somebody hits on their first day.
 *
 * The rest of the CLI is git and HTTP, and is tested where those run. This is
 * the piece that is pure and worth pinning.
 */

import { describe, expect, it } from 'bun:test'
import { parseRemote } from '../../app/Cli/context'
import { keychainFor, tokenFor } from '../../app/Cli/keychain'

describe('reading a remote', () => {
  it('reads an https remote', () => {
    expect(parseRemote('https://reviewos.org/acme/api.git')).toEqual({
      instance: 'https://reviewos.org',
      owner: 'acme',
      repository: 'api',
    })
  })

  it('reads the same repository cloned over ssh', () => {
    // The `git@host:owner/repo` form, which is not a URL and does not parse as
    // one. Two people on one repository must not get two answers.
    expect(parseRemote('git@reviewos.org:acme/api.git')).toEqual({
      instance: 'https://reviewos.org',
      owner: 'acme',
      repository: 'api',
    })
  })

  it('and over ssh:// with an explicit scheme', () => {
    expect(parseRemote('ssh://git@reviewos.org/acme/api')).toEqual({
      instance: 'https://reviewos.org',
      owner: 'acme',
      repository: 'api',
    })
  })

  it('keeps http and the port for a development instance', () => {
    /*
     * The API is served over HTTP, so assuming the same *host* as the remote is
     * right and assuming https is not: a local instance on port 3000 would be
     * rewritten to a URL pointing at nothing, and the failure reads as the CLI
     * being broken rather than as a scheme it guessed.
     */
    expect(parseRemote('http://localhost:3000/acme/api.git')).toEqual({
      instance: 'http://localhost:3000',
      owner: 'acme',
      repository: 'api',
    })
  })

  it('tolerates a missing .git suffix', () => {
    expect(parseRemote('https://reviewos.org/acme/api')?.repository).toBe('api')
  })

  it('takes the last two segments when a path is deeper', () => {
    // An instance mounted under a prefix. The owner and the repository are
    // always the last two, and guessing which of the earlier ones is the owner
    // would be a guess.
    expect(parseRemote('https://example.com/git/acme/api.git')).toEqual({
      instance: 'https://example.com',
      owner: 'acme',
      repository: 'api',
    })
  })

  it('answers null for something that is not a remote', () => {
    // Null, rather than a half-parsed answer. A command that then asks the
    // wrong instance about the wrong repository is worse than one that says it
    // does not know where it is.
    expect(parseRemote('')).toBeNull()
    expect(parseRemote('not a url at all')).toBeNull()
    expect(parseRemote('https://reviewos.org/onlyone')).toBeNull()
  })
})

describe('where the token lives', () => {
  it('uses the platform\'s own keychain', () => {
    // Each is the utility that ships with the platform rather than a dependency
    // this project adds.
    expect(keychainFor('darwin').describe()).toContain('macOS')
    expect(keychainFor('win32').describe()).toContain('Windows')
    expect(keychainFor('linux').describe()).toContain('keyring')
  })

  it('lets the environment win', async () => {
    /*
     * How CI supplies one: scoped to the job, injected by the runner's secret
     * store, never written to a disk. It also lets somebody override a stored
     * token for a single command without un-storing it first.
     */
    const found = await tokenFor('https://reviewos.org', { REVIEWOS_TOKEN: 'ros_from_env' })

    expect(found).toBe('ros_from_env')
  })

  it('ignores an empty environment variable', async () => {
    // `REVIEWOS_TOKEN=` in a shell profile is not a token, and treating it as
    // one means every command fails as unauthenticated while a perfectly good
    // token sits in the keychain.
    const keychain = keychainFor()
    const stored = await keychain.read('https://nothing-is-stored-here.invalid')

    expect(await tokenFor('https://nothing-is-stored-here.invalid', { REVIEWOS_TOKEN: '' })).toBe(stored)
  })
})
