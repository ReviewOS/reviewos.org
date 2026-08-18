// The ceiling on concurrent git processes.
//
// The properties worth pinning are the ones a load test would take an hour to
// show: limits hold per class, waiters are served in arrival order, a waiter
// that gives up leaves no debris, and a release can never free more than it
// held. The wire-protocol 503 is asserted end to end in
// tests/e2e/git-http.test.ts, through the real route.

import { describe, expect, test } from 'bun:test'
import { CountingSemaphore, gitSemaphore } from '../../app/Actions/Git/semaphore'
import { spawnGitLimited } from '../../app/Actions/Git/git'

/** Settle whatever is ready without waiting on anything that is not. */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('CountingSemaphore', () => {
  test('holds the limit: acquires past it wait', async () => {
    const semaphore = new CountingSemaphore(2)

    const first = await semaphore.acquire(50)
    const second = await semaphore.acquire(50)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(semaphore.active).toBe(2)

    let granted = false
    const third = semaphore.acquire(1_000).then((release) => {
      granted = true

      return release
    })

    await tick()
    expect(granted).toBe(false)
    expect(semaphore.waiting).toBe(1)

    first!()
    const release = await third

    expect(granted).toBe(true)
    expect(release).not.toBeNull()

    second!()
    release!()
    expect(semaphore.active).toBe(0)
  })

  test('waiters are served in arrival order', async () => {
    const semaphore = new CountingSemaphore(1)
    const holder = await semaphore.acquire(50)

    const order: number[] = []
    const waiters = [1, 2, 3].map(rank =>
      semaphore.acquire(1_000).then((release) => {
        order.push(rank)

        return release
      }),
    )

    await tick()
    holder!()

    for (const waiter of waiters)
      (await waiter)!()

    expect(order).toEqual([1, 2, 3])
    expect(semaphore.active).toBe(0)
  })

  test('a timed-out waiter is out of the queue, and its rejection leaks nothing', async () => {
    const semaphore = new CountingSemaphore(1)
    const holder = await semaphore.acquire(50)

    const refused = await semaphore.acquire(20)

    expect(refused).toBeNull()
    expect(semaphore.waiting).toBe(0)

    // The slot the holder releases must not be granted to the departed
    // waiter: the next acquire gets it, immediately.
    holder!()
    const next = await semaphore.acquire(20)

    expect(next).not.toBeNull()
    next!()
    expect(semaphore.active).toBe(0)
  })

  test('releasing twice frees one slot, not two', async () => {
    const semaphore = new CountingSemaphore(2)
    const first = await semaphore.acquire(50)
    await semaphore.acquire(50)

    first!()
    first!()

    expect(semaphore.active).toBe(1)
  })
})

describe('spawnGitLimited', () => {
  test('refuses with null when its class stays saturated', async () => {
    const semaphore = gitSemaphore('heavy')
    const held = await Promise.all(
      Array.from({ length: semaphore.limit }, () => semaphore.acquire(1_000)),
    )

    try {
      const child = await spawnGitLimited('heavy', '.', ['version'], {}, 30)

      expect(child).toBeNull()
    }
    finally {
      for (const release of held)
        release?.()
    }
  })

  test('runs git and releases its slot when the child closes', async () => {
    const semaphore = gitSemaphore('heavy')
    const child = await spawnGitLimited('heavy', '.', ['version'])

    expect(child).not.toBeNull()
    expect(semaphore.active).toBe(1)

    await new Promise<void>(resolve => child!.on('close', () => resolve()))
    await tick()

    expect(semaphore.active).toBe(0)
  })
})
