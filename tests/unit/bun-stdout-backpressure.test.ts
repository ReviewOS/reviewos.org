/**
 * Whether this runtime lets a slow reader slow a spawned child down.
 *
 * Every stream in this codebase that reads from git is pull-based: one chunk
 * per `pull()`, kill on `cancel()`. That bounds the parsing and the delivery,
 * and it was written to bound the *memory* too - which for a long time it did
 * not, because the runtime drained the child into its own buffer before this
 * code ever saw it. A client downloading a multi-gigabyte archive slowly cost
 * this process the difference, and `diffStream.ts` carried the same gap.
 *
 * ## This file used to assert the defect, and now asserts the fix
 *
 * It was written the other way round on purpose: it asserted that the child
 * finished writing with nobody reading, so that **when Bun fixed the bug the
 * test would fail**, loudly, with its own explanation attached. The
 * alternative was finding out years later.
 *
 * It fired. Measured on Bun 1.4.3: a 50MB writer against a reader that takes
 * one chunk and then stops for two seconds is still running when the idle
 * period ends. The child is held at the pipe, which is what Node has always
 * done and what the pull-based streams here were written assuming. The caveat
 * on the memory guarantee in `docs/todo/16-hardening-scale.md` came off with
 * this change.
 *
 * So the assertion is inverted rather than the file deleted, which is what the
 * roadmap asked for: "a Bun issue plus a regression test here when it lands".
 * A guarantee that was wrong for one runtime release can be wrong again, and
 * the thing worth protecting is that nobody has to rediscover it from a
 * memory graph.
 *
 * Adjacent upstream reports, all of them about the same drain:
 * oven-sh/bun#18239 (stdin buffered whole), #14693, #5319.
 */

import { describe, expect, test } from 'bun:test'

/**
 * Enough to be unambiguous, and small enough to be polite.
 *
 * Before the fix, 50MB grew RSS by around 128MB - the buffered bytes plus the
 * runtime's own copies - which is far outside any noise this measurement has.
 */
const MEGABYTES = 50

/** How long nothing reads for. Long enough that a blocked writer stays blocked. */
const IDLE_MS = 2000

describe('a spawned child, and a reader that stops reading', () => {
  test('is held at the pipe rather than finishing into memory', async () => {
    const child = Bun.spawn(['bash', '-c', `head -c ${MEGABYTES * 1024 * 1024} /dev/zero`], { stdout: 'pipe' })
    const reader = child.stdout.getReader()

    // One chunk, then nothing. On a runtime that applies backpressure at the
    // pipe the child is still writing when this returns.
    await reader.read()
    await Bun.sleep(IDLE_MS)

    const finished = child.exitCode !== null

    await reader.cancel().catch(() => {})
    child.kill()

    /*
     * Reported as a sentence rather than a boolean, so a failure says which
     * way round it went without anybody opening this file. If this starts
     * failing again, the runtime has regressed to draining the child eagerly
     * and the memory-flat guarantee on every pull-based stream here is
     * structural rather than actual until it is fixed.
     */
    expect(finished ? 'the child finished with nobody reading' : 'the child was held at the pipe')
      .toBe('the child was held at the pipe')
  }, 30_000)

  /*
   * There is no RSS assertion here, and the first version of this file had one.
   *
   * A resident-size measurement is a measurement of the allocator as much as of
   * the program: it moves with the runtime's own buffering, with GC timing, and
   * with whatever else the test process has done. Asserting on it produced a
   * test that failed on a laptop under load and passed in CI, which is worse
   * than no test. Whether the child is still running is the same fact observed
   * somewhere it can be observed exactly.
   */
})
