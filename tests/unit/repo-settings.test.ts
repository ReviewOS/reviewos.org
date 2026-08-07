// What can be changed about a repository, and what changing it costs.
//
// None of these is a field assignment. A rename moves a directory and breaks
// every clone URL somebody has written down; a visibility change can expose
// work; a transfer moves the repository into a permission structure it has
// never been under; a delete is the one thing nobody gets to undo. So the rules
// are pure and tested here, and the actions do the disk work against answers
// they did not have to work out.

import { describe, expect, test } from 'bun:test'
import {
  allowedWhileArchived,
  decideSettings,
  decideTransfer,
  forkName,
  isUsableName,
  retiredPath,
  VISIBILITIES,
} from '../../app/Actions/Repo/settings'

const current = { name: 'app', is_archived: false }

describe('decideSettings', () => {
  test('takes a rename and says what it was called', () => {
    const decision = decideSettings(current, { name: 'application' })

    expect(decision).toEqual({ ok: true, changes: { name: 'application' }, renamedFrom: 'app' })
  })

  test('a rename to the same name changes nothing, so there is nothing to move', () => {
    expect(decideSettings(current, { name: 'app', description: 'x' }))
      .toEqual({ ok: true, changes: { description: 'x' }, renamedFrom: undefined })
  })

  /**
   * A name is a directory on disk, so this rule and the path builder can never
   * disagree: a name accepted here and refused there would be a row with no
   * repository behind it.
   */
  test('refuses a name that cannot be a directory', () => {
    for (const name of ['..', '.hidden', 'a/b', '', 'a b', 'x'.repeat(101)])
      expect(decideSettings(current, { name }).ok, name).toBe(false)
  })

  /** Absent leaves it alone; empty clears it. A form that submits everything
   * would otherwise wipe what it did not show. */
  test('tells an absent description from an empty one', () => {
    expect(decideSettings(current, { description: '' })).toMatchObject({ changes: { description: null } })
    expect(decideSettings(current, { name: 'app2' })).toMatchObject({ changes: { name: 'app2' } })
    expect((decideSettings(current, { name: 'app2' }) as any).changes.description).toBeUndefined()
  })

  test('refuses a description nobody will read', () => {
    expect(decideSettings(current, { description: 'x'.repeat(501) }).ok).toBe(false)
  })

  test('takes the three visibilities and nothing else', () => {
    for (const visibility of VISIBILITIES)
      expect(decideSettings(current, { visibility }).ok, visibility).toBe(true)

    expect(decideSettings(current, { visibility: 'secret' }).ok).toBe(false)
  })

  test('takes a branch name but not a ref', () => {
    expect(decideSettings(current, { default_branch: 'main' }).ok).toBe(true)
    expect(decideSettings(current, { default_branch: 'release/1.0' }).ok).toBe(true)
    expect(decideSettings(current, { default_branch: 'refs/heads/main' }).ok).toBe(false)
    expect(decideSettings(current, { default_branch: '' }).ok).toBe(false)
  })

  test('takes the two flags', () => {
    expect(decideSettings(current, { is_archived: true })).toMatchObject({ changes: { is_archived: true } })
    expect(decideSettings(current, { is_template: true })).toMatchObject({ changes: { is_template: true } })
  })

  test('refuses a request that would change nothing', () => {
    expect(decideSettings(current, {})).toMatchObject({ ok: false, status: 422 })
  })

  /**
   * The merge strategies. Turning every one of them off is allowed - it means
   * nothing merges through the interface - and a default the booleans disallow
   * is tolerated at rest, because the merge action refuses it at merge time
   * rather than substituting a strategy nobody chose. Both rules are the
   * model's; this holds the decision to them.
   */
  test('takes the merge strategy flags, including all of them off', () => {
    expect(decideSettings(current, { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false }))
      .toMatchObject({ changes: { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false } })

    expect(decideSettings(current, { delete_branch_on_merge: true }))
      .toMatchObject({ changes: { delete_branch_on_merge: true } })
  })

  test('takes a default strategy it knows and refuses one it does not', () => {
    expect(decideSettings(current, { default_merge_strategy: 'squash' }))
      .toMatchObject({ changes: { default_merge_strategy: 'squash' } })

    expect(decideSettings(current, { default_merge_strategy: 'Rebase' }))
      .toMatchObject({ changes: { default_merge_strategy: 'rebase' } })

    expect(decideSettings(current, { default_merge_strategy: 'octopus' }))
      .toMatchObject({ ok: false, status: 422 })
  })

  test('a default the booleans disallow is stored, not swapped', () => {
    const decision = decideSettings(current, { allow_squash_merge: false, default_merge_strategy: 'squash' })

    expect(decision).toMatchObject({
      changes: { allow_squash_merge: false, default_merge_strategy: 'squash' },
    })
  })
})

/**
 * Archived means readable and frozen. The one change that must always be
 * allowed is the one that unfreezes it - otherwise archiving is irreversible,
 * which is not what anybody means by archiving.
 */
describe('allowedWhileArchived', () => {
  test('allows unarchiving and nothing else', () => {
    expect(allowedWhileArchived({ is_archived: false })).toBe(true)
    expect(allowedWhileArchived({ is_archived: true })).toBe(false)
    expect(allowedWhileArchived({ is_archived: false, name: 'other' })).toBe(false)
    expect(allowedWhileArchived({ description: 'x' })).toBe(false)
  })
})

/**
 * The difference between "deleted the wrong repository" and "deleted the wrong
 * repository and it is gone" is the difference between a bad afternoon and an
 * unrecoverable one.
 */
describe('retiredPath', () => {
  const at = Date.parse('2026-08-05T19:30:00.000Z')

  test('moves it aside under a timestamp rather than unlinking it', () => {
    expect(retiredPath('acme', 'app', at))
      .toBe('storage/repos-deleted/acme/app.2026-08-05T19-30-00-000Z.git')
  })

  test('the timestamp sorts, so the newest deletion is findable by name', () => {
    const earlier = retiredPath('acme', 'app', at)!
    const later = retiredPath('acme', 'app', at + 60_000)!

    expect([later, earlier].sort()).toEqual([earlier, later])
  })

  test('two deletions of the same name do not collide', () => {
    expect(retiredPath('acme', 'app', at)).not.toBe(retiredPath('acme', 'app', at + 1000))
  })

  test('refuses to build a path out of anything that is not a name', () => {
    expect(retiredPath('..', 'app', at)).toBeNull()
    expect(retiredPath('acme', 'a/b', at)).toBeNull()
  })
})

describe('decideTransfer', () => {
  const repository = { name: 'app', owner_type: 'user', owner_id: 7, is_archived: false }
  const target = { kind: 'organization' as const, id: 3, handle: 'acme' }

  test('moves it, and says where it lands on disk', () => {
    expect(decideTransfer(repository, target, false)).toEqual({ ok: true, diskPath: 'acme/app.git' })
  })

  /** The disk move would collide with the directory it is moving out of. */
  test('refuses a transfer to the owner it already has', () => {
    expect(decideTransfer(repository, { kind: 'user', id: 7, handle: 'chris' }, false))
      .toMatchObject({ ok: false, status: 422 })
  })

  test('refuses when the name is taken there, and says whose', () => {
    const decision = decideTransfer(repository, target, true)

    expect(decision.ok).toBe(false)
    expect((decision as any).error).toContain('acme')
    expect((decision as any).error).toContain('app')
  })

  test('refuses to transfer an archived repository, because frozen is frozen', () => {
    expect(decideTransfer({ ...repository, is_archived: true }, target, false))
      .toMatchObject({ ok: false, status: 409 })
  })

  test('a user and an organization with the same id are different owners', () => {
    expect(decideTransfer(repository, { kind: 'organization', id: 7, handle: 'acme' }, false).ok).toBe(true)
  })
})

describe('forkName', () => {
  test('keeps the name when it is free', () => {
    expect(forkName('app', [])).toBe('app')
  })

  /**
   * Refusing on a collision would refuse the most common fork there is: the
   * second fork of a popular repository into an account that already has one.
   */
  test('suffixes when it is taken', () => {
    expect(forkName('app', ['app'])).toBe('app-2')
    expect(forkName('app', ['app', 'app-2'])).toBe('app-3')
  })

  test('compares without case, because the filesystem may not', () => {
    expect(forkName('App', ['app'])).toBe('App-2')
  })

  test('gives up rather than looping forever', () => {
    const taken = ['app', ...Array.from({ length: 60 }, (_, index) => `app-${index + 2}`)]

    expect(forkName('app', taken)).toBeNull()
  })

  test('refuses a source name that is not usable', () => {
    expect(forkName('..', [])).toBeNull()
  })
})

describe('isUsableName', () => {
  test('agrees with what a directory can be called', () => {
    expect(isUsableName('my-repo.js')).toBe(true)
    expect(isUsableName('..')).toBe(false)
    expect(isUsableName('.git')).toBe(false)
  })
})
