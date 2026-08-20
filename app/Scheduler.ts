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

  // The write-ahead log's pending rows, settled against the refs on disk.
  // Every ten minutes rather than hourly: a pending row is an entry the log
  // cannot yet answer questions about, and the window where a restore would be
  // wrong is exactly the window this leaves open. It only looks at rows past a
  // grace period, so a push still in flight is never voided.
  schedule
    .job('ReconcileWal')
    .everyTenMinutes()

  /*
   * The full bundle that lets the log forget its beginning, and the prune it
   * makes safe. Nightly, because it repacks and writes the whole repository:
   * doing it hourly would spend a repository's worth of bandwidth to learn
   * nothing, and the log is bounded by entries rather than by time anyway.
   *
   * It does nothing at all when the log is off.
   */
  schedule
    .job('CheckpointRepositories')
    .daily()

  /*
   * What this node holds against what the database says. Hourly and sampled:
   * a `for-each-ref` per repository across an instance with thousands of them
   * is an hour of git to answer a question that is almost always "no", and a
   * rotating sample finds systemic drift quickly.
   *
   * It reports rather than repairs. Silently reconciling would erase the
   * evidence of whatever caused the drift, and every cause worth knowing about
   * is a bug.
   */
  schedule
    .job('AuditRefDrift')
    .hourly()

  /*
   * Dependency snapshots past the size and age policy, nightly.
   *
   * The policy is configuration and `buddy ci:caches` prints what this would
   * remove before it removes it, through the same function - so a cache that
   * disappears is one somebody could have seen coming. Nightly because nothing
   * depends on the exact moment: an entry a day past its window costs disk, not
   * a wrong answer.
   */
  schedule
    .job('CollectCaches')
    .daily()
    .at('03:20')

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
   * Orchestrators whose sleep is due, every minute.
   *
   * A suspended run holds no lease and no machine, which is what makes waiting
   * three days affordable and also means nothing is watching it. This is the
   * only thing that is.
   */
  schedule
    .job('WakeSleepingRuns')
    .everyMinute()

  /*
   * Work nothing could ever take, every ten minutes.
   *
   * A job asking for a label no runner carries is not waiting, it is stuck -
   * and a run holding a pull request's checks open on it is the expensive half.
   * Ten minutes rather than one because the sweep only considers jobs that have
   * already waited an hour: asking six times an hour gets the same answer.
   */
  schedule
    .job('FailImpossibleJobs')
    .everyTenMinutes()

  /*
   * Workflow waits whose sleep or timeout is due, every minute.
   *
   * The same reason the orchestrator sweep exists, one layer down: a job
   * waiting for a clock or for an event holds nothing, so nothing is looking at
   * it. A wait written in minutes needs a sweep faster than a minute, or the
   * thing that ends it is a person refreshing the page.
   */
  schedule
    .job('EndDueWaits')
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
