// Repository paths, git URLs, and the values handed to the git binary.
//
// These are the security boundary of the git endpoints: an owner and a
// repository name arrive from a URL and become a filesystem path and process
// arguments. The traversal cases are covered exhaustively because a hole here
// reads or writes outside the repository root.

import { describe, expect, test } from 'bun:test'
import { isFullSha, isSafeRef, isSafeRevision } from '../../app/Actions/Git/git'
import { gitService, isReadOnlyService, isSafeSegment, parseGitUrl, repositoryPath } from '../../app/Actions/Git/storage'

describe('isSafeSegment', () => {
  test('accepts ordinary owner and repository names', () => {
    expect(isSafeSegment('chris')).toBe(true)
    expect(isSafeSegment('reviewos.org')).toBe(true)
    expect(isSafeSegment('my-repo_2')).toBe(true)
  })

  test('rejects the traversal segments', () => {
    expect(isSafeSegment('.')).toBe(false)
    expect(isSafeSegment('..')).toBe(false)
  })

  test('accepts a dotted name, which is how a profile repository is spelled', () => {
    // `.profile` is where an owner writes the page their profile shows. The
    // rule used to refuse every leading dot on the grounds that it hides the
    // directory, which is true of `ls` and is not a safety property - nothing
    // here walks the repository root with a shell glob.
    expect(isSafeSegment('.profile')).toBe(true)
    expect(isSafeSegment('.github')).toBe(true)
  })

  test('still rejects `.git`, whose meaning changes with the tool reading it', () => {
    expect(isSafeSegment('.git')).toBe(false)
  })

  test('rejects a segment that is really two', () => {
    expect(isSafeSegment('a/b')).toBe(false)
    expect(isSafeSegment('a\\b')).toBe(false)
  })

  test('rejects encoded traversal, which a filter would have to guess at', () => {
    expect(isSafeSegment('%2e%2e')).toBe(false)
    expect(isSafeSegment('..%2f..')).toBe(false)
  })

  test('rejects a null byte and other control characters', () => {
    expect(isSafeSegment('a\0b')).toBe(false)
    expect(isSafeSegment('a\nb')).toBe(false)
  })

  test('rejects empty and absurdly long', () => {
    expect(isSafeSegment('')).toBe(false)
    expect(isSafeSegment('a'.repeat(101))).toBe(false)
  })
})

describe('repositoryPath', () => {
  test('builds a bare repository path under the root', () => {
    const result = repositoryPath('chris', 'reviewos', '/srv/repos')

    expect(result.ok).toBe(true)
    expect(result.relative).toBe('chris/reviewos.git')
    expect(result.path).toBe('/srv/repos/chris/reviewos.git')
  })

  test('accepts a name that already carries .git', () => {
    const result = repositoryPath('chris', 'reviewos.git', '/srv/repos')

    expect(result.relative).toBe('chris/reviewos.git')
  })

  test('refuses to escape the root through the owner', () => {
    expect(repositoryPath('..', 'repo', '/srv/repos').ok).toBe(false)
    expect(repositoryPath('../../etc', 'repo', '/srv/repos').ok).toBe(false)
  })

  test('refuses to escape the root through the name', () => {
    expect(repositoryPath('chris', '../../../etc/passwd', '/srv/repos').ok).toBe(false)
  })

  test('refuses an absolute path in either segment', () => {
    expect(repositoryPath('/etc', 'passwd', '/srv/repos').ok).toBe(false)
    expect(repositoryPath('chris', '/etc/passwd', '/srv/repos').ok).toBe(false)
  })

  test('refuses empty segments', () => {
    expect(repositoryPath('', 'repo', '/srv/repos').reason).toBe('empty')
    expect(repositoryPath('chris', '', '/srv/repos').reason).toBe('empty')
  })

  test('every rejection leaves no path behind', () => {
    for (const [owner, name] of [['..', 'r'], ['a b', 'r'], ['a', '..'], ['', 'r']] as const)
      expect(repositoryPath(owner, name, '/srv/repos').path).toBeUndefined()
  })
})

describe('parseGitUrl', () => {
  test('reads the owner and repository from a clone URL', () => {
    expect(parseGitUrl('/chris/reviewos.git/info/refs')).toEqual({
      owner: 'chris',
      name: 'reviewos',
      rest: 'info/refs',
    })
  })

  test('accepts a URL without the .git suffix', () => {
    expect(parseGitUrl('/chris/reviewos/info/refs')?.name).toBe('reviewos')
  })

  test('returns null when there is no repository in the path', () => {
    expect(parseGitUrl('/chris')).toBeNull()
    expect(parseGitUrl('/')).toBeNull()
    expect(parseGitUrl('')).toBeNull()
  })
})

describe('gitService', () => {
  test('recognises a clone advertisement', () => {
    expect(gitService('/a/b.git/info/refs', new URLSearchParams('service=git-upload-pack'))).toBe('upload-pack')
  })

  test('recognises a push advertisement', () => {
    expect(gitService('/a/b.git/info/refs', new URLSearchParams('service=git-receive-pack'))).toBe('receive-pack')
  })

  test('recognises the post endpoints', () => {
    expect(gitService('/a/b.git/git-upload-pack', new URLSearchParams())).toBe('upload-pack')
    expect(gitService('/a/b.git/git-receive-pack', new URLSearchParams())).toBe('receive-pack')
  })

  test('refuses an unknown or missing service', () => {
    expect(gitService('/a/b.git/info/refs', new URLSearchParams())).toBeNull()
    expect(gitService('/a/b.git/info/refs', new URLSearchParams('service=git-upload-archive'))).toBeNull()
    expect(gitService('/a/b.git/tree/main', new URLSearchParams())).toBeNull()
  })

  test('a read service is read-only and a push service is not', () => {
    expect(isReadOnlyService('upload-pack')).toBe(true)
    expect(isReadOnlyService('receive-pack')).toBe(false)
  })
})

describe('isSafeRef', () => {
  test('accepts ordinary branch and tag names', () => {
    expect(isSafeRef('main')).toBe(true)
    expect(isSafeRef('release/2.0')).toBe(true)
    expect(isSafeRef('refs/heads/feature-x')).toBe(true)
  })

  test('rejects the forms git itself rejects', () => {
    expect(isSafeRef('a..b')).toBe(false)
    expect(isSafeRef('/leading')).toBe(false)
    expect(isSafeRef('trailing/')).toBe(false)
    expect(isSafeRef('branch@{0}')).toBe(false)
  })

  test('rejects a name that would be read as an option', () => {
    expect(isSafeRef('--upload-pack=touch /tmp/pwned')).toBe(false)
    expect(isSafeRef('-x')).toBe(false)
  })

  test('rejects shell metacharacters, even though nothing runs a shell', () => {
    expect(isSafeRef('main; rm -rf /')).toBe(false)
    expect(isSafeRef('main$(whoami)')).toBe(false)
    expect(isSafeRef('main`id`')).toBe(false)
    expect(isSafeRef('main|cat')).toBe(false)
  })

  test('rejects empty and absurdly long', () => {
    expect(isSafeRef('')).toBe(false)
    expect(isSafeRef('a'.repeat(256))).toBe(false)
  })
})

describe('isSafeRevision', () => {
  test('accepts SHAs and revision expressions', () => {
    expect(isSafeRevision('a'.repeat(40))).toBe(true)
    expect(isSafeRevision('HEAD~3')).toBe(true)
    expect(isSafeRevision('main^')).toBe(true)
  })

  test('rejects anything that starts like an option', () => {
    expect(isSafeRevision('--output=/tmp/x')).toBe(false)
  })

  test('rejects shell metacharacters', () => {
    expect(isSafeRevision('HEAD;id')).toBe(false)
    expect(isSafeRevision('HEAD$(id)')).toBe(false)
  })
})

describe('isFullSha', () => {
  test('accepts a 40-character lowercase hex sha', () => {
    expect(isFullSha('0123456789abcdef0123456789abcdef01234567')).toBe(true)
  })

  test('rejects an abbreviated or malformed sha', () => {
    expect(isFullSha('0123456')).toBe(false)
    expect(isFullSha('0123456789ABCDEF0123456789abcdef01234567')).toBe(false)
    expect(isFullSha(`${'a'.repeat(40)}x`)).toBe(false)
  })
})
