// What a workflow program calls, and what happens to it when the machine dies.
//
// The transport is faked because none of the behaviour worth testing is about
// HTTP: it is about which calls get made, in what order, and what a program
// sees on the second run. A test that needed a server to check that is a test
// nobody runs.

import { describe, expect, test } from 'bun:test'
import { orchestrator, RunOver, StepFailed, Suspended } from '../../app/Actions/Runner/orchestratorClient'

/**
 * A journal, in memory, behaving as the real one does.
 *
 * Keyed by position, holding the identity of what was called there, so
 * divergence is detected the same way the table detects it.
 */
function fakeJournal() {
  const entries = new Map<number, { id: number, identity: string, state: string, result?: unknown, error?: string, wakeAt?: string | null }>()
  const requests: Array<{ sequence: number, kind: string, name: string }> = []
  let nextId = 0

  return {
    entries,
    requests,
    transport: {
      async call(body: any) {
        requests.push({ sequence: body.sequence, kind: body.kind, name: body.name })

        const identity = `${body.kind} ${body.name} ${JSON.stringify(body.arguments)}`
        const held = entries.get(body.sequence)

        if (held) {
          if (held.identity !== identity)
            return { decision: 'diverged', reason: `call ${body.sequence} was ${held.identity} and is now ${identity}` }

          if (held.state === 'done')
            return { decision: 'replay', result: held.result, entry_id: held.id }

          if (held.state === 'failed')
            return { decision: 'failed', reason: held.error, entry_id: held.id }

          // A slept call whose time has come is woken by the server, not the
          // caller. Same rule as the real endpoint.
          if (body.kind === 'sleep' && held.wakeAt && Date.parse(held.wakeAt) <= Date.now()) {
            held.state = 'done'
            held.result = null

            return { decision: 'replay', result: null, entry_id: held.id }
          }

          return { decision: 'wait', entry_id: held.id, wake_at: held.wakeAt ?? null }
        }

        nextId += 1
        const entry = { id: nextId, identity, state: 'pending' as string, wakeAt: null as string | null }

        if (body.kind === 'sleep') {
          entry.wakeAt = new Date(Date.now() + Number(body.arguments?.ms ?? 0)).toISOString()
          entries.set(body.sequence, entry)

          return { decision: 'wait', entry_id: entry.id, wake_at: entry.wakeAt }
        }

        if (body.kind === 'now' || body.kind === 'random') {
          entry.state = 'done'
          const value = body.kind === 'now' ? new Date(1_700_000_000_000).toISOString() : 0.42
          entries.set(body.sequence, { ...entry, result: value })

          return { decision: 'replay', result: value, entry_id: entry.id }
        }

        entries.set(body.sequence, entry)

        return { decision: 'dispatch', entry_id: entry.id }
      },

      async report(body: any) {
        for (const entry of entries.values()) {
          if (entry.id !== body.entry_id)
            continue

          entry.state = body.error ? 'failed' : 'done'
          entry.result = body.result
          entry.error = body.error
        }
      },
    },
  }
}

describe('a program that is killed and started again', () => {
  /**
   * The claim the whole design exists for, from the program's side rather than
   * the table's: the counter counts what actually executed, and a restart does
   * not move it.
   */
  test('does not run a completed step a second time', async () => {
    const journal = fakeJournal()
    const executed: string[] = []

    async function program(steps: string[]) {
      const context = orchestrator(journal.transport)

      for (const name of steps) {
        await context.step(name, async () => {
          executed.push(name)
          return `${name}-was-run`
        })
      }
    }

    await program(['checkout', 'install', 'test'])

    expect(executed).toEqual(['checkout', 'install', 'test'])

    // The restart. The program runs from its first line, which is the model -
    // and the first three calls answer without doing anything.
    await program(['checkout', 'install', 'test', 'deploy'])

    expect(executed).toEqual(['checkout', 'install', 'test', 'deploy'])
  })

  test('and reads back the values the first run recorded', async () => {
    const journal = fakeJournal()

    const first = orchestrator(journal.transport)
    await first.step('build', async () => ({ artifact: 'app.tar.gz', size: 12 }))

    const second = orchestrator(journal.transport)
    const replayed = await second.step('build', async () => ({ artifact: 'different', size: 0 }))

    // A later step reading an earlier step's output must read the same value,
    // or the second half of the run is working from a different world.
    expect(replayed).toEqual({ artifact: 'app.tar.gz', size: 12 })
  })
})

describe('a step that failed', () => {
  test('throws, and throws the same way on replay', async () => {
    const journal = fakeJournal()

    const first = orchestrator(journal.transport)

    await expect(first.step('deploy', async () => {
      throw new Error('the registry rejected the tag')
    })).rejects.toThrow('the registry rejected the tag')

    /*
     * A failed step is a decision the run already made. Re-running it on
     * restart turns one failed deploy into two attempted deploys, which is the
     * class of problem durability exists to prevent.
     */
    let ran = false
    const second = orchestrator(journal.transport)

    const thrown = await second.step('deploy', async () => {
      ran = true
      return 'ok'
    }).catch(error => error)

    expect(ran).toBe(false)
    expect(thrown).toBeInstanceOf(StepFailed)
    expect(String(thrown.message)).toBe('the registry rejected the tag')
  })

  test('so a program that caught it catches it identically the second time', async () => {
    const journal = fakeJournal()

    async function program() {
      const context = orchestrator(journal.transport)
      const taken: string[] = []

      try {
        await context.step('flaky', async () => {
          throw new Error('nope')
        })
        taken.push('happy')
      }
      catch {
        taken.push('recovered')
      }

      await context.step('after', async () => 'done')

      return taken
    }

    expect(await program()).toEqual(['recovered'])
    // The same branch, which is what determinism means in practice: a replay
    // that took the other path would ask for a call the journal does not have.
    expect(await program()).toEqual(['recovered'])
  })
})

describe('a sleep', () => {
  test('suspends the program rather than blocking it, so the runner can go', async () => {
    const journal = fakeJournal()
    const context = orchestrator(journal.transport)

    const thrown = await context.sleep('approval', 259_200_000).catch(error => error)

    expect(thrown).toBeInstanceOf(Suspended)
    // Named, so whatever re-dispatches this run knows when to bother.
    expect(Date.parse(String(thrown.wakeAt))).toBeGreaterThan(Date.now())
  })

  test('and is over when the control plane says it is, not when the runner thinks so', async () => {
    const journal = fakeJournal()

    // A sleep of zero: already due by the time it is asked about again.
    await orchestrator(journal.transport).sleep('brief', 0).catch(() => null)

    const resumed = orchestrator(journal.transport)

    await resumed.sleep('brief', 0)

    // Past it, into the rest of the program.
    expect(await resumed.step('after', async () => 'ran')).toBe('ran')
  })
})

describe('the injected clock and randomness', () => {
  test('are journaled, so a replay sees what the first run saw', async () => {
    const journal = fakeJournal()

    const first = orchestrator(journal.transport)
    const time = await first.now()
    const roll = await first.random()

    const second = orchestrator(journal.transport)

    expect((await second.now()).getTime()).toBe(time.getTime())
    expect(await second.random()).toBe(roll)
  })

  /**
   * Without these a program that needs a timestamp would have no way to get one
   * that survives a restart, and the determinism rule would be one nobody could
   * follow.
   */
  test('and they take positions like any other call', async () => {
    const journal = fakeJournal()
    const context = orchestrator(journal.transport)

    await context.now()
    await context.step('build', async () => 'built')

    expect(journal.requests.map(one => one.kind)).toEqual(['now', 'step'])
    expect(journal.requests.map(one => one.sequence)).toEqual([1, 2])
  })
})

describe('positions', () => {
  /**
   * The subtle one, and the reason `next()` runs before the first `await`.
   *
   * A program using `Promise.all` numbers its calls in the order it *made*
   * them. Numbering by whichever request answered first would report divergence
   * on a replay of a program that did nothing wrong.
   */
  test('follow the order the program made its calls, not the order they answer', async () => {
    const journal = fakeJournal()

    const slow = {
      ...journal.transport,
      async call(body: any) {
        // The first call answers last, which is the case that breaks a
        // counter assigned after the await.
        if (body.name === 'a')
          await new Promise(resolve => setTimeout(resolve, 20))

        return journal.transport.call(body)
      },
    }

    const context = orchestrator(slow)

    await Promise.all([
      context.step('a', async () => 'a'),
      context.step('b', async () => 'b'),
      context.step('c', async () => 'c'),
    ])

    const byName = new Map(journal.requests.map(one => [one.name, one.sequence]))

    expect(byName.get('a')).toBe(1)
    expect(byName.get('b')).toBe(2)
    expect(byName.get('c')).toBe(3)
  })

  test('and a program that changed shape is stopped rather than replayed wrongly', async () => {
    const journal = fakeJournal()

    const first = orchestrator(journal.transport)
    await first.step('checkout', async () => 'ok')
    await first.step('install', async () => 'ok')

    const second = orchestrator(journal.transport)
    await second.step('checkout', async () => 'ok')

    const thrown = await second.step('deploy', async () => 'ok').catch(error => error)

    // Not retryable by anyone: the journal describes a run that no longer
    // exists, so the only correct response is to stop.
    expect(thrown).toBeInstanceOf(RunOver)
    expect(thrown.decision).toBe('diverged')
    expect(String(thrown.message)).toContain('call 2')
  })

  test('are also what makes two calls to one step name different calls', async () => {
    const journal = fakeJournal()
    const context = orchestrator(journal.transport)
    const ran: number[] = []

    // A loop. Naming cannot tell these apart, which is why the position is the
    // identity rather than the name.
    for (const index of [1, 2, 3]) {
      await context.step('publish', async () => {
        ran.push(index)
        return index
      }, { index })
    }

    expect(ran).toEqual([1, 2, 3])
    expect(context.calls()).toBe(3)
  })
})

describe('another orchestrator holding the call', () => {
  test('suspends rather than doing the work twice', async () => {
    const journal = fakeJournal()

    // The first one claims the call and is still working on it.
    const first = orchestrator(journal.transport)
    const inFlight = first.step('deploy', async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return 'deployed'
    })

    await new Promise(resolve => setTimeout(resolve, 5))

    let ran = false
    const second = orchestrator(journal.transport)

    const thrown = await second.step('deploy', async () => {
      ran = true
      return 'deployed twice'
    }).catch(error => error)

    expect(ran).toBe(false)
    // Told to wait rather than told it failed: the work is being done, just not
    // by it.
    expect(thrown).toBeInstanceOf(Suspended)

    expect(await inFlight).toBe('deployed')
  })
})
