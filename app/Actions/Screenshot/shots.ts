/**
 * The pictures the marketing page shows, declared rather than collected.
 *
 * A screenshot nothing can regenerate is one that goes stale silently: the
 * interface changes, the page keeps showing last year's version, and nobody
 * finds out because an image cannot fail a test. So this is a list, and
 * `buddy screenshot` takes every entry - the picture and the thing it is a
 * picture *of* stay together, and re-running the command is how they are kept
 * honest.
 *
 * `waitFor` is a selector that must exist before the shutter opens. Without one
 * the answer is a photograph of a spinner, which is the failure mode of every
 * naive screenshot tool: the page returned 200, the image is 40KB, and it shows
 * nothing.
 */

export interface Shot {
  /** The file written, under `public/images/screenshots`. */
  name: string
  /** Where to point the browser, relative to the instance. */
  path: string
  /** What the picture is for, so a reader of this file knows what may break it. */
  purpose: string
  width?: number
  height?: number
  /** A selector that has to be present before anything is captured. */
  waitFor?: string
  /**
   * Extra milliseconds after `waitFor` matches.
   *
   * For the surfaces that stream: the diff arrives progressively, so a shot
   * taken the instant the first row exists is a picture of one file. This is
   * the one place a sleep is the right tool - the alternative is asserting on
   * an internal that the next refactor renames.
   */
  settleMs?: number
  /** Run in the page just before the shutter, for scroll position and the like. */
  before?: string
}

/** The default viewport: a laptop, which is what most readers are on. */
export const VIEWPORT = { width: 1440, height: 900 }

export const SHOTS: readonly Shot[] = [
  {
    name: 'review-diff',
    path: '/reviewos/linux/pull/1/files',
    purpose: 'The review surface, on a real diff: file tree, hunks, syntax colour, mechanical labels.',
    waitFor: '.diff-file, [data-file-path], .diff-row',
    // The manifest streams, so this waits for a body of files rather than the
    // first one. See the phase 14 note about ingest rate.
    settleMs: 9000,
  },
  {
    name: 'review-conversation',
    path: '/reviewos/linux/pull/1',
    purpose: 'The conversation: the verdict, the timeline, and what is blocking a merge.',
    waitFor: 'main',
    settleMs: 2500,
  },
  {
    name: 'repository',
    path: '/reviewos/linux',
    purpose: 'A repository at rest: the tree, the languages, the recent history.',
    waitFor: 'main',
    settleMs: 2500,
  },
  {
    name: 'explore',
    path: '/explore',
    purpose: 'Discovery: what is on this instance and what is moving.',
    waitFor: 'main',
    settleMs: 2000,
  },
  {
    name: 'landing',
    path: '/',
    purpose: 'The landing page itself, for the press kit and the README.',
    waitFor: 'main',
    settleMs: 1500,
  },
]

/** Where they are written. Public, because the marketing page serves them. */
export const SCREENSHOT_DIRECTORY = 'public/images/screenshots'
