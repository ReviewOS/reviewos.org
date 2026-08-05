/**
 * What scrolling a diff costs, measured from inside the page.
 *
 * The server half of the harness (`diff-engine.ts`) measures everything that
 * happens before a browser is involved. This is the other half: whether the
 * list keeps up once somebody is reading it.
 *
 * It is deliberately *not* a Chrome trace. A trace attributes time to
 * `UpdateLayoutTree`, `Layout` and `Paint` and is the right tool for a CSS or
 * containment change; capturing one needs the DevTools protocol and a browser
 * launched for it. What this needs is a page and nothing else, so it can be run
 * against a dev server from a console, from an automated browser session, or by
 * somebody checking a hunch. The two are complements: this one says whether
 * frames were dropped, a trace says which phase dropped them.
 *
 * Usage, in the console of a review screen:
 *
 *   await __reviewosScrollProbe()
 *   await __reviewosScrollProbe({ distance: 20000, durationMs: 4000 })
 */

;(function () {
  /** 60fps. The interval a frame is meant to arrive at. */
  const FRAME_BUDGET_MS = 1000 / 60

  /**
   * How far past the budget counts as dropped.
   *
   * Not the budget itself. A page holding a steady sixty reports a median frame
   * of almost exactly 16.7ms, so counting anything over the budget calls half
   * of a perfect run dropped - which the first version of this did, and
   * reported 44% on a page that never stuttered. A frame is dropped when the
   * next one missed its slot, which is half a frame late.
   */
  const DROPPED_AT_MS = FRAME_BUDGET_MS * 1.5

  /** Long tasks block everything, including the scroll itself. */
  const LONG_TASK_MS = 50

  function heapBytes() {
    // Only Chrome exposes this, and only over http(s) with the right flags in
    // some builds. Absent is an ordinary answer, not a failure.
    const memory = performance.memory
    return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null
  }

  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve))

  async function settle(frames) {
    for (let index = 0; index < frames; index++)
      await nextFrame()
  }

  window.__reviewosScrollProbe = async function reviewosScrollProbe(options = {}) {
    const root = document.querySelector('[data-diff-stream]')
    const scroller = document.querySelector('[data-diff-scroller]')
    if (!scroller)
      throw new Error('No diff scroller on this page')

    const viewer = root?.__diffViewer ?? null
    const steps = options.steps ?? 240
    const durationMs = options.durationMs ?? 4000
    const reach = scroller.scrollHeight - scroller.clientHeight
    // Capped at what the page actually has, so a distance somebody guessed does
    // not silently measure a scroll that stopped early.
    const distance = Math.min(options.distance ?? reach, reach)

    if (distance <= 0)
      throw new Error('Nothing to scroll: the list is shorter than its viewport')

    // Long tasks, for the whole run. Not every browser reports them, and one
    // that does not is a browser this cannot say anything about.
    const longTasks = []
    let observer = null
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          longTasks.push(Math.round(entry.duration))
      })
      observer.observe({ entryTypes: ['longtask'] })
    }
    catch {
      observer = null
    }

    const before = viewer?.stats() ?? null
    scroller.scrollTop = 0
    await settle(3)

    const heapBefore = heapBytes()
    const frameGaps = []
    const started = performance.now()
    let previousFrame = started
    let mismatches = 0

    for (let step = 1; step <= steps; step++) {
      // Paced against the clock rather than against frames, so the same run
      // takes the same wall time on a fast machine and a slow one and the
      // dropped-frame count means the same thing on both.
      const dueAt = started + (durationMs * step) / steps
      while (performance.now() < dueAt) {
        await nextFrame()
        const now = performance.now()
        frameGaps.push(now - previousFrame)
        previousFrame = now
      }

      const target = Math.round((distance * step) / steps)
      scroller.scrollTop = target

      // The browser stores scrollTop on the device pixel grid, so an exact
      // match is not required; a whole pixel of drift means the scroll did not
      // go where it was told.
      if (Math.abs(scroller.scrollTop - target) > 1)
        mismatches++
    }

    await settle(3)
    const elapsed = performance.now() - started
    observer?.disconnect()

    const heapAfter = heapBytes()
    const after = viewer?.stats() ?? null

    const dropped = frameGaps.filter(gap => gap > DROPPED_AT_MS).length
    const sorted = [...frameGaps].sort((a, b) => a - b)
    const at = fraction => sorted.length === 0
      ? 0
      : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 10) / 10

    return {
      distance,
      steps,
      durationMs: Math.round(elapsed),
      scrollTop: Math.round(scroller.scrollTop),
      // Every step should have landed where it was told. Anything else means
      // the numbers below describe a different scroll than the one asked for.
      stepMismatches: mismatches,
      frames: frameGaps.length,
      framesPerSecond: Math.round((frameGaps.length / elapsed) * 1000),
      droppedFrames: dropped,
      droppedShare: frameGaps.length === 0 ? 0 : Math.round((dropped / frameGaps.length) * 100) / 100,
      droppedOverMs: Math.round(DROPPED_AT_MS * 10) / 10,
      frameMs: { p50: at(0.5), p95: at(0.95), p99: at(0.99), worst: at(1) },
      longTasks: longTasks.length,
      longestTaskMs: longTasks.length === 0 ? 0 : Math.max(...longTasks),
      longTasksOver: LONG_TASK_MS,
      // The claim this checks: rows are recycled, so mounting is a function of
      // how far somebody scrolled and not of how large the diff is.
      viewer: before && after
        ? {
            files: after.files,
            mounts: after.mounts - before.mounts,
            releases: after.releases - before.releases,
            recycled: after.recycled - before.recycled,
            frames: after.frames - before.frames,
            pooled: after.pooled,
            mounted: after.mounts - after.releases,
          }
        : null,
      heapMb: heapBefore == null || heapAfter == null
        ? null
        : {
            before: Math.round(heapBefore / 1024 / 1024),
            after: Math.round(heapAfter / 1024 / 1024),
            grew: Math.round((heapAfter - heapBefore) / 1024 / 1024),
          },
    }
  }
})()
