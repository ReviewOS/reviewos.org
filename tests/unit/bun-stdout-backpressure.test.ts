/**
 * Whether this runtime lets a slow reader slow a spawned child down.
 *
 * Every stream in this codebase that reads from git is pull-based: one chunk
 * per `pull()`, kill on `cancel()`. That bounds the parsing and the delivery,
 * and it was written to bound the *memory* too - which it does not, because the
 * runtime drains the child into its own buffer before this code ever sees it.
 * So a client downloading a multi-gigabyte archive slowly still costs this
 * process the difference, and `diffStream.ts` has carried the same latent gap
 * since it was written.
 *
 * The write direction is honest - a `write()` that returns false really does
 * hold the pump - which is why the boxes either side of this one could be
 * ticked and this one could not.
 *
 * ## Why this is a test rather than a note
 *
 * The note already exists, in phase 16 of the roadmap, and a note is a thing
 * that goes stale silently. This asserts the defect **as it stands today**, so
 * when Bun fixes it the test fails - loudly, on the next run, with this comment
 * attached - and whoever sees that failure knows two things at once: the
 * upstream bug is fixed, and the structural-rather-than-actual caveat on every
 * pull-based stream here can come off.
 *
 * A test that fails when the world gets better is an odd thing to write. The
 * alternative is finding out years later, which is what happened to the three
 * bugs written up at the top of the roadmap.
 *
 * Adjacent upstream reports: oven-sh/bun#18239 (stdin buffered whole), #14693,
 * #5319.
 */

import { describe, expect, test } from 'bun:test'

/**
 * Enough to be unambiguous, and small enough to be polite.
 *
 * At 50MB the growth is around 128MB of RSS - the buffered bytes plus the
 * runtime's own copies - which is far outside any noise this measurement has.
 */
const MEGABYTES = 50

/** How long nothing reads for. Long enough that a blocked writer stays blocked. */
const IDLE_MS = 2000

describe('a spawned child, and a reader that stops reading', () => {
  test('finishes writing anyway, which is the bug', async () => {
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
     * `true` is the defect. When this assertion starts failing, Bun has fixed
     * it: delete this file, and take the "structural rather than actual" caveat
     * off the memory guarantee in `docs/todo/16-hardening-scale.md`.
     */
    expect(finished ? 'the child finished with nobody reading' : 'the child was held at the pipe')
      .toBe('the child finished with nobody reading')
  }, 30_000)

  /*
   * There is no RSS assertion here, and the first version of this file had one.
   *
   * Measured in a process of its own, a 50MB write against a reader that took
   * one chunk grows RSS by about 128MB, and a 200MB write grows it by 554MB -
   * which is the whole payload plus the runtime's copies of it, and is the
   * clearest statement of the bug there is. Measured *inside this suite* it
   * grew 23MB, because the test above it had already allocated and the
   * allocator reuses what it has.
   *
   * So the number is recorded in the roadmap, where it was taken in isolation,
   * and the assertion here is the one that is exact in any process: the child
   * finished, and nothing was reading.
   */
})
