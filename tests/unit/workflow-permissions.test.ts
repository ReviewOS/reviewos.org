// `permissions:` - what a run's token may do.
//
// The file speaks GitHub's vocabulary and this instance has its own, so the
// names are translated rather than adopted. What matters most here is the
// direction of failure: an unknown key grants nothing, a job's block replaces
// the workflow's rather than adding to it, and a workflow that says nothing
// gets a token that can read the repository and no more.

import { describe, expect, test } from 'bun:test'
import { defaultPermissions, permissionsFrom, resolvePermissions } from '../../app/Actions/Workflow/permissions'

describe('reading a permissions block', () => {
  test('translates GitHub\'s names onto this instance\'s scopes', () => {
    const read = permissionsFrom({ 'contents': 'read', 'pull-requests': 'write', 'issues': 'write' })

    expect(read?.granted).toEqual({ contents: 'read', pull_requests: 'write', issues: 'write' })
  })

  test('`none` drops a scope rather than granting it at zero', () => {
    // How a workflow keeps one permission and gives up another.
    const read = permissionsFrom({ contents: 'none', issues: 'write' })

    expect(read?.granted).toEqual({ issues: 'write' })
  })

  test('read-all and write-all are the blanket forms', () => {
    expect(permissionsFrom('read-all')?.granted.contents).toBe('read')
    expect(permissionsFrom('write-all')?.granted.contents).toBe('write')
  })

  /*
   * `write-all` on GitHub does not grant administration either, and it is the
   * scope that can change branch protection and delete the repository. Nobody
   * should get it by writing two words.
   */
  test('and neither of them grants administration', () => {
    expect(permissionsFrom('write-all')?.granted.administration).toBeUndefined()
    expect(permissionsFrom({ administration: 'write' })?.granted.administration).toBe('write')
  })

  test('an empty block is nothing at all, on purpose', () => {
    // `permissions: {}` is a real thing to write, and it is not the same as
    // the key being absent.
    expect(permissionsFrom({})?.granted).toEqual({})
    expect(permissionsFrom(null)).toBeNull()
  })

  /*
   * A real Actions permission for a feature this instance does not have. Told
   * to the author rather than dropped: a token that silently grants nothing is
   * a workflow that fails at the far end with no explanation.
   */
  test('a permission this instance cannot grant is recorded, not ignored', () => {
    const read = permissionsFrom({ 'packages': 'write', 'id-token': 'write', 'contents': 'read' })

    expect(read?.unsupported).toEqual(['packages', 'id-token'])
    expect(read?.granted).toEqual({ contents: 'read' })
  })

  test('a typo grants nothing and is not reported as unimplemented', () => {
    const read = permissionsFrom({ contnets: 'write' })

    expect(read?.granted).toEqual({})
    expect(read?.unsupported).toEqual([])
  })

  test('two keys onto one scope take the higher level', () => {
    // `statuses` and `checks` are one scope here, and a workflow asking to
    // write statuses meant it.
    expect(permissionsFrom({ checks: 'read', statuses: 'write' })?.granted.checks).toBe('write')
    expect(permissionsFrom({ statuses: 'write', checks: 'read' })?.granted.checks).toBe('write')
  })
})

describe('resolving what a job gets', () => {
  test('a workflow that says nothing gets read-only', () => {
    // Actions' own default depends on an organization setting, which is a
    // footgun this instance declines to reproduce.
    const resolved = resolvePermissions(null, null)

    expect(resolved.granted).toEqual(defaultPermissions())
    expect(resolved.granted).toEqual({ contents: 'read' })
    expect(resolved.source).toBe('default')
  })

  test('the workflow\'s block applies when the job has none', () => {
    const resolved = resolvePermissions({ issues: 'write' }, null)

    expect(resolved.granted).toEqual({ issues: 'write' })
    expect(resolved.source).toBe('workflow')
  })

  /*
   * The trap. Merging would be the friendlier reading and the wrong one: it
   * would hand a job powers its author deliberately took away.
   */
  test('a job\'s block replaces the workflow\'s rather than adding to it', () => {
    const resolved = resolvePermissions({ contents: 'write' }, { issues: 'write' })

    expect(resolved.granted).toEqual({ issues: 'write' })
    expect(resolved.granted.contents).toBeUndefined()
    expect(resolved.source).toBe('job')
  })

  test('a job asking for nothing gets nothing, not the workflow\'s', () => {
    const resolved = resolvePermissions({ contents: 'write' }, {})

    expect(resolved.granted).toEqual({})
    expect(resolved.source).toBe('job')
  })

  test('and stored JSON reads the same as a parsed object', () => {
    const resolved = resolvePermissions('{"contents":"write"}', null)

    expect(resolved.granted).toEqual({ contents: 'write' })
  })

  test('unreadable JSON falls through to the level above rather than failing', () => {
    const resolved = resolvePermissions('{"contents":"write"}', 'not json')

    expect(resolved.granted).toEqual({ contents: 'write' })
    expect(resolved.source).toBe('workflow')
  })
})
