// Stopping one repository from holding the whole fleet.
//
// The queue is first-in, first-out and that is right, until a monorepository's
// push fans out into eighty jobs - and then everybody else's one-job build
// waits behind all eighty. That is not the queue misbehaving; it is the queue
// working as written, and it is what makes a shared instance feel broken to
// everyone except the team that owns the busy repository.

import { describe, expect, test } from 'bun:test'
import { fairOrder, withinQuota } from '../../app/Actions/Runner/quota'
import { fairQueueing, maxRunningPerOwner, maxRunningPerRepository } from '../../config/ci-quotas'

function load(byRepository: Record<number, number>, byOwner: Record<number, number> = {}) {
  return {
    byRepository: new Map(Object.entries(byRepository).map(([id, held]) => [Number(id), held])),
    byOwner: new Map(Object.entries(byOwner).map(([id, held]) => [Number(id), held])),
  }
}

describe('the settings', () => {
  test('are off by default, because on a single-team instance a ceiling only gets in the way', () => {
    expect(maxRunningPerRepository({})).toBe(0)
    expect(maxRunningPerOwner({})).toBe(0)
  })

  test('and fairness is on, because it costs nothing when nobody is competing', () => {
    expect(fairQueueing({})).toBe(true)
    expect(fairQueueing({ CI_FAIR_QUEUEING: 'off' })).toBe(false)
  })

  test('with a number that is not one meaning no limit rather than a limit of nothing', () => {
    // The safe direction: a misread ceiling that blocked every job would take
    // CI offline on a typo.
    expect(maxRunningPerRepository({ CI_MAX_RUNNING_PER_REPOSITORY: 'ten' })).toBe(0)
    expect(maxRunningPerRepository({ CI_MAX_RUNNING_PER_REPOSITORY: '-4' })).toBe(0)
    expect(maxRunningPerRepository({ CI_MAX_RUNNING_PER_REPOSITORY: '10' })).toBe(10)
  })
})

describe('the ceiling', () => {
  test('lets everything through when nobody configured one', () => {
    expect(withinQuota(load({ 1: 500 }, { 9: 500 }), { repositoryId: 1, ownerId: 9 })).toBe(true)
  })

  test('refuses a repository that is already holding its share', () => {
    const before = process.env.CI_MAX_RUNNING_PER_REPOSITORY

    process.env.CI_MAX_RUNNING_PER_REPOSITORY = '4'

    try {
      expect(withinQuota(load({ 1: 3 }), { repositoryId: 1, ownerId: 9 })).toBe(true)
      expect(withinQuota(load({ 1: 4 }), { repositoryId: 1, ownerId: 9 })).toBe(false)
      // Somebody else's repository is unaffected, which is the entire purpose.
      expect(withinQuota(load({ 1: 4 }), { repositoryId: 2, ownerId: 9 })).toBe(true)
    }
    finally {
      if (before === undefined)
        delete process.env.CI_MAX_RUNNING_PER_REPOSITORY
      else
        process.env.CI_MAX_RUNNING_PER_REPOSITORY = before
    }
  })

  test('and an owner ceiling, which is the one a per-repository limit cannot cover', () => {
    /*
     * A limit per repository does nothing against an owner with forty of them,
     * which is the shape a monorepository becomes after somebody splits it.
     */
    const before = process.env.CI_MAX_RUNNING_PER_OWNER

    process.env.CI_MAX_RUNNING_PER_OWNER = '10'

    try {
      expect(withinQuota(load({ 1: 1 }, { 9: 10 }), { repositoryId: 1, ownerId: 9 })).toBe(false)
      expect(withinQuota(load({ 1: 1 }, { 9: 10 }), { repositoryId: 1, ownerId: 8 })).toBe(true)
    }
    finally {
      if (before === undefined)
        delete process.env.CI_MAX_RUNNING_PER_OWNER
      else
        process.env.CI_MAX_RUNNING_PER_OWNER = before
    }
  })
})

describe('fair queueing', () => {
  test('offers the repository holding fewer machines first', () => {
    const rows = [
      { id: 1, repository_id: 7 },
      { id: 2, repository_id: 7 },
      { id: 3, repository_id: 8 },
    ]

    // Repository 7 is holding eighty; 8 is holding none. The one-job build goes
    // first, which is the whole point.
    expect(fairOrder(rows, load({ 7: 80, 8: 0 })).map(one => one.id)).toEqual([3, 1, 2])
  })

  test('and leaves a repository\'s own order exactly as the queue gave it', () => {
    /*
     * The part that makes this safe. The candidates arrive in priority order
     * with age breaking the tie, so a deploy beats a test inside one
     * repository - fairness between teams is not a licence to reorder within
     * one.
     */
    const rows = [
      { id: 10, repository_id: 7 },
      { id: 11, repository_id: 7 },
      { id: 12, repository_id: 7 },
    ]

    expect(fairOrder(rows, load({ 7: 3 })).map(one => one.id)).toEqual([10, 11, 12])
  })

  test('and changes nothing when only one repository is pushing', () => {
    const rows = [{ id: 1, repository_id: 7 }, { id: 2, repository_id: 7 }]

    expect(fairOrder(rows, load({})).map(one => one.id)).toEqual([1, 2])
  })
})
