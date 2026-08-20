import { Job } from '@stacksjs/queue'
import { releaseElapsedWaits } from '../Actions/Workflow/releaseWaits'

/**
 * Deploys held by a wait timer, let go when the timer runs out.
 *
 * Every minute, because a wait timer is written in minutes and one that fires
 * up to an hour late is a timer nobody trusts - and a deploy people do not
 * trust to start is one they start by hand, which is the rule not existing.
 *
 * Cheap when nothing is held: an indexed read of paused jobs, which on almost
 * every instance is none.
 */
export default new Job({
  name: 'ReleaseEnvironmentWaitsJob',
  description: 'Release deploys whose environment wait timer has elapsed',
  queue: 'default',
  tries: 1,

  async handle() {
    return await releaseElapsedWaits()
  },
})
