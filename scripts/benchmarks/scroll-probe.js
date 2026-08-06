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

    // Marked so the same elements can be recognised after the scroll.
    //
    // The pooling claim is that hosts are *recycled* rather than created and
    // destroyed, and a count of mounts and recycles can be made to look right
    // by a pool that hands back a fresh element every time. Identity cannot:
    // an element carrying a mark this run wrote is the same element.
    let marked = 0
    for (const host of content.querySelectorAll('.diff-file-host')) {
      host.dataset.probeMark = String(marked++)
    }

    const heapBefore = heapBytes()
    const frameGaps = []
    const started = performance.now()
    let previousFrame = started
    let mismatches = 0
    let clamped = 0

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

      const wanted = Math.round((distance * step) / steps)
      // Clamped against the range as it is *now*. The list replaces estimated
      // heights with measured ones as files mount, so the scrollable range
      // moves under a run that computed its distance once at the start, and a
      // target past the end is the page being honest rather than the scroll
      // going wrong.
      const reachable = scroller.scrollHeight - scroller.clientHeight
      const target = Math.min(wanted, Math.max(0, reachable))
      scroller.scrollTop = target

      if (target !== wanted)
        clamped++

      // The browser stores scrollTop on the device pixel grid, so an exact
      // match is not required; a whole pixel of drift means the scroll did not
      // go where it was told.
      if (Math.abs(scroller.scrollTop - target) > 1)
        mismatches++
    }

    await settle(3)
    const elapsed = performance.now() - started
    observer?.disconnect()

    // Scrolled far from where the marks were written, so any element still
    // carrying one has travelled - which is what recycling means.
    const marksSurviving = content.querySelectorAll('.diff-file-host[data-probe-mark]').length

    // A forced collection before the second reading, where the browser allows
    // it. Without one, "memory settled back" is indistinguishable from "the
    // collector has not run yet", which is the claim nobody can make honestly.
    const collected = typeof globalThis.gc === 'function'
    if (collected) {
      globalThis.gc()
      await settle(3)
    }

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
      // Steps that asked for more than the list had left. Not a fault: it means
      // the range shrank while the run was going, usually because measured
      // heights came in under the estimates. Many of them means the run started
      // before the page had settled.
      stepsClamped: clamped,
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
      // Elements that were on screen at the start and are still mounted after
      // scrolling away - recycling, asserted by identity rather than by count.
      pooling: {
        markedAtStart: marked,
        stillCarryingAMark: marksSurviving,
      },
      heapCollectedBeforeReading: collected,
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
