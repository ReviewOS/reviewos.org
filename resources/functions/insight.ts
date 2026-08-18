/**
 * The pipeline numbers, for the views.
 *
 * A view imports explicitly and on one line; a component imports nothing at
 * all. So the insight screen reaches the statistics through here rather than
 * through `app/Ops`, the same way the tests screen reaches its trends.
 */

import { insightFor as insightForImpl } from '../../app/Ops/insight'

/**
 * Run counts, success rate, percentiles, queue waits, fleet utilization, run
 * minutes, and what the known flakes cost - over one window, computed once, so
 * the screen and the API cannot disagree about what a success rate is.
 */
export const insightFor = insightForImpl
