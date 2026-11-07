/**
 * A child process's stdout as a Response stream, with real backpressure.
 *
 * The shape this replaces looked right and was not: a `start()` that attaches
 * `on('data')` enqueues every chunk the moment git produces it, so a slow
 * client downloading a multi-gigabyte archive buffers the whole difference
 * between git's speed and the network's inside this process. Three response
 * streams had that body - the wire protocol, archives, raw files - which is
 * three ways one slow reader could take the box down.
 *
 * Pull-based instead: one chunk is read from the child per `pull()`, so the
 * consumer's pace is git's pace. Node readables apply backpressure through
 * their async iterator - when nobody asks, the pipe fills, and git blocks on
 * write, which is the only place the pending bytes are allowed to wait.
 *
 * **On Bun, today, the last step of that chain does not hold.** Measured at
 * Bun 1.3.14: the runtime drains a child's stdout into process memory
 * eagerly, however slowly the iterator is consumed - a 50MB writer finished
 * in one second against a reader pausing between chunks, and the buffered
 * bytes are invisible to `readableLength`. The write direction is fine
 * (`stdin.write()` returns false and `drain` fires honestly). So this helper
 * is the correct shape, it bounds everything above the runtime, and the
 * memory-flat guarantee lands when Bun honors pipe backpressure - the
 * roadmap's phase 16 M4 tracks that dependency.
 */

/**
 * What this needs from a child: structural, so a test can hand it a fake and
 * prove chunks are pulled one at a time without spawning anything.
 */
import type { ChildProcess } from 'node:child_process'

export interface StreamableChild {
  stdout: AsyncIterable<Uint8Array> | null
  kill: (signal?: NodeJS.Signals | number) => unknown
}

/**
 * Stream a child's stdout, one chunk per pull, killing the child when the
 * reader walks away.
 *
 * The child is killed on `cancel()` - somebody closing the tab must not leave
 * git packing a repository for nobody. A child that errors ends the stream
 * cleanly rather than erroring it: by the time bytes are flowing the status
 * code has already been sent, so a broken child can only truncate the body,
 * and the client's own protocol (git, tar, the browser's download manager)
 * is what notices a truncation.
 */
export function stdoutStream(child: StreamableChild): ReadableStream<Uint8Array> {
  const iterator = child.stdout![Symbol.asyncIterator]()

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next()

        if (done) {
          controller.close()

          return
        }

        controller.enqueue(new Uint8Array(value))
      }
      catch {
        // The child died mid-stream. The bytes so far are all there are.
        controller.close()
      }
    },
    cancel() {
      child.kill('SIGKILL')
    },
  })
}

/** Keep the client pull in charge; abandon a slow cache instead of buffering a tee. */
export function cacheWhileStreaming(
  source: ReadableStream<Uint8Array>,
  put: (body: ReadableStream<Uint8Array>) => Promise<unknown>,
  options: { maxBufferedBytes?: number, maxBytes?: number, complete?: () => Promise<boolean> } = {},
): ReadableStream<Uint8Array> {
  const limit = options.maxBufferedBytes ?? 16 * 1024 * 1024
  const maximum = options.maxBytes ?? 2 * 1024 * 1024 * 1024
  const reader = source.getReader()
  let active = true
  let total = 0
  let cache: ReadableStreamDefaultController<Uint8Array>
  const branch = new ReadableStream<Uint8Array>({
    start(controller) { cache = controller },
    cancel() { active = false },
  }, { highWaterMark: limit, size: chunk => chunk?.byteLength ?? 0 })
  const abandon = (reason: unknown): void => { if (active) { active = false; cache.error(reason) } }
  void put(branch).catch(() => { active = false })
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          if (active) {
            if (!options.complete || await options.complete()) { active = false; cache.close() }
            else abandon(new Error('Git did not complete successfully'))
          }
          controller.close(); return
        }
        total += next.value.byteLength
        if (active) {
          if (total > maximum || next.value.byteLength > (cache.desiredSize ?? 0)) abandon(new Error('Cache stream exceeded its bounded budget'))
          else cache.enqueue(next.value)
        }
        controller.enqueue(next.value)
      } catch (error) { abandon(error); controller.error(error) }
    },
    async cancel(reason) { abandon(reason || new Error('Download cancelled')); await reader.cancel(reason) },
  })
}

/** Attach completion before consuming stdout so a failed child never poisons the cache. */
export function cacheStdout(child: ChildProcess, put: (body: ReadableStream<Uint8Array>) => Promise<unknown>): ReadableStream<Uint8Array> {
  const complete = child.exitCode !== null || child.signalCode !== null ? Promise.resolve(child.exitCode === 0)
    : new Promise<boolean>((resolve) => { child.once('close', code => resolve(code === 0)); child.once('error', () => resolve(false)) })
  return cacheWhileStreaming(stdoutStream(child), put, { complete: () => complete })
}
