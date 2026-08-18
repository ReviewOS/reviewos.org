// Calling a workflow in another repository.
//
// The half that was refused rather than half-built, because it needed a policy:
// which repositories may be called. Answering it here answers it once - the
// cross-repository *trigger* is the same question, and two rules for one
// boundary is how one of them ends up wrong.

import { describe, expect, test } from 'bun:test'
import { callScope, mayCall, parseRemoteCall } from '../../app/Actions/Workflow/reusable'
import { SETTINGS } from '../../app/Ops/settings'

const acme = { ownerType: 'organization', ownerId: 4 }
const other = { ownerType: 'organization', ownerId: 9 }

describe('reading the reference', () => {
  test('owner, repository, path and ref', () => {
    expect(parseRemoteCall('acme/shared/.github/workflows/build.yml@v2')).toEqual({
      owner: 'acme',
      repository: 'shared',
      path: '.github/workflows/build.yml',
      ref: 'v2',
    })
  })

  test('a ref is optional, because a workflow may live on the default branch', () => {
    expect(parseRemoteCall('acme/shared/build.yml')?.ref).toBe('')
  })

  test('and anything shorter is a local path somebody forgot to write `./` in front of', () => {
    expect(parseRemoteCall('build.yml')).toBeNull()
    expect(parseRemoteCall('acme/shared')).toBeNull()
  })
})

describe('who may be called', () => {
  test('the same owner, always', () => {
    // The case people actually have: an organization calling its own shared
    // workflow, safe with no configuration because a repository under one
    // owner can already be read by anybody who can read that owner.
    expect(mayCall({ caller: acme, target: { ...acme, visibility: 'private' }, scope: 'same-owner' }).ok).toBe(true)
  })

  test('another owner, only when the instance was widened', () => {
    const narrow = mayCall({ caller: acme, target: { ...other, visibility: 'public' }, scope: 'same-owner' })

    expect(narrow.ok).toBe(false)
    // Named, so an administrator reading a failed run knows which setting
    // decides rather than concluding the feature is broken.
    expect(narrow.reason).toContain('workflow_call_scope')

    expect(mayCall({ caller: acme, target: { ...other, visibility: 'public' }, scope: 'instance' }).ok).toBe(true)
  })

  test('and another owner\'s private repository is never callable', () => {
    /*
     * Even with the wide scope. Its jobs would run against a definition nobody
     * outside can read, and "I cannot see the file that ran" is the shape of a
     * supply-chain problem rather than a convenience.
     */
    const refused = mayCall({ caller: acme, target: { ...other, visibility: 'private' }, scope: 'instance' })

    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain('never callable')
  })
})

describe('the setting', () => {
  test('defaults to the narrow answer, and an unreadable value stays narrow', () => {
    // The safe direction: a database this cannot read must not widen who may
    // call what.
    expect(callScope(undefined)).toBe('same-owner')
    expect(callScope('nonsense')).toBe('same-owner')
    expect(callScope('instance')).toBe('instance')
  })

  test('and is a real instance setting an administrator can change', () => {
    expect(SETTINGS.workflow_call_scope.fallback).toBe('same-owner')
    expect(SETTINGS.workflow_call_scope.allowed).toEqual(['same-owner', 'instance'])
    expect(SETTINGS.workflow_call_scope.enforcedIn).toContain('reusable.ts')
  })
})
