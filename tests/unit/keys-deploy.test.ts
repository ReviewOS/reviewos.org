// A key that belongs to a repository rather than to a person.
//
// Two rules carry this feature and both fail silently when they are wrong.
//
// **One fingerprint, one identity.** The SSH transport picks who is connecting
// from the fingerprint alone - there is nothing else on the wire - so a
// fingerprint matching both an account key and a deploy key would make "who
// pushed this" depend on which query ran first. A personal key must therefore
// never become a deploy key, and a deploy key never a second repository's.
//
// **Read-only unless asked.** A default that does not hold is not a default,
// and the thing it is protecting against is a build server nobody watches
// rewriting history.
//
// The scope rules below are pure, so they are pinned here. That they hold over
// the real SSH transport is `tests/e2e/git-ssh.test.ts`.

import { describe, expect, test } from 'bun:test'
import { deployKeyMay } from '../../app/Actions/Keys/deploy'

const key = { id: 1, repositoryId: 7, canWrite: false }

describe('deployKeyMay', () => {
  test('reads the repository it belongs to', () => {
    expect(deployKeyMay(key, 7, 'upload-pack')).toBe(true)
  })

  test('reads no other repository', () => {
    // The failure that would be invisible: a public repository is readable by
    // anybody, so a deploy key falling through to the anonymous answer would
    // clone it happily and nothing would look wrong until somebody noticed one
    // key opening every repository on the instance.
    expect(deployKeyMay(key, 8, 'upload-pack')).toBe(false)
  })

  test('does not push by default', () => {
    expect(deployKeyMay(key, 7, 'receive-pack')).toBe(false)
  })

  test('pushes when it was granted write', () => {
    expect(deployKeyMay({ ...key, canWrite: true }, 7, 'receive-pack')).toBe(true)
  })

  test('still pushes nowhere else, even with write', () => {
    // Write is a permission on *this* repository, not a permission generally.
    expect(deployKeyMay({ ...key, canWrite: true }, 8, 'receive-pack')).toBe(false)
    expect(deployKeyMay({ ...key, canWrite: true }, 8, 'upload-pack')).toBe(false)
  })

  test('compares the repository by identity, not by looseness', () => {
    // A string id arriving from a row would otherwise pass `==` and fail `===`
    // - or worse, the other way round. The caller converts with Number(); this
    // is the assertion that it has to.
    expect(deployKeyMay(key, Number('7'), 'upload-pack')).toBe(true)
    expect(deployKeyMay(key, Number.NaN, 'upload-pack')).toBe(false)
  })
})
