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

  // Packing repositories and letting go of deletions past the retention window.
  // Nightly and early, because `git gc` on a large repository is the most
  // expensive thing this server does and nobody wants to be cloning while it
  // runs.
  schedule
    .job('RepositoryMaintenance')
    .daily()
    .at('03:30')

  // Run a custom action every five minutes
  // schedule.action('CleanupTempFiles').everyFiveMinutes()

  // Run a shell command daily at midnight
  // schedule.command('echo "Daily maintenance complete"').daily()
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})
