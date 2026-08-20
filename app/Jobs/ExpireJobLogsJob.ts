import { Job } from '@stacksjs/queue'
import { db } from '@stacksjs/database'
import { logRetentionDays } from '../../config/ci-logs'

/**
 * Build output past its retention, removed.
 *
 * Off unless an operator sets `CI_LOG_RETENTION_DAYS`, and that default is the
 * decision rather than an omission: the first time anybody wants a build log is
 * usually six weeks after they stopped caring about the run, and an instance
 * that has never thought about this should still have it. Setting the number
 * says the text is worth less than the disk it sits on - true on a busy
 * instance, false on most.
 *
 * **What goes is the text.** The job, its steps, their timings and the run's
 * conclusion all stay, because those are what a person reads when they ask what
 * happened six months ago, and they are the small part. The log is the large
 * part and the part that ages worst.
 *
 * Daily, because nothing depends on the exact hour: the difference this makes
 * is between a disk that grows forever and one that does not, rather than
 * between available and gone.
 */
export default new Job({
  name: 'ExpireJobLogs',
  description: 'Remove job output older than the configured retention',
  queue: 'default',
  tries: 1,

  async handle() {
    const days = logRetentionDays()

    // Nothing configured, nothing to do - and no query either, because a sweep
    // that scans a large table daily to decide it is switched off is a cost
    // paid by every instance that never asked for the feature.
    if (days <= 0)
      return { ok: true, removed: 0, retentionDays: 0 }

    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()

    const removed = await db
      .deleteFrom('workflow_job_logs')
      .where('created_at', '<', cutoff)
      .execute()
      .then(result => Number((result as any)?.[0]?.numDeletedRows ?? 0))
      .catch(() => 0)

    return { ok: true, removed, retentionDays: days }
  },
})
