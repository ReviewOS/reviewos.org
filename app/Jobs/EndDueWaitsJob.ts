import { Job } from '@stacksjs/queue'
import { endDueWaits } from '../Actions/Workflow/awaits'

/**
 * Waits whose time has come, ended.
 *
 * An `await` job holds no lease and no machine - that is what makes waiting
 * three days for an approval affordable - and it is also what means nothing is
 * watching it. This is the only thing that is.
 *
 * Every minute, because a wait is written in minutes and one that ends up to an
 * hour late is a wait nobody trusts. Cheap when nothing is due: an indexed read
 * of paused rows with a deadline in the past, which on almost every instance is
 * none.
 */
export default new Job({
  name: 'EndDueWaitsJob',
  description: 'End workflow waits whose sleep or timeout has elapsed',
  queue: 'default',
  tries: 1,

  async handle() {
    return await endDueWaits()
  },
})
