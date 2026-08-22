/**
 * Somebody else's patch, rendered by this instance's own diff renderer.
 *
 * The point of the viewer is that it is *this* renderer - the same rows, the
 * same syntax colours, the same expandable hunks a review here gets. A separate
 * rendering path built for the demo would be a demo of something that is not
 * the product, and the first time the two differed it would be arguing against
 * itself.
 *
 * So this is deliberately thin: fetch, parse, hand each file to the renderer
 * every other diff on this instance goes through.
 */

import type { DiffTarget } from './parse'
import type { FailureReason } from './fetch'
import { parseDiff } from '../Pull/diff'
import { highlightDiffFile, renderDiffFile } from '../Pull/rows'
import { fetchPatch } from './fetch'
import { cachedPatch, cacheKey, storePatch } from './patchCache'

export interface RenderedDiff {
  ok: boolean
  html: string
  /** How many files the patch carried, before any ceiling. */
  files: number
  additions: number
  deletions: number
  /** Which door answered: the public URL, the reader's token, the API, or the cache. */
  via: 'public' | 'authenticated' | 'api' | 'held' | null
  reason: FailureReason | null
  message: string | null
  retryAfterMs: number | null
}

/**
 * How many files are rendered before the viewer stops.
 *
 * A ceiling rather than a refusal: past it the reader gets the first files and
 * is told there are more, which is the honest answer for a compare that spans
 * eighty thousand of them. Server-rendered markup for all of them would be
 * hundreds of megabytes in one response.
 *
 * The streamed viewer this instance uses for its own diffs has no such ceiling,
 * and that difference is the point rather than an oversight: it streams from a
 * repository on disk, and this has one patch in memory that arrived over the
 * network.
 */
export const MAX_RENDERED_FILES = 300

const empty = { html: '', files: 0, additions: 0, deletions: 0 }

/**
 * The patch for a target, from the cache when it is there.
 *
 * The manifest and every row request that follows it want the same bytes, and
 * for a large diff those bytes are tens of megabytes from GitHub. Fetching once
 * and holding it briefly is what makes the streamed viewer affordable here at
 * all - see `patchCache.ts` for what "briefly" is bounded by.
 */
export type PatchResultFor =
  | { ok: true, patch: string, via: 'public' | 'authenticated' | 'api' | 'held' }
  | { ok: false, reason: FailureReason, message: string, retryAfterMs: number | null }

export async function patchFor(
  target: DiffTarget,
  options: { token?: string | null, fetchImpl?: typeof fetch, hosts?: ReadonlySet<string>, unmetered?: boolean } = {},
): Promise<PatchResultFor> {
  const key = cacheKey(target, options.token ?? null)
  const held = cachedPatch(key)

  // `held` rather than a guess at which door it came through originally. The
  // page says how a diff was reached and "it was already here" is the true
  // answer for this one.
  if (held !== null)
    return { ok: true, patch: held, via: 'held' }

  const fetched = await fetchPatch(target, options)

  if (!fetched.ok || fetched.patch === null) {
    return {
      ok: false,
      reason: fetched.reason ?? 'upstream-error',
      message: fetched.message ?? 'That diff could not be fetched.',
      retryAfterMs: fetched.retryAfterMs,
    }
  }

  storePatch(key, fetched.patch)

  return { ok: true, patch: fetched.patch, via: fetched.via ?? 'public' }
}

export async function renderTargetDiff(
  target: DiffTarget,
  options: { token?: string | null, fetchImpl?: typeof fetch, hosts?: ReadonlySet<string> } = {},
): Promise<RenderedDiff> {
  const patch = await patchFor(target, options)

  if (!patch.ok) {
    return {
      ok: false,
      ...empty,
      via: null,
      reason: patch.reason,
      message: patch.message,
      retryAfterMs: patch.retryAfterMs,
    }
  }

  const files = parseDiff(patch.patch)
  const shown = files.slice(0, MAX_RENDERED_FILES)
  const html: string[] = []

  for (const file of shown) {
    html.push(renderDiffFile(file, {
      expandable: false,
      tokens: await highlightDiffFile(file),
      collapsed: false,
    }))
  }

  return {
    ok: true,
    html: html.join(''),
    files: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    via: patch.via,
    reason: null,
    message: files.length > shown.length
      ? `Showing the first ${MAX_RENDERED_FILES} of ${files.length} files.`
      : null,
    retryAfterMs: null,
  }
}

/**
 * Expanding a gap is not offered here, and that is a fact about the patch.
 *
 * Every other diff on this instance can expand its context because the file is
 * on disk at a commit this server has. A patch fetched over the network is all
 * there is - the lines between two hunks were never sent - so an expand control
 * would be a control that cannot work. `expandable: false` above is that,
 * written once.
 */
export const CAN_EXPAND = false
