// Where mirrored actions live, and which requests may reach them.
//
// The path is built from three untrusted strings. Everything here is about
// refusing the ones that are not what they claim to be - and anything reaching
// these checks came from somewhere other than a workflow this instance parsed,
// because the reference parser already refused the obvious forms.

import { describe, expect, test } from 'bun:test'
import { actionPath, parseActionUrl } from '../../app/Actions/Actions/store'

describe('the path for an action', () => {
  test('host, owner and name, kept apart from the repositories', () => {
    // A mirrored action is not a repository somebody owns here: no issues, no
    // pull requests, no settings page. Putting it in the repository table would
    // mean every listing and permission check growing a "but not those" clause.
    const resolved = actionPath('github.com', 'actions/checkout', 'storage/actions')

    expect(resolved.ok).toBe(true)
    expect(resolved.relative).toBe('github.com/actions/checkout.git')
    expect(String(resolved.path).endsWith('storage/actions/github.com/actions/checkout.git')).toBe(true)
  })

  test('a host with a port is a host', () => {
    expect(actionPath('code.example:8443', 'owner/name').ok).toBe(true)
  })

  test('traversal in any of the three parts is refused', () => {
    for (const attempt of [
      ['../../etc', 'owner/name'],
      ['github.com', '../../../etc/name'],
      ['github.com', 'owner/../../../etc'],
      ['github.com/..', 'owner/name'],
    ] as const) {
      expect(actionPath(attempt[0], attempt[1]).ok).toBe(false)
    }
  })

  test('and so is anything that is not `owner/name`', () => {
    expect(actionPath('github.com', 'justone').ok).toBe(false)
    expect(actionPath('github.com', 'a/b/c').ok).toBe(false)
    expect(actionPath('github.com', '').ok).toBe(false)
  })

  test('a name that is only dots is not a name', () => {
    expect(actionPath('github.com', './.').ok).toBe(false)
    expect(actionPath('github.com', 'owner/.').ok).toBe(false)
  })

  test('an absolute path is refused rather than quietly reinterpreted', () => {
    /*
     * `/etc/passwd` would survive a split-and-filter as owner `etc`, name
     * `passwd`, land inside the store, and be harmless - which is exactly why
     * it is refused. A caller passing one is confused about what this takes,
     * and answering "fine, I read it as something else" hides that until it
     * matters.
     */
    expect(actionPath('github.com', '/etc/passwd').ok).toBe(false)
    expect(actionPath('github.com', 'owner/name/').ok).toBe(false)
    expect(actionPath('github.com', 'owner//name').ok).toBe(false)
  })
})

describe('reading a request path', () => {
  test('the shape a runner\'s git asks for', () => {
    expect(parseActionUrl('/actions/github.com/actions/checkout.git/info/refs')).toEqual({
      host: 'github.com',
      repository: 'actions/checkout',
      rest: 'info/refs',
    })
  })

  test('and the upload-pack that follows it', () => {
    expect(parseActionUrl('/actions/github.com/actions/checkout.git/git-upload-pack')).toMatchObject({
      repository: 'actions/checkout',
      rest: 'git-upload-pack',
    })
  })

  test('anything that is not an action path is not one', () => {
    expect(parseActionUrl('/owner/repo.git/info/refs')).toBeNull()
    expect(parseActionUrl('/actions/github.com')).toBeNull()
    expect(parseActionUrl('/')).toBeNull()
  })
})
