// The environment a git child process runs in.
//
// This exists because of a failure with no error in it. `deps.yaml` declares
// gnupg, pantry installs it into `<project>/pantry`, and pantry's shell hook
// puts `pantry/.bin` on `PATH` when a shell `cd`s into the project. Nothing
// that is not a shell does that: a systemd unit, a Docker `CMD`, a `bun test`
// run. So `git verify-commit` answered `cannot run gpg`, this read it as
// `unavailable`, and every signature on the instance showed "Unverified" while
// the binary sat on disk, installed and declared.
//
// The half worth pinning is the *order*. Putting the project's bin first makes
// its git win over the host's, which sounds tidier and is a far larger change
// than the one this is for - it broke three wire-protocol tests. Appending
// fills a gap without taking a decision away.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { dependencyPath, gitEnvironment } from '../../app/Actions/Git/git'

describe('dependencyPath', () => {
  test('finds the project bin when there is one', () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-'))

    try {
      mkdirSync(join(root, 'pantry/.bin'), { recursive: true })
      expect(dependencyPath(root)).toBe(join(root, 'pantry/.bin'))
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('is null when there is not, rather than a path that does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-'))

    try {
      // A checkout whose dependencies live on the host. Adding a directory that
      // is not there to PATH is harmless and misleading, and this is the shape
      // most deployments have.
      expect(dependencyPath(root)).toBeNull()
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('gitEnvironment', () => {
  test('never lets a repository config or a prompt change what git does', () => {
    const environment = gitEnvironment()

    // A hung credential prompt holds the request open, and a repository that
    // can change how it is read is a repository that can read something else.
    expect(environment.GIT_TERMINAL_PROMPT).toBe('0')
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1')
  })

  test('keeps the host PATH first', () => {
    const environment = gitEnvironment()
    const host = process.env.PATH ?? ''

    // Whatever the host already resolves keeps resolving exactly as it did.
    // This is the assertion that would fail if somebody "tidied" the order.
    expect(environment.PATH.startsWith(host)).toBe(true)
  })

  test('carries what the caller adds', () => {
    // The SSH daemon passes the pusher's id this way, so a push over a
    // transport with no Authorization header is still attributed to somebody.
    expect(gitEnvironment({ REVIEWOS_ACTOR_ID: '7' }).REVIEWOS_ACTOR_ID).toBe('7')
  })

  test('will not let a caller turn the guards back off', () => {
    // The two above are not defaults to be overridden. A caller that passed
    // GIT_TERMINAL_PROMPT=1 would be asking for a request that hangs.
    const environment = gitEnvironment({ GIT_TERMINAL_PROMPT: '1', GIT_CONFIG_NOSYSTEM: '0' })

    expect(environment.GIT_TERMINAL_PROMPT).toBe('0')
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1')
  })
})
