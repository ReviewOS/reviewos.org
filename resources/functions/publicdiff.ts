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
import { renderTargetDiff as renderTargetDiffImpl } from '../../app/Actions/PublicDiff/render'

/** Read a path into a target, or null when it is not a diff URL. */
export const parseDiffPath = parseDiffPathImpl

/** The same, for a whole URL somebody pasted into the box. */
export const parseDiffUrl = parseDiffUrlImpl

/** Fetch and render one, with the same renderer a review here uses. */
export const renderTargetDiff = renderTargetDiffImpl

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
