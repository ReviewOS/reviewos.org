import { Job } from '@stacksjs/queue'
import { sweepTestExecutions } from '../Actions/Tests/retention'

/**
 * Keeping the promise the retention setting makes.
 *
 * Execution rows are the one table in this product that grows with how often
 * machines run rather than with how much people do: a suite of two thousand
 * tests, reported on every commit, writes two thousand rows per push. Left
 * alone it becomes the largest table in the database and nobody knows why.
 *
 * The policy is not here - it is `test_retention_days`, which an administrator
 * can read and change - and that order is deliberate: a rule that exists only
 * inside a cron job is one nobody can quote. This is how the disk catches up
 * with a rule somebody has already been told.
 *
 * Daily, and early. It is a delete over a range nothing is reading, and the
 * batching inside keeps it from holding a lock long enough to make a push time
 * out.
 */
export default new Job({
  name: 'ExpireTestHistory',
  description: 'Delete per-execution test history past the retention setting',
  queue: 'default',
  tries: 1,

  async handle() {
    return await sweepTestExecutions()
  },
})
