/**
 * The public diff viewer's server helpers, for the view that renders it.
 *
 * An stx server script cannot reach into `app/` directly - it renders under a
 * transform that hoists only the imports in its first block - so everything a
 * view needs is re-exported through `resources/functions`. See the other files
 * here for the same arrangement.
 */

import publicDiffConfig from '../../config/publicdiff'
import { MOUNT as MOUNT_IMPL, parseDiffPath as parseDiffPathImpl, parseDiffUrl as parseDiffUrlImpl } from '../../app/Actions/PublicDiff/parse'
import { patchFor as patchForImpl, renderTargetDiff as renderTargetDiffImpl } from '../../app/Actions/PublicDiff/render'

/** Read a path into a target, or null when it is not a diff URL. */
export const parseDiffPath = parseDiffPathImpl

/** The same, for a whole URL somebody pasted into the box. */
export const parseDiffUrl = parseDiffUrlImpl

/** Fetch and render one, with the same renderer a review here uses. */
export const renderTargetDiff = renderTargetDiffImpl

/**
 * The patch for a target, fetched once and held briefly.
 *
 * The page asks for it to decide how to show the diff, and the manifest and row
 * endpoints ask for it to answer. One fetch of GitHub serves all of them.
 */
export const patchFor = patchForImpl

/**
 * How large a patch may be and still be rendered whole, on the server.
 *
 * Under it, the page is a page: every file rendered, readable with no script
 * running, exactly as a fifteen-file pull request is on the review screen. That
 * is nearly every diff anybody pastes.
 *
 * Over it, rendering whole is what makes a phone reload the tab - DiffsHub's
 * own demo `oven-sh/bun#30412` comes to 55MB of HTML that way, and their
 * landing page warns about precisely this - so the page hands over to the
 * streamed viewer instead.
 *
 * Half a megabyte of *patch*, not of markup, because that is the number
 * available before any work has been done. Rendered markup runs several times
 * the patch that produced it.
 */
export const SSR_VIEW_PATCH_BYTES = 512 * 1024

/** Where the viewer lives, so the page and the parser agree on one prefix. */
export const MOUNT = MOUNT_IMPL

/** Whether this instance offers the viewer at all. Off by default. */
export const publicDiffEnabled = publicDiffConfig.enabled

/**
 * What a reader is told for each way a fetch can fail, as a heading.
 *
 * The sentence comes from `fetch.ts`, where the status and the headers are.
 * This is the shorter label above it, so the page reads as a diagnosis rather
 * than as an apology.
 */
export const FAILURE_TITLES: Record<string, string> = {
  'not-found': 'No such diff on GitHub',
  'private': 'That repository is private',
  'token-expired': 'That token no longer works',
  'sso-required': 'That token needs SSO authorization',
  'repository-not-selected': 'That token does not list this repository',
  'rate-limited': 'GitHub is rate limiting this request',
  'too-large': 'That patch is too large to fetch',
  'upstream-error': 'GitHub answered with an error',
  'network': 'GitHub could not be reached',
}
