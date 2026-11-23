// Stopping one repository from holding the whole fleet.
//
// The queue is first-in, first-out and that is right, until a monorepository's
// push fans out into eighty jobs - and then everybody else's one-job build
// waits behind all eighty. That is not the queue misbehaving; it is the queue
// working as written, and it is what makes a shared instance feel broken to
// everyone except the team that owns the busy repository.

import { describe, expect, test } from 'bun:test'
import { fairOrder, loadOf, withinQuota } from '../../app/Actions/Runner/quota'
import { DEFAULT_QUEUE_TIMEOUT_HOURS, fairQueueing, maxRunningPerOwner, maxRunningPerRepository, queueTimeoutHours } from '../../config/ci-quotas'

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

  test('counts only the machines the asking runner stands for', () => {
    /*
     * Repository 7 runs its tests on the Mac and its lint on Linux. Its Mac
     * job is running; nothing of its own is on Linux. Repository 8 has nothing
     * running anywhere. To the Linux runner the two hold the same - none - so
     * the queue's own order stands and 7's older lint goes first. Counted
     * across the whole fleet, 7 "held a machine" and waited behind 8 for as
     * long as its Mac stayed busy.
     */
    const running = [{ repository_id: 7, owner_id: 1, runs_on: 'self-hosted\nmacos-arm64\nmobile' }]
    const queued = [
      { id: 1, repository_id: 7 },
      { id: 2, repository_id: 8 },
    ]
    const linux = ['self-hosted', 'linux-x64', 'owned-linux']
    const mac = ['self-hosted', 'macos-arm64', 'mobile']

    expect(fairOrder(queued, loadOf(running, linux)).map(one => one.id)).toEqual([1, 2])
    // The Mac itself still sees what 7 holds of it, and offers 8 first.
    expect(fairOrder(queued, loadOf(running, mac)).map(one => one.id)).toEqual([2, 1])
    // A job a runner could have taken counts, whichever machine took it.
    expect(loadOf([{ repository_id: 7, owner_id: 1, runs_on: 'self-hosted' }], linux).byRepositoryHere?.get(7)).toBe(1)
    // The ceilings are about the whole fleet and keep counting everything.
    expect(loadOf(running, linux).byRepository.get(7)).toBe(1)
    expect(loadOf(running, linux).byOwner.get(1)).toBe(1)
    // Nobody said which runner is asking: the whole fleet, as before.
    expect(fairOrder(queued, loadOf(running)).map(one => one.id)).toEqual([2, 1])
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

describe('the queue timeout', () => {
  test('is Actions\' 24 hours when nobody sets one', () => {
    expect(DEFAULT_QUEUE_TIMEOUT_HOURS).toBe(24)
    expect(queueTimeoutHours({})).toBe(24)
    expect(queueTimeoutHours({ CI_QUEUE_TIMEOUT_HOURS: ' ' })).toBe(24)
  })

  test('takes an operator\'s value, fractions included', () => {
    expect(queueTimeoutHours({ CI_QUEUE_TIMEOUT_HOURS: '6' })).toBe(6)
    expect(queueTimeoutHours({ CI_QUEUE_TIMEOUT_HOURS: '0.5' })).toBe(0.5)
  })

  test('and is off for zero or anything that is not a positive number', () => {
    expect(queueTimeoutHours({ CI_QUEUE_TIMEOUT_HOURS: '0' })).toBe(0)
    expect(queueTimeoutHours({ CI_QUEUE_TIMEOUT_HOURS: '-3' })).toBe(0)
    expect(queueTimeoutHours({ CI_QUEUE_TIMEOUT_HOURS: 'soon' })).toBe(0)
  })
})
