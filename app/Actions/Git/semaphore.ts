/**
 * A ceiling on concurrent git processes.
 *
 * There was no limit on how many gits this application would spawn - the only
 * backpressure was a per-credential throttle on three wire-protocol routes.
 * Clone storms are a CI fleet's normal operating condition, and `upload-pack`
 * is the most expensive thing this server runs, so the ceiling is not a
 * nicety: it is the difference between a queue and an OOM kill.
 *
 * ## Three classes, because the work is three kinds
 *
 * - **interactive**: what a page or an API request runs through `runGit` -
 *   short plumbing commands whose caller is a person waiting. Plentiful,
 *   because each is cheap and brief.
 * - **heavy**: `upload-pack`, `receive-pack`, archives - the transfers. Few,
 *   because each one is allowed to be enormous, and eight simultaneous
 *   packfile computations is already a saturated disk.
 * - **background**: gc, language measurement, secret scans, imports. Jobs.
 *   Fewest, because nobody is waiting and the queue will hold them.
 *
 * Separate classes rather than one number so the cheap work is never starved
 * by the expensive work: thirty clones must not make the file browser hang.
 *
 * ## The deadlock rule, structural rather than clever
 *
 * A holder of one class must never acquire the same class again while holding
 * it. With FIFO waiters, two holders each waiting for a second slot of their
 * own class wait forever once the class is full. The audit found no nested
 * acquisition anywhere in the codebase; anything new that wants git-inside-git
 * does the inner work *before* acquiring, or under a different class. The
 * acquire timeout is the backstop that turns a violation into a visible
 * failure instead of a silent hang.
 */

import process from 'node:process'

export type GitProcessClass = 'interactive' | 'heavy' | 'background'

/**
 * How long an acquire waits for a slot before giving up.
 *
 * Long enough to ride out a burst - a queue that drains in seconds should not
 * refuse anybody - and short enough that a wedged class turns into an error
 * somebody sees rather than requests hanging until their client gives up.
 * Env-tunable like the limits, and read the same way: garbage falls back.
 */
export const ACQUIRE_TIMEOUT_MS = limitFrom('GIT_SEMAPHORE_ACQUIRE_MS', 10_000)

/** A release handle. Calling it more than once is safe and does nothing. */
export type Release = () => void

interface Waiter {
  grant: (release: Release) => void
  expire: ReturnType<typeof setTimeout>
}

/**
 * A counting semaphore with FIFO waiters and an acquire timeout.
 *
 * FIFO matters: newest-first would let a busy class starve its oldest waiter
 * indefinitely, which for a wire-protocol request means a client that times
 * out while requests that arrived after it are served.
 */
export class CountingSemaphore {
  private inUse = 0
  private waiters: Waiter[] = []

  constructor(public readonly limit: number) {}

  /** How many slots are taken right now. Exposed for tests and metrics. */
  get active(): number {
    return this.inUse
  }

  /** How many acquirers are waiting. Exposed for tests and metrics. */
  get waiting(): number {
    return this.waiters.length
  }

  /**
   * Take a slot, or resolve `null` when none frees up within the timeout.
   *
   * Resolves rather than rejects on timeout: saturation is an answer the
   * caller has to render (a 503, a failed job), not an exception to bubble.
   */
  async acquire(timeoutMs = ACQUIRE_TIMEOUT_MS): Promise<Release | null> {
    if (this.inUse < this.limit) {
      this.inUse += 1

      return this.releaseOnce()
    }

    return await new Promise<Release | null>((resolve) => {
      const waiter: Waiter = {
        grant: resolve,
        expire: setTimeout(() => {
          // Out of the queue on timeout, so an abandoned waiter can never be
          // granted a slot nobody will release.
          const at = this.waiters.indexOf(waiter)
          if (at !== -1)
            this.waiters.splice(at, 1)

          resolve(null)
        }, timeoutMs),
      }

      this.waiters.push(waiter)
    })
  }

  /**
   * One slot's release, idempotent.
   *
   * A released slot is handed straight to the oldest waiter rather than
   * decremented and re-acquired, so FIFO cannot be jumped by a lucky
   * new arrival landing between the decrement and the wake.
   */
  private releaseOnce(): Release {
    let released = false

    return () => {
      if (released)
        return
      released = true

      const next = this.waiters.shift()

      if (next) {
        clearTimeout(next.expire)
        next.grant(this.releaseOnce())

        return
      }

      this.inUse -= 1
    }
  }
}

/**
 * The limits, env-tunable per class.
 *
 * The defaults are for one ordinary box. An instance on serious hardware
 * raises them in `.env`; an instance on a shared host lowers them. Zero or
 * garbage falls back to the default rather than to zero, because a limit of
 * zero is an instance that can never run git again.
 */
function limitFrom(variable: string, fallback: number): number {
  const value = Number(process.env[variable])

  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

export const GIT_LIMITS: Record<GitProcessClass, number> = {
  interactive: limitFrom('GIT_SEMAPHORE_INTERACTIVE', 32),
  heavy: limitFrom('GIT_SEMAPHORE_HEAVY', 8),
  background: limitFrom('GIT_SEMAPHORE_BACKGROUND', 4),
}

const semaphores: Record<GitProcessClass, CountingSemaphore> = {
  interactive: new CountingSemaphore(GIT_LIMITS.interactive),
  heavy: new CountingSemaphore(GIT_LIMITS.heavy),
  background: new CountingSemaphore(GIT_LIMITS.background),
}

/** The semaphore for a class, for anything that needs to look at the gauge. */
export function gitSemaphore(processClass: GitProcessClass): CountingSemaphore {
  return semaphores[processClass]
}

/**
 * Take a slot in a class, or `null` when the class stays saturated past the
 * timeout. Every spawn of git in this application goes through here - via
 * `runGit`, `spawnGitLimited`, or the couple of bespoke spawns in `git.ts`.
 */
export async function acquireGitSlot(
  processClass: GitProcessClass,
  timeoutMs = ACQUIRE_TIMEOUT_MS,
): Promise<Release | null> {
  return await semaphores[processClass].acquire(timeoutMs)
}
