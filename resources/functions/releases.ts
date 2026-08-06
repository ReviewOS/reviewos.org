/**
 * Release helpers, at the view boundary.
 *
 * The rules live in `app/Actions/Repo/releases.ts` where they are tested. This
 * re-exports the ones a page needs, for the same reason `browse.ts` does: stx
 * cannot parse `export … from`, so each one is imported under an alias and
 * re-exported as a const, and a template gets one import and no logic.
 */

import {
  compareTags as compareTagsImpl,
  isDraft as isDraftImpl,
  latestRelease as latestReleaseImpl,
  looksLikePrerelease as looksLikePrereleaseImpl,
  sortReleases as sortReleasesImpl,
} from '../../app/Actions/Repo/releases'

export const sortReleases = sortReleasesImpl
export const latestRelease = latestReleaseImpl
export const compareTags = compareTagsImpl
export const isDraft = isDraftImpl
export const looksLikePrerelease = looksLikePrereleaseImpl
