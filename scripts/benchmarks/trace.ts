/**
 * A Chrome trace of a diff being scrolled.
 *
 * `scroll-probe.js` says whether frames were dropped. This says which phase
 * dropped them: style recalculation, layout, or paint and compositing. That
 * attribution is what a CSS, containment or scrollbar change needs, and it is
 * the only reason to reach for a trace rather than the probe.
 *
 * Usage:
 *   bun scripts/benchmarks/trace.ts <url> [--runs 3] [--headed] [--json out.json]
 *
 * Example:
 *   bun scripts/benchmarks/trace.ts http://localhost:3000/stacks/stacks/pull/9001/files
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { goto, launch, summarizeTrace, trace } from './cdp'

const here = dirname(fileURLToPath(import.meta.url))
const probe = readFileSync(join(here, 'scroll-probe.js'), 'utf8')

/**
 * The phases worth reporting, grouped the way a reader thinks about them.
 *
 * Style and layout together, because a change to one usually moves the other,
 * and everything from paint through commit together, because splitting them
 * says more about Chrome's internals than about the page.
 */
const STYLE_AND_LAYOUT = ['UpdateLayoutTree', 'Layout'] as const
const PAINT_AND_COMPOSITE = [
  'PrePaint',
  'Paint',
  'PaintImage',
  'Layerize',
  'UpdateLayer',
  'ScrollLayer',
  'Commit',
] as const
const SCRIPT = ['FunctionCall', 'EventDispatch', 'FireAnimationFrame'] as const
const ALL = [...STYLE_AND_LAYOUT, ...PAINT_AND_COMPOSITE, ...SCRIPT, 'ParseHTML'] as const

export interface TraceRun {
  styleAndLayoutMs: number
  paintAndCompositeMs: number
  scriptMs: number
  parseHtmlMs: number
  scroll: {
    distance: number
    droppedFrames: number
    frames: number
    stepMismatches: number
    stepsClamped: number
  }
}

/**
 * Wait until the page is worth measuring.
 *
 * A trace started while the manifest is still streaming records the loading,
 * which is a different question with a different answer. The condition is the
 * one the page itself reports: the file list is complete.
 */
async function waitForSettled(session: Awaited<ReturnType<typeof launch>>['session']): Promise<void> {
  let previousHeight = -1
  let steady = 0

  for (let attempt = 0; attempt < 400; attempt++) {
    const state = await session.evaluate<{ done: boolean, height: number } | null>(`
      (() => {
        const status = document.querySelector('[data-diff-status]')
        const scroller = document.querySelector('[data-diff-scroller]')
        if (!status || !scroller) return null
        return { done: status.dataset.tone === 'done', height: scroller.scrollHeight - scroller.clientHeight }
      })()
    `)

    if (state && state.done && state.height > 0) {
      // The file list being complete is not the same as the layout being
      // settled: heights are estimates until their file has been mounted and
      // measured, so the scrollable range keeps moving after the last record
      // lands. Waiting for it to hold still is what makes two runs comparable.
      steady = state.height === previousHeight ? steady + 1 : 0
      previousHeight = state.height

      if (steady >= 3)
        return
    }

    await Bun.sleep(100)
  }

  throw new Error('The page never settled: no complete file list, or a scroll height that kept moving')
}

async function once(url: string, headed: boolean): Promise<TraceRun> {
  const browser = await launch({ headed })

  try {
    await goto(browser.session, url)
    await waitForSettled(browser.session)
    await browser.session.evaluate(probe)

    const { result, events } = await trace(browser.session, async () =>
      browser.session.evaluate<any>('__reviewosScrollProbe({ durationMs: 4000, steps: 240 })'))

    const totals = summarizeTrace(events, ALL)
    const sum = (names: readonly string[]) =>
      Math.round(names.reduce((total, name) => total + (totals[name] ?? 0), 0) * 10) / 10

    return {
      styleAndLayoutMs: sum(STYLE_AND_LAYOUT),
      paintAndCompositeMs: sum(PAINT_AND_COMPOSITE),
      scriptMs: sum(SCRIPT),
      parseHtmlMs: sum(['ParseHTML']),
      scroll: {
        distance: result.distance,
        droppedFrames: result.droppedFrames,
        frames: result.frames,
        stepMismatches: result.stepMismatches,
        stepsClamped: result.stepsClamped,
      },
    }
  }
  finally {
    await browser.close()
  }
}

/** The middle run, which one slow start cannot drag. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 10) / 10
    : sorted[middle]!
}

export async function traceUrl(url: string, runs: number, headed: boolean): Promise<{
  runs: TraceRun[]
  median: Omit<TraceRun, 'scroll'>
}> {
  const results: TraceRun[] = []

  // One unrecorded run first. The first pass pays for the JIT, for Chrome's
  // own caches and for a cold profile directory.
  await once(url, headed)

  for (let index = 0; index < Math.max(1, runs); index++)
    results.push(await once(url, headed))

  return {
    runs: results,
    median: {
      styleAndLayoutMs: median(results.map(run => run.styleAndLayoutMs)),
      paintAndCompositeMs: median(results.map(run => run.paintAndCompositeMs)),
      scriptMs: median(results.map(run => run.scriptMs)),
      parseHtmlMs: median(results.map(run => run.parseHtmlMs)),
    },
  }
}

if (import.meta.main) {
  const url = process.argv[2]
  const runsIndex = process.argv.indexOf('--runs')
  const runs = runsIndex > 0 ? Number(process.argv[runsIndex + 1]) : 3
  const headed = process.argv.includes('--headed')
  const jsonIndex = process.argv.indexOf('--json')

  if (!url) {
    console.error('Usage: bun scripts/benchmarks/trace.ts <url> [--runs 3] [--headed] [--json out.json]')
    process.exit(1)
  }

  const report = await traceUrl(url, runs, headed)
  const mismatched = report.runs.filter(run => run.scroll.stepMismatches > 0).length

  const output = {
    url,
    runs: report.runs.length,
    headed,
    // A run whose scroll did not land where it was told describes a different
    // scroll, so it is called out rather than quietly averaged in.
    runsWithScrollMismatch: mismatched,
    median: report.median,
    perRun: report.runs,
  }

  console.log(JSON.stringify(output, null, 2))

  if (jsonIndex > 0 && process.argv[jsonIndex + 1])
    await Bun.write(process.argv[jsonIndex + 1]!, JSON.stringify(output, null, 2))
}
