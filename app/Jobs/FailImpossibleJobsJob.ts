import { Job } from '@stacksjs/queue'
import { failImpossibleJobs } from '../Actions/Workflow/impossible'

/**
 * Work nothing on this instance could ever take, ended rather than left queued.
 *
 * A queued job is a promise that something will happen, and a job asking for a
 * label no registered runner carries is a promise that is false - with a pull
 * request's checks held open on it indefinitely. The reason was computable and
 * on the screen already; nothing acted on it.
 *
 * Every ten minutes rather than every minute: the sweep only looks at jobs that
 * have already waited an hour, so a faster cadence would ask the same question
 * six times to get the same answer. Cheap when nothing qualifies, which on a
 * configured instance is always.
 */
export default new Job({
  name: 'FailImpossibleJobsJob',
  description: 'Fail queued jobs asking for a capability no runner has',
  queue: 'default',
  tries: 1,

  async handle() {
    return await failImpossibleJobs()
  },
})
