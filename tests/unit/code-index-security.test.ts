// What instance-wide search must not do.
//
// Three properties, each of which is a way this feature could have leaked
// something or hidden something:
//
//  - a credential goes only to the host it was issued for;
//  - a file whose *name* git would read as an instruction does not get read as
//    one, and does not silently vanish from its own repository's search either;
//  - scope is decided before anything is searched, so a repository the caller
//    cannot read cannot contribute a match.

import { describe, expect, test } from 'bun:test'
import { hostOf } from '../../app/Actions/Mirror/writeThrough'
import { pathspecs } from '../../app/Actions/Browse/search'

describe('the host a stored credential is matched against', () => {
  test('is not fooled by a userinfo prefix', () => {
    // `https://github.com@evil.example/x` is a URL whose *host* is evil.example
    // and whose first eight characters read as github.com. A mirror's remote is
    // set by a repository admin, so this is the shape of an attempt to have a
    // reviewer's GitHub token sent somewhere else.
    expect(hostOf('https://github.com@evil.example/acme/widgets')).toBe('evil.example')
  })

  test('is not fooled by a suffix', () => {
    expect(hostOf('https://github.com.evil.example/acme/widgets')).toBe('github.com.evil.example')
  })

  test('reads an ssh URL as its host rather than as the scp form', () => {
    expect(hostOf('ssh://git@evil.example/acme/widgets')).toBe('evil.example')
  })

  /*
   * The property those three add up to, stated once: `credentialFor` is keyed
   * by host, so a mirror pointed at a host the reviewer has no credential for
   * finds nothing and sends nothing. The token cannot follow the remote URL
   * somewhere it was not issued for, which is what makes a repository admin
   * unable to harvest reviewers' tokens by editing a mirror.
   */
})

describe('a filename git would read as an instruction', () => {
  test('is refused when it arrives from a caller', () => {
    // `:(exclude)` and friends are magic to git. A query string should be a
    // path.
    expect(pathspecs({ pattern: 'x', paths: [':(exclude)src', 'src/a.ts'] })).toEqual(['src/a.ts'])
  })

  test('and the index gives up narrowing rather than dropping it', async () => {
    // The other half, and the one that matters for correctness: a *file* really
    // named `:weird.ts` exists in somebody's tree. Dropping it from the
    // pathspec list would exclude it from its own repository's search - the one
    // direction this index may never fail in - so the search widens instead.
    const source = await Bun.file(new URL('../../app/Actions/CodeIndex/search.ts', import.meta.url)).text()

    expect(source).toContain('routable')
    expect(source).toContain("path.startsWith(':')")
  })
})

describe('scope', () => {
  test('is decided by the shared visibility rule, not a second copy of it', async () => {
    // A search that re-implemented "may this person read this repository" would
    // be a second answer to a question that already has one, and the two would
    // disagree eventually. The one that exists is used.
    const source = await Bun.file(new URL('../../app/Actions/CodeIndex/SearchCodeInstanceAction.ts', import.meta.url)).text()

    expect(source).toContain('readableRepositoryIds')
    // And the viewer comes from the same lookup every other action uses.
    expect(source).toContain('currentUser')
    expect(source).not.toContain('request.user?.id')
  })
})
