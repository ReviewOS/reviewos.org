import { Job } from '@stacksjs/queue'
import { evaluateMonitors } from '../Actions/Tests/monitors'

/**
 * Looking at every test monitor, and saying something only when one changes
 * its mind.
 *
 * Hourly. A monitor watches days of history, so evaluating by the minute would
 * ask the same question sixty times to get the same answer - and the thing that
 * makes this cheap enough to run at all is that a condition which was already
 * true fires nothing.
 *
 * The cadence *is* the alert latency, and an hour is the honest trade for a
 * rule whose window is a week: somebody who needs to know within a minute that
 * a test failed wants the check on the run, not a rule about the trend.
 */
export default new Job({
  name: 'EvaluateTestMonitors',
  description: 'Evaluate test monitors, and announce the ones that changed state',
  queue: 'default',
  tries: 1,

  async handle() {
    return await evaluateMonitors()
  },
})
