/**
 * Stopping without dropping anything.
 *
 * The failures here are invisible until they are a support thread: a push cut
 * off mid-`receive-pack` leaves a repository with objects and no ref, and a job
 * killed halfway through a mirror sync leaves a half-fetched remote. Neither
 * reports an error - the process was told to stop, and it stopped.
 *
 * The clock is injected, so these assert the *ordering* - report unhealthy,
 * then stop accepting, then wait - rather than waiting twenty-five real
 * seconds to find out.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { accepting, drain, draining, inFlight, resetShutdown, snapshot } from '../../app/Ops/shutdown'

/** A clock that records what it was asked to wait for and returns at once. */
function fakeSleep() {
  const waits: number[] = []

  return { waits, sleep: async (ms: number) => { waits.push(ms) } }
}

beforeEach(() => {
  resetShutdown()
})

describe('before anything happens', () => {
  it('is accepting and healthy', () => {
    expect(accepting()).toBe(true)
    expect(draining()).toBe(false)
  })
})

describe('draining', () => {
  it('reports unhealthy before it stops accepting', async () => {
    /*
     * The ordering that makes a deploy lose nothing. A load balancer polls
     * every few seconds and needs two or three failures to take an instance
     * out, so the unhealthy answer has to come while the socket is still open.
     * A process that reports healthy right up until it closes drops whatever
     * was in flight, and the drop looks like a network blip.
     */
    const observed: string[] = []
    const clock = fakeSleep()

    await drain({
      leadMs: 5000,
      sleep: async (ms: number) => {
        // Health is already failing during the lead time.
        observed.push(`sleep:${ms}:draining=${draining()}:accepting=${accepting()}`)
        await clock.sleep(ms)
      },
      stop: () => { observed.push('socket closed') },
    })

    expect(observed[0]).toBe('sleep:5000:draining=true:accepting=false')
    expect(observed).toContain('socket closed')
  })

  it('waits for work in flight', async () => {
    const clock = fakeSleep()
    let released = () => {}
    const held = new Promise<void>((resolve) => { released = resolve })

    const work = inFlight(async () => { await held })

    expect(snapshot().inFlight).toBe(1)

    // Let the drain poll a few times, then let the work finish.
    const draining = drain({
      leadMs: 0,
      deadlineMs: 10_000,
      sleep: async (ms: number) => {
        await clock.sleep(ms)

        if (clock.waits.length > 3)
          released()
      },
    })

    const outcome = await draining
    await work

    expect(outcome.finished).toBe(true)
    expect(outcome.abandoned).toBe(0)
  })

  it('gives up at the deadline rather than hanging', async () => {
    /*
     * The alternative to a deadline is hanging forever, and an orchestrator
     * that waits thirty seconds and then sends SIGKILL turns "wait for the long
     * job" into "get killed mid-write" - the outcome this exists to prevent.
     */
    let now = 0
    const stuck = inFlight(async () => await new Promise<void>(() => {}))
    void stuck

    const outcome = await drain({
      leadMs: 0,
      deadlineMs: 1000,
      sleep: async (ms: number) => { now += ms },
    })

    expect(outcome.finished).toBe(false)
    expect(outcome.abandoned).toBe(1)
    expect(now).toBeGreaterThan(0)
  })

  it('says how much it abandoned', async () => {
    // The difference between "the drain window is too short" and "something is
    // stuck", neither of which is discoverable from a process that exited
    // quietly.
    void inFlight(async () => await new Promise<void>(() => {}))
    void inFlight(async () => await new Promise<void>(() => {}))

    const outcome = await drain({ leadMs: 0, deadlineMs: 100, sleep: async () => {} })

    expect(outcome.abandoned).toBe(2)
  })

  it('is safe to call twice', async () => {
    // Two signals arriving close together is ordinary, and the second must not
    // restart the lead time and hold the process open for another five seconds.
    await drain({ leadMs: 0, deadlineMs: 10, sleep: async () => {} })

    const second = await drain({ leadMs: 0, deadlineMs: 10, sleep: async () => {} })

    expect(second.finished).toBe(true)
  })
})

describe('counting work', () => {
  it('releases the count even when the work throws', async () => {
    /*
     * A `finally` somebody forgets is a counter that never returns to zero and
     * a process that never exits - which reads as a hung deploy, days after the
     * code was written. Wrapping is the only reason that cannot happen here.
     */
    await inFlight(async () => { throw new Error('no') }).catch(() => {})

    expect(snapshot().inFlight).toBe(0)
  })
})
