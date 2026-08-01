import { describe, expect, it } from 'bun:test'
import { parseRemote } from '../../app/Commands/MirrorAdd'

/**
 * The remote is parsed rather than guessed at.
 *
 * A mirror points at somebody else's repository, and getting the target wrong
 * means fetching the wrong code under a name people will trust. So anything
 * that is not unambiguously `owner/name` is refused.
 */
describe('parseRemote', () => {
  it('reads a plain owner/name', () => {
    expect(parseRemote('stacksjs/stacks')).toEqual({ owner: 'stacksjs', name: 'stacks' })
  })

  it('accepts a full GitHub url, which is what people paste', () => {
    expect(parseRemote('https://github.com/stacksjs/stacks')).toEqual({ owner: 'stacksjs', name: 'stacks' })
    expect(parseRemote('https://www.github.com/stacksjs/stacks.git')).toEqual({ owner: 'stacksjs', name: 'stacks' })
  })

  it('tolerates a trailing slash and surrounding space', () => {
    expect(parseRemote('  stacksjs/stacks/  ')).toEqual({ owner: 'stacksjs', name: 'stacks' })
  })

  it('refuses anything that is not exactly two parts', () => {
    expect(parseRemote('stacks')).toBeNull()
    expect(parseRemote('a/b/c')).toBeNull()
    expect(parseRemote('')).toBeNull()
  })

  /**
   * The parsed values reach a filesystem path and a git remote url, so a name
   * that could climb out of the repository root or smuggle a shell character
   * is refused at the source rather than trusted downstream.
   */
  it('refuses path traversal and other unsafe names', () => {
    expect(parseRemote('../etc/passwd')).toBeNull()
    expect(parseRemote('owner/na me')).toBeNull()
    expect(parseRemote('owner/na;me')).toBeNull()
  })
})
