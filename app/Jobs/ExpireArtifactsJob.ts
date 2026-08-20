import { Job } from '@stacksjs/queue'
import { sweepExpiredArtifacts } from '../Actions/Artifact/store'

/**
 * Making the disk follow the promise every artifact was uploaded with.
 *
 * The retention date is decided at upload and shown in every listing, so this
 * sweep is not where the policy lives - it is how the bytes catch up with a
 * policy a reader has already been told. That order is deliberate: a rule that
 * exists only inside a cron job is one nobody can quote, and an artifact whose
 * disappearance is a surprise is worse than one that disappeared on the day it
 * said it would.
 *
 * A download of something past its date is already refused, so this job is
 * never the difference between available and gone. It is the difference between
 * a disk that grows forever and one that does not.
 *
 * **Hourly, not by the minute.** Nothing depends on the exact moment: an
 * artifact whose date passed twenty minutes ago is unreachable either way, and
 * a sweep that walks every expired row every minute is a query nobody needs
 * sixty times an hour.
 */
export default new Job({
  name: 'ExpireArtifactsJob',
  description: 'Remove artifacts whose retention has run out, and the blobs nothing else references',
  queue: 'default',
  tries: 1,

  async handle() {
    const swept = await sweepExpiredArtifacts()

    return { ok: true, ...swept }
  },
})
