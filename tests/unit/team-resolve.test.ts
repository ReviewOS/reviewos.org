import { describe, expect, it } from 'bun:test'
import { effectiveTeams, grantsOn } from '../../app/Actions/Team/resolve'

/**
 * Which teams a person effectively belongs to, and what those teams reach.
 *
 * This is the security boundary, so it is tested as a pure function against
 * literals rather than through a database. The rules it encodes are the kind
 * where being wrong in one direction is a disclosure and in the other is a
 * support ticket, and only one of those gets reported.
 */

/** A tree, written the way it reads: child -> parent. */
function tree(pairs: Record<number, number | null>) {
  return Object.entries(pairs).map(([id, parent]) => ({ id: Number(id), parentTeamId: parent }))
}

describe('inheritance runs downward', () => {
  // platform
  //   └── reviewers
  //         └── oncall
  const teams = tree({ 1: null, 2: 1, 3: 2 })

  it('a member of a child gets its ancestors', () => {
    // "The reviewers team is part of platform" is how people describe it, and
    // it means reviewers can reach what platform can.
    expect(effectiveTeams([2], teams)).toEqual([1, 2])
  })

  it('through more than one level', () => {
    expect(effectiveTeams([3], teams)).toEqual([1, 2, 3])
  })

  it('a member of a parent gets nothing from the child', () => {
    // The direction that matters. Reversing it would silently widen every
    // parent team the day somebody creates a narrow child under it.
    expect(effectiveTeams([1], teams)).toEqual([1])
  })

  it('a team with no parent is only itself', () => {
    expect(effectiveTeams([1], tree({ 1: null }))).toEqual([1])
  })
})

describe('somebody in two teams', () => {
  it('gets both, and both their ancestors', () => {
    // platform > reviewers, and design > brand
    const teams = tree({ 1: null, 2: 1, 10: null, 11: 10 })

    expect(effectiveTeams([2, 11], teams)).toEqual([1, 2, 10, 11])
  })

  it('does not double-count a shared ancestor', () => {
    const teams = tree({ 1: null, 2: 1, 3: 1 })

    expect(effectiveTeams([2, 3], teams)).toEqual([1, 2, 3])
  })
})

describe('a tree that is not a tree', () => {
  it('a cycle terminates rather than hanging', () => {
    // `parent_team_id` is a plain column and nothing stops two writes closing a
    // loop. Walking it without a visited set is an infinite loop *inside a
    // permission check* - the request never answers rather than answering
    // wrongly, and both are bad.
    const teams = tree({ 1: 2, 2: 1 })

    expect(effectiveTeams([1], teams)).toEqual([1, 2])
  })

  it('a longer loop does too', () => {
    const teams = tree({ 1: 3, 2: 1, 3: 2 })

    expect(effectiveTeams([1], teams)).toEqual([1, 2, 3])
  })

  it('a team whose parent does not exist stops there', () => {
    // A parent deleted by something that did not re-parent its children. The
    // walk must end rather than throw inside an access check.
    expect(effectiveTeams([2], tree({ 2: 99 }))).toEqual([2])
  })

  it('a membership in a team that does not exist is not a crash', () => {
    expect(effectiveTeams([42], tree({ 1: null }))).toEqual([42])
  })
})

describe('what those teams grant', () => {
  const grants = [
    { teamId: 1, repositoryId: 100, permission: 'read' as const },
    { teamId: 2, repositoryId: 100, permission: 'write' as const },
    { teamId: 2, repositoryId: 200, permission: 'admin' as const },
    { teamId: 9, repositoryId: 100, permission: 'admin' as const },
  ]

  it('only for the repository asked about', () => {
    expect(grantsOn(100, [2], grants)).toEqual(['write'])
  })

  it('only from teams the person is in', () => {
    // Team 9 has admin on this repository and the person is not in it.
    expect(grantsOn(100, [1, 2], grants).sort()).toEqual(['read', 'write'])
  })

  it('returns every grant rather than the highest', () => {
    // The caller unions these with the collaborator and organization grants and
    // takes the most permissive of all of them at once. Reducing here would be
    // a second place deciding which permission wins.
    expect(grantsOn(100, [1, 2], grants)).toHaveLength(2)
  })

  it('is empty when the person is in no teams', () => {
    expect(grantsOn(100, [], grants)).toEqual([])
  })

  it('is empty when their teams reach nothing here', () => {
    expect(grantsOn(300, [1, 2], grants)).toEqual([])
  })
})
