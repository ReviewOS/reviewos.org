/**
 * Test intelligence, for the views.
 *
 * A view imports explicitly and on one line; a component imports nothing at
 * all. So the pull request screen reaches the summary through here rather than
 * through the action directory, the same way it reaches the checks panel.
 */

import { testSummaryForPull as testSummaryForPullImpl } from '../../app/Actions/Tests/pull'

/**
 * What the tests said about a pull request's head, and - the part that is the
 * point - whether this branch is what made any of them unreliable.
 */
export const testSummaryForPull = testSummaryForPullImpl
