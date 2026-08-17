import process from 'node:process'
import { schedule } from '@stacksjs/scheduler'

/**
 * **Scheduler**
 *
 * Define your scheduled tasks here. Jobs, actions, and shell commands
 * can all be scheduled with a fluent, expressive API.
 *
 * @see https://docs.stacksjs.com/scheduling
 */
export default function () {
  // Run the Inspire job every hour
  schedule
    .job('Inspire')
    .hourly()
    .setTimeZone('America/Los_Angeles')

  // The backstop behind the mirror webhooks. Five minutes is often enough that
  // a missed hook is not noticed, and rare enough that it is not a poll - the
  // per-mirror interval decides what is actually due.
  schedule
    .job('MirrorSweep')
    .everyFiveMinutes()

  // Work whose runner stopped talking, returned to the queue.
  //
  // Every minute, because a lease lasts sixty seconds: a sweep slower than the
  // lease is a job sitting in `running` with nobody coming for it, and until
  // this existed the only thing that freed one was another runner happening to
  // ask - which never happens on the instance where it matters most, the one
  // whose fleet is busy elsewhere.
  schedule
    .job('ReclaimLapsedLeases')
    .everyMinute()

  // Hourly, because nothing depends on the exact moment: a download past its
  // date is already refused, so this is the difference between a disk that
  // grows forever and one that does not, rather than between available and
  // gone.
  schedule
    .job('ExpireArtifacts')
    .hourly()

  // What was held, sent as one message per thread. A sweep rather than a timer
  // armed per notification: a timer has to survive a restart and a sweep reads
  // what is actually pending, so a process that dies mid-digest loses nothing -
  // the rows are still marked pending and the next run picks them up.
  //
  // Every five minutes. A digest is worth the wait it saves; it is not worth an
  // hour of latency on a window that just opened.
  schedule
    .job('SendDigest')
    .everyFiveMinutes()

  // Tokens close to lapsing, once a day. The thresholds are counted in days, so
  // running more often would find the same tokens and send nothing extra -
  // `expiry_warned_days` records what has already gone. Daily is also what
  // makes the message worth reading: a warning that arrives hourly is one
  // people build a filter for, and the filter hides the last notice too.
  schedule
    .job('WarnExpiringTokens')
    .daily()

  /*
   * Deploys held by an environment's wait timer, every minute.
   *
   * The timer is written in minutes, so a sweep slower than a minute is a
   * timer nobody trusts - and a deploy people do not trust to start on its own
   * is one they start by hand, which is the rule not existing.
   */
  schedule
    .job('ReleaseEnvironmentWaits')
    .everyMinute()

  /*
   * Test monitors, hourly.
   *
   * They watch days of history, so a shorter cadence asks the same question
   * repeatedly to get the same answer - and only a *transition* is an event,
   * so a monitor in alarm for a month sends one message however often this
   * runs.
   */
  schedule
    .job('EvaluateTestMonitors')
    .hourly()

  /*
   * Per-execution test history, past the retention setting.
   *
   * Daily and just before the git maintenance below, so the two heavy nightly
   * jobs are next to each other rather than scattered through the night. It is
   * a delete over rows nothing is reading, batched so it never holds a lock
   * long enough for a push to notice.
   */
  schedule
    .job('ExpireTestHistory')
    .daily()
    .at('03:10')

  // Packing repositories and letting go of deletions past the retention window.
  // Nightly and early, because `git gc` on a large repository is the most
  // expensive thing this server does and nobody wants to be cloning while it
  // runs.
  schedule
    .job('RepositoryMaintenance')
    .daily()
    .at('03:30')

  /*
   * `on: schedule`, every minute.
   *
   * Cron is minute-resolution, so a sweep slower than a minute would fire a
   * workflow late and, worse, unpredictably late: 02:00 arriving at 02:04 is
   * one thing, arriving at 02:04 some nights and 02:00 on others is a schedule
   * nobody can reason about. The sweep is a single indexed query when nothing
   * is due, which is nearly every minute.
   */
  schedule
    .job('DispatchScheduledWorkflows')
    .everyMinute()

  /*
   * The actions this instance's workflows use, kept current.
   *
   * Hourly, and cheap when nothing changed: `git remote update` on an unchanged
   * repository transfers nothing. The reason to run it when everything is fine
   * is that the day it matters is the day the upstream host is down, and a
   * mirror last updated a week ago is missing exactly the tag somebody pushed
   * yesterday. Sweeps nothing at all on an instance whose policy allows no
   * remote actions, which is the default.
   */
  schedule
    .job('MirrorActions')
    .hourly()

  // Run a custom action every five minutes
  // schedule.action('CleanupTempFiles').everyFiveMinutes()

  // Run a shell command daily at midnight
  // schedule.command('echo "Daily maintenance complete"').daily()
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})
