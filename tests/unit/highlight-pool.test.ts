/**
 * The highlight pool's decisions, without starting a thread.
 *
 * The parts worth testing are the ones that decide *whether* to use a worker
 * and *what* may be reused - sizing, the content key, and the cache's
 * eviction. Starting real workers to check those would make the suite slow and
 * flaky enough that nobody trusts it, and would test Bun rather than this.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { packLines } from 'ts-syntax-highlighter'
import {
  cachedTokens,
  cacheTokens,
  contentKey,
  highlightOnWorker,
  poolSize,
  poolStats,
  resetHighlightPool,
  setWorkerFactory,
  WORKER_THRESHOLD_CHARS,
} from '../../app/Actions/Browse/highlightPool'

afterEach(() => {
  resetHighlightPool()
})

describe('poolSize', () => {
  /**
   * One core for the event loop, one for whatever else the machine is doing,
   * and the rest for tokenizing.
   */
  test('leaves two cores for everything that is not tokenizing', () => {
    expect(poolSize(8)).toBe(6)
    expect(poolSize(4)).toBe(2)
  })

  test('never more than eight, because each worker holds every grammar', () => {
    expect(poolSize(64)).toBe(8)
    expect(poolSize(128)).toBe(8)
  })

  test('a small machine gets one worker rather than none or a negative number', () => {
    expect(poolSize(1)).toBe(1)
    expect(poolSize(2)).toBe(1)
    expect(poolSize(3)).toBe(1)
  })

  test('a nonsense core count falls back rather than producing NaN', () => {
    expect(poolSize(Number.NaN)).toBe(1)
    expect(poolSize(-4)).toBe(1)
  })
})

describe('the threshold', () => {
  /**
   * A message hop and a structured clone cost more than tokenizing a short
   * file. Without this the pool would make a fifteen file pull request slower
   * to serve while looking busy.
   */
  test('a short file is declined, and declining is answered with null', async () => {
    const before = poolStats().inline
    const job = highlightOnWorker(['const a = 1'], 'typescript')

    expect(await job.tokens).toBeNull()
    expect(poolStats().inline).toBe(before + 1)
  })

  test('cancelling something that was never dispatched is harmless', () => {
    const job = highlightOnWorker(['const a = 1'], 'typescript')

    expect(() => job.cancel()).not.toThrow()
    expect(() => job.cancel()).not.toThrow()
  })

  test('the threshold is measured in characters, not lines', () => {
    // One minified line is more work than four hundred short ones.
    const oneLongLine = ['a'.repeat(WORKER_THRESHOLD_CHARS + 1)]
    const manyShortLines = Array.from({ length: 400 }, () => 'a')

    expect(oneLongLine.join('').length).toBeGreaterThan(manyShortLines.join('').length)
  })
})

describe('contentKey', () => {
  test('the same content in the same language is the same key', () => {
    const lines = ['const a = 1', 'const b = 2']

    expect(contentKey(lines, 'typescript')).toBe(contentKey([...lines], 'typescript'))
  })

  test('a different language is a different key, because the colours differ', () => {
    const lines = ['const a = 1']

    expect(contentKey(lines, 'typescript')).not.toBe(contentKey(lines, 'javascript'))
  })

  test('a one character change changes the key', () => {
    expect(contentKey(['const a = 1'], 'ts')).not.toBe(contentKey(['const a = 2'], 'ts'))
  })

  /**
   * Two files with the same characters in a different arrangement have to
   * differ, which is why the line count and the total length are in the key
   * rather than only in the hash.
   */
  test('the same characters split differently is a different key', () => {
    expect(contentKey(['ab'], 'ts')).not.toBe(contentKey(['a', 'b'], 'ts'))
  })

  test('an empty file has a key rather than throwing', () => {
    expect(contentKey([], 'ts')).toBeTruthy()
  })
})

describe('the result cache', () => {
  const tokens = [[{ type: 'text', content: 'a' }]]

  test('gives back what was put in', () => {
    cacheTokens('k1', tokens)

    expect(cachedTokens('k1')).toEqual(tokens)
  })

  test('a miss is undefined rather than an empty result', () => {
    expect(cachedTokens('never-stored')).toBeUndefined()
  })

  test('counts its hits, so the benchmark can tell it is working', () => {
    cacheTokens('k2', tokens)
    const before = poolStats().cached

    cachedTokens('k2')
    cachedTokens('k2')

    expect(poolStats().cached).toBe(before + 2)
  })

  /**
   * Least recently *used*, not least recently inserted: an entry that keeps
   * being asked for should survive, which is the whole difference between a
   * cache and a queue.
   */
  test('evicts the least recently used entry, not the oldest one', () => {
    for (let index = 0; index < 256; index++)
      cacheTokens(`fill-${index}`, tokens)

    // Touch the first one, then push one more in.
    expect(cachedTokens('fill-0')).toEqual(tokens)
    cacheTokens('one-more', tokens)

    expect(cachedTokens('fill-0')).toEqual(tokens)
    expect(cachedTokens('fill-1')).toBeUndefined()
  })

  test('is emptied by a reset, so one test cannot see another one\'s entries', () => {
    cacheTokens('k3', tokens)
    resetHighlightPool()

    expect(cachedTokens('k3')).toBeUndefined()
    expect(poolStats().cacheSize).toBe(0)
  })
})

/**
 * What the pool does when a worker misbehaves.
 *
 * The only part of this file that needs a worker at all, and it needs one that
 * a real worker cannot be: real workers answer, and every branch worth testing
 * here is a branch where something does not. A worker that dies mid-job, one
 * that wedges, one that replies to a job whose caller has gone - all three fail
 * *silently* if they are wrong. A dropped job that never resolves is a page load
 * that hangs, and a job resolved twice is a row rendered over itself.
 *
 * So the seam. The fake below is a postbox: it records what it was sent and
 * answers only when the test says to, which is what makes "and then it died"
 * something that can be written down.
 */
describe('a worker that does not behave', () => {
  interface Fake {
    worker: Worker
    sent: { id: number, type: string }[]
    /** Answer the job it is holding, the way the real worker would. */
    reply: (tokens?: ReturnType<typeof packLines>) => void
    /** Die, the way a worker that runs out of memory does. */
    die: () => void
    terminated: boolean
  }

  function fakeWorker(): Fake {
    const listeners = new Map<string, ((event: unknown) => void)[]>()
    const sent: { id: number, type: string }[] = []
    const fake = {
      sent,
      terminated: false,
    } as Fake

    fake.worker = {
      addEventListener(type: string, handler: (event: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), handler])
      },
      postMessage(message: { id: number, type: string }) {
        sent.push(message)
      },
      terminate() {
        fake.terminated = true
      },
    } as unknown as Worker

    const emit = (type: string, event: unknown): void => {
      for (const handler of listeners.get(type) ?? [])
        handler(event)
    }

    fake.reply = (tokens) => {
      const last = sent.filter(message => message.type === 'tokenize').at(-1)
      // A real packed result, not a stand-in: the pool unpacks whatever comes
      // back, so a fake that posts the wrong shape tests the unpacker's error
      // handling rather than the pool's.
      emit('message', {
        data: { id: last?.id, type: 'tokens', flat: tokens ?? packLines([[{ type: 'text', content: 'a' }]], ['a']) },
      })
    }
    fake.die = () => emit('error', new Error('worker died'))

    return fake
  }

  /** Big enough to be worth a thread, so the pool actually dispatches it. */
  const big = Array.from(
    { length: 400 },
    (_unused, index) => `export const identifier${index} = someFunction(${index}, 'a string argument')`,
  )

  afterEach(() => {
    resetHighlightPool()
  })

  test('the fixture is over the threshold, or none of this tests anything', () => {
    expect(big.join('\n').length).toBeGreaterThan(WORKER_THRESHOLD_CHARS)
  })

  /**
   * The failure this exists for. A worker that dies is holding a job, and that
   * job has a caller waiting on a promise - so the death has to be turned into
   * an answer. Null is the answer, because every caller already reads null as
   * "tokenize it here instead", and the reader gets their page slightly later
   * rather than never.
   */
  test('a worker that dies answers its job rather than dropping it', async () => {
    const fake = fakeWorker()
    setWorkerFactory(() => fake.worker)

    const job = highlightOnWorker(big, 'ts')
    expect(fake.sent).toHaveLength(1)

    fake.die()

    expect(await job.tokens).toBeNull()
  })

  test('and is dropped from the pool rather than handed more work', () => {
    const fake = fakeWorker()
    setWorkerFactory(() => fake.worker)

    highlightOnWorker(big, 'ts')
    expect(poolStats().workers).toBe(1)

    fake.die()

    expect(poolStats().workers).toBe(0)
    expect(fake.terminated).toBe(true)
  })

  /**
   * Cancellation mid-flight, which is what the on-demand row fetcher depends
   * on: a reader who scrolls past forty files should not have the server finish
   * tokenizing all of them.
   */
  test('cancelling a job a worker has already started tells the worker', () => {
    const fake = fakeWorker()
    setWorkerFactory(() => fake.worker)

    const job = highlightOnWorker(big, 'ts')
    job.cancel()

    expect(fake.sent.map(message => message.type)).toEqual(['tokenize', 'cancel'])
    expect(fake.sent[1]!.id).toBe(fake.sent[0]!.id)
  })

  /**
   * Best effort, and honest about it. The tokenizer is a tight loop with
   * nowhere to yield, so a job already started runs to completion and posts a
   * result - which must be dropped rather than resolved, or a reader who
   * scrolled away gets rows for a file they are no longer looking at.
   */
  test('a cancelled job that answers anyway is answered null, not with its tokens', async () => {
    const fake = fakeWorker()
    setWorkerFactory(() => fake.worker)

    const job = highlightOnWorker(big, 'ts')
    job.cancel()
    fake.reply()

    expect(await job.tokens).toBeNull()
  })

  test('cancelling twice does not post a second cancel', () => {
    const fake = fakeWorker()
    setWorkerFactory(() => fake.worker)

    const job = highlightOnWorker(big, 'ts')
    job.cancel()
    job.cancel()

    expect(fake.sent.filter(message => message.type === 'cancel')).toHaveLength(1)
  })

  /**
   * Work waiting on a worker is work the stats have to admit to. A queue that
   * reports itself as empty is how a stall gets diagnosed as a slow disk.
   */
  test('work beyond the pool size is queued, and says so', () => {
    setWorkerFactory(() => fakeWorker().worker)

    const jobs = Array.from({ length: poolSize(navigator.hardwareConcurrency) + 3 }, () =>
      highlightOnWorker(big, 'ts'))

    const busy = poolStats()
    expect(busy.active).toBe(poolSize(navigator.hardwareConcurrency))
    expect(busy.queued).toBe(3)
    expect(jobs).toHaveLength(busy.active + busy.queued)
  })

  /**
   * A queued job cancelled before any worker touches it should never reach one.
   * It is counted separately from a dispatched cancel precisely so the
   * benchmark can tell the difference between work avoided and work wasted.
   */
  test('a job cancelled while still queued is dropped rather than dispatched', async () => {
    const fakes: Fake[] = []
    setWorkerFactory(() => {
      const fake = fakeWorker()
      fakes.push(fake)
      return fake.worker
    })

    const running = Array.from({ length: poolSize(navigator.hardwareConcurrency) }, () =>
      highlightOnWorker(big, 'ts'))
    const waiting = highlightOnWorker(big, 'ts')

    expect(poolStats().queued).toBe(1)
    waiting.cancel()

    // Free a worker. The queued job is next, and must be discarded rather than
    // handed over.
    const dispatchedBefore = poolStats().dispatched
    fakes[0]!.reply()
    await running[0]!.tokens

    expect(await waiting.tokens).toBeNull()
    expect(poolStats().dispatched).toBe(dispatchedBefore)
    expect(poolStats().cancelled).toBe(1)
  })

  /**
   * A reset happens when the theme changes, and there may be work in flight
   * when it does. Every one of those callers is holding a promise, and a reset
   * that leaves them holding it forever is a page that never finishes loading -
   * which looks like a hung request rather than like a theme change.
   */
  test('a reset with work queued leaves nobody waiting forever', async () => {
    setWorkerFactory(() => fakeWorker().worker)

    const jobs = Array.from({ length: poolSize(navigator.hardwareConcurrency) + 2 }, () =>
      highlightOnWorker(big, 'ts'))

    resetHighlightPool()

    expect(await Promise.all(jobs.map(job => job.tokens))).toEqual(jobs.map(() => null))
    expect(poolStats().queued).toBe(0)
    expect(poolStats().active).toBe(0)
  })
})
