/**
 * The three things that can be broken while the process is fine.
 *
 * A health check that returns 200 because it is running tells a load balancer
 * to keep sending traffic to an instance whose database is gone. The process
 * being up is the one thing that was never in doubt - it is the thing
 * answering.
 *
 * Separate from the action so it can be called from a command, a probe script,
 * or a test without a request, and so the checks themselves can be read in one
 * place rather than inside a route handler.
 */

import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { speaksMysql } from '../Actions/Support/sql'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from '../Actions/Git/storage'
import { draining } from './shutdown'
import { db } from '@stacksjs/database'

export type CheckStatus = 'ok' | 'degraded' | 'failed'

export interface Check {
  name: string
  status: CheckStatus
  /** How long it took, so a check that is slow rather than broken is visible. */
  ms: number
  /** What is wrong, in words an operator can act on. Absent when nothing is. */
  detail?: string
}

export interface HealthReport {
  ok: boolean
  checks: Check[]
}

/**
 * How long a subsystem may take before this reports it as degraded.
 *
 * Degraded rather than failed, and reported rather than hidden: a database
 * answering in four seconds is not down, and taking an instance out of rotation
 * for it can turn a slow dependency into an outage. But it is also not fine,
 * and a check that says `ok` at four seconds is a check that never warns
 * anybody before it starts failing.
 */
const SLOW_MS = 1000

export async function checkHealth(options: { writeProbe?: boolean } = {}): Promise<HealthReport> {
  /*
   * A draining process reports unhealthy while it is still answering.
   *
   * That gap is the whole of a zero-downtime deploy: the load balancer needs a
   * few seconds to notice and stop routing here, and those seconds have to
   * happen before the socket closes. A process that reports healthy right up
   * until it stops accepting is a process that drops whatever was in flight,
   * and the drop looks like a network blip rather than a deploy.
   */
  if (draining()) {
    return {
      ok: false,
      checks: [{ name: 'accepting requests', status: 'failed', ms: 0, detail: 'this process is shutting down' }],
    }
  }

  return summarize([
    await database(),
    await databaseClock(),
    await queue(),
    await scheduledWork(),
    await repositoryStorage(options.writeProbe !== false),
  ])
}

/**
 * Whether this set of results means "keep sending traffic".
 *
 * Pure, and separate from running the checks, because this is the decision that
 * matters and it is the one that cannot be exercised against a live instance:
 * breaking the database of the server a test is running against takes the rest
 * of the suite with it.
 *
 * **Degraded is still serving.** Only a failed check takes an instance out of
 * rotation, because the alternative - refusing traffic because something was
 * slow - turns a slow dependency into an outage.
 */
export function summarize(checks: Check[]): HealthReport {
  return {
    ok: checks.every(check => check.status !== 'failed'),
    checks,
  }
}

/**
 * Run one check, time it, and turn a throw into a reported failure.
 *
 * Exported so the reporting contract - a throw becomes `failed` with the
 * message and not the stack, a slow success becomes `degraded` - can be tested
 * without a broken database to hand.
 */
export { timed as runCheck }

/** Can we reach the database, and how quickly. */
async function database(): Promise<Check> {
  return await timed('database', async () => {
    /*
     * A real query against a real table rather than `SELECT 1`.
     *
     * `SELECT 1` succeeds against a database with no schema in it, which is
     * exactly the state a half-finished deploy is in - migrations not yet run,
     * every page 500ing, health green.
     */
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()
  })
}

/**
 * Does a timestamp the database fills in land in the same frame as the rest?
 *
 * Every timestamp column in this schema is `timestamp` **without** time zone
 * holding a UTC wall clock, and two things put values there: the application,
 * through `dbTimestamp`, which is `toISOString`; and the column's own default,
 * which is pinned - `now() AT TIME ZONE 'utc'` on Postgres, `UTC_TIMESTAMP` on
 * MySQL. A column that defaults to a bare `CURRENT_TIMESTAMP` instead gets the
 * *session's* local clock, and the offset is silently dropped on the way into a
 * zoneless column. Its rows then sit hours away from every other row in the
 * database, and wrong times look like times.
 *
 * That is exactly how eleven columns came to be wrong here. The framework's own
 * auth and RBAC tables are created with `CREATE TABLE IF NOT EXISTS`, so when
 * their DDL was pinned to UTC every new install got it and this database, which
 * already had the tables, kept the bare default - `password_resets`,
 * `two_factor_challenges`, `webauthn_challenges` and the rest. An expiry window
 * hours out is not a display bug.
 *
 * The framework repairs that on migrate now (`ensureUtcTimestampDefaults`), and
 * this stays anyway: it is the check that would have caught it, and the next
 * table created outside the generator will not be covered by anything else.
 *
 * **The default is what is checked, not the session clock.** This used to
 * compare `LOCALTIMESTAMP` against this process's clock, which measures the
 * database's session timezone - a different thing, and since the defaults were
 * pinned, one that no longer implies anything is wrong. It would report seven
 * hours of skew on a correctly-behaving database that happens to sit in
 * Pacific, and a check that is permanently degraded for no reason is a check
 * people learn to ignore.
 *
 * Reading `information_schema` rather than writing a row, because the question
 * is about what the schema will do rather than about what it did once.
 */
async function databaseClock(): Promise<Check> {
  return await timed('database clock', async () => {
    /*
     * Both engines' spellings of "the session's clock", and neither engine's
     * spelling of the pinned one - which mentions UTC and is what everything
     * correct here reads as.
     */
    const rows = await db.unsafe(
      `SELECT table_name, column_name FROM information_schema.columns `
      + `WHERE table_schema = ${speaksMysql() ? 'DATABASE()' : 'current_schema()'} `
      + `AND data_type LIKE 'timestamp%' `
      + `AND column_default IS NOT NULL `
      + `AND LOWER(column_default) NOT LIKE '%utc%' `
      + `AND LOWER(column_default) LIKE '%current_timestamp%'`,
    ).execute()

    const drifting = Array.isArray(rows) ? rows : []

    if (drifting.length === 0)
      return

    const named = drifting
      .slice(0, 3)
      .map((row: any) => `${row.table_name}.${row.column_name}`)
      .join(', ')

    /*
     * Degraded, not failed, and the distinction is this file's own rule: only a
     * failed check takes an instance out of rotation. Rows landing in the wrong
     * frame is bad, and it is not a reason to stop serving a forge that is
     * otherwise working - refusing traffic over it would turn a data bug into
     * an outage.
     */
    return {
      status: 'degraded' as const,
      detail: `${drifting.length} timestamp ${drifting.length === 1 ? 'column defaults' : 'columns default'} `
        + `to the database's local clock rather than UTC (${named}${drifting.length > 3 ? ', …' : ''}): `
        + 'rows those defaults fill will sit hours away from every other row',
    }
  })
}

/**
 * Can we reach the queue, and is anything stuck in it.
 *
 * Depth is reported rather than judged. What counts as too many jobs depends
 * entirely on the instance, and a threshold guessed here would either fire
 * constantly on a busy one or never on a quiet one. What *is* judged is a job
 * that has been available for a long time, because that means nothing is
 * working the queue - a different fact from "there is a lot of work".
 */
async function queue(): Promise<Check> {
  return await timed('queue', async () => {
    /*
     * Can a job be *reserved*, which is a different question from whether the
     * table is there.
     *
     * `jobs` is created by a `CREATE TABLE IF NOT EXISTS`, so an instance whose
     * table predates the current definition keeps the older column types
     * forever. This one did: `reserved_at` was a `date` against a framework
     * that writes a unix timestamp, and `payload` a `varchar(255)` against a
     * JSON envelope. The effect is total and silent - every reservation sweep
     * dies with `operator does not exist: date <= integer`, no worker can ever
     * take a job, and the depth this check reports keeps climbing with no
     * explanation attached to it.
     *
     * Probed by doing the comparison rather than by reading the catalogue,
     * because the catalogue is a different query on every engine and the
     * comparison is the thing that has to work.
     */
    try {
      await db
        .selectFrom('jobs')
        .select('id')
        .where('reserved_at', '<=', Math.floor(Date.now() / 1000) as any)
        .limit(1)
        .execute()
    }
    catch (error) {
      return {
        status: 'degraded' as const,
        detail: 'the jobs table cannot compare `reserved_at` to a timestamp, so no worker can '
          + 'reserve anything - its columns predate the current schema. Repair with '
          + '`ALTER TABLE jobs ALTER COLUMN payload TYPE text` and '
          + '`ALTER TABLE jobs ALTER COLUMN reserved_at TYPE integer USING NULL` '
          + `(${error instanceof Error ? error.message : String(error)})`,
      }
    }

    const pending = await db
      .selectFrom('jobs')
      .select(db.fn.count('id').as('count'))
      .executeTakeFirst()

    const depth = Number(pending?.count ?? 0)

    const oldest = await db
      .selectFrom('jobs')
      .select(['created_at'])
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst()

    const waitedMs = oldest?.created_at ? Date.now() - Date.parse(String(oldest.created_at)) : 0

    // Five minutes. Long enough that a slow job or a burst does not trip it,
    // short enough that somebody hears about a stopped worker within a
    // deploy's worth of time.
    if (waitedMs > 5 * 60 * 1000)
      return { status: 'degraded' as const, detail: `${depth} jobs queued, oldest waiting ${Math.round(waitedMs / 1000)}s - is a worker running?` }

    return depth > 0 ? { status: 'ok' as const, detail: `${depth} queued` } : undefined
  })
}

/**
 * Is anything honouring the clock.
 *
 * The check that would have caught the worst deployment bug this instance has
 * had. `app/Scheduler.ts` declares the mirror sweep, the lease reclaim,
 * artifact expiry, WAL reconciliation, the nightly checkpoint and the ref-drift
 * audit - and **nothing in any documented deployment ran the scheduler**, so
 * none of it had ever fired. The instance was healthy by every measure it had:
 * the database answered, the disk was writable, and the queue was empty *because
 * nothing was filling it*. The only visible symptom was mirrors quietly going a
 * day stale with no error against them, on the one page that happens to show a
 * sync time.
 *
 * Measured from mirrors rather than from a heartbeat, and that is deliberate.
 * A heartbeat proves a process is alive; this proves the work is being done,
 * which is the question. `mirrorHealth` already knows what overdue means and is
 * tested for it, so the rule is not restated here.
 *
 * Silent on an instance with no mirrors: it has no evidence either way, and a
 * check that warns without evidence is a check people turn off.
 */
async function scheduledWork(): Promise<Check> {
  return await timed('scheduled work', async () => {
    const { staleMirrors } = await import('../Actions/Mirror/overdue')

    const mirrors = await db
      .selectFrom('repository_mirrors')
      .select(['enabled', 'interval_seconds', 'last_synced_at', 'last_error', 'failure_count'])
      .where('enabled', '=', true)
      .execute()

    const stalled = staleMirrors(mirrors as any[])

    if (stalled === 0)
      return undefined

    /*
     * Degraded rather than failed. An instance whose clock has stopped is still
     * serving every page correctly, and refusing traffic for it would turn a
     * background problem into an outage - the same reasoning as the queue check
     * two functions up.
     */
    return {
      status: 'degraded' as const,
      detail: `${stalled} ${stalled === 1 ? 'mirror is' : 'mirrors are'} overdue with nothing errored `
        + '- is `buddy schedule:run` running?',
    }
  })
}

/**
 * Is the disk the repositories live on there, and writable.
 *
 * Writable specifically, not merely present. A volume that failed to mount
 * leaves an empty directory behind that reads perfectly and accepts nothing,
 * and a read-only remount - what a filesystem does when it notices corruption -
 * looks identical to a healthy disk until the first push.
 */
async function repositoryStorage(writeProbe: boolean): Promise<Check> {
  return await timed('repository storage', async () => {
    const root = REPOSITORY_ROOT

    /*
     * Checked, never created.
     *
     * This used to `mkdirSync(root, { recursive: true })` before looking, and
     * that one line defeated the entire check - including the case the comment
     * above describes. A deploy shipped `storage/repos` as a symlink pointing
     * at a path that does not exist; the probe created a real directory in its
     * place, wrote a file into it, and reported healthy. The instance ran with
     * no repository storage at all, answering 200 to everything, while 151
     * mirrors were registered against a directory nothing else could see.
     *
     * A health check that repairs what it is inspecting cannot report on it.
     * Creating repository storage is the deploy's job, and its absence is
     * exactly the condition worth shouting about.
     */
    if (!existsSync(root)) {
      return {
        status: 'failed' as const,
        detail: `repository storage is missing at ${root} - the deploy did not create it, or a symlink points somewhere that does not exist`,
      }
    }

    if (!statSync(root).isDirectory()) {
      return {
        status: 'failed' as const,
        detail: `repository storage at ${root} is not a directory`,
      }
    }

    // The cheap half, for a liveness probe: it is there and it is a directory.
    if (!writeProbe)
      return undefined

    const probe = join(root, `.health-${process.pid}`)

    try {
      writeFileSync(probe, 'ok')
    }
    finally {
      // Removed whatever happened, so a failed probe does not leave a file
      // behind that the next one trips over.
      rmSync(probe, { force: true })
    }

    return undefined
  })
}

/** Run a check, time it, and turn a failure into a report rather than a 500. */
async function timed(
  name: string,
  work: () => Promise<{ status: CheckStatus, detail?: string } | undefined>,
): Promise<Check> {
  const started = Date.now()

  try {
    const outcome = await work()
    const ms = Date.now() - started

    if (outcome?.status && outcome.status !== 'ok')
      return { name, status: outcome.status, ms, ...(outcome.detail ? { detail: outcome.detail } : {}) }

    return {
      name,
      // Slow is not broken, and it is not fine either. A check that says `ok`
      // at four seconds never warns anybody before it starts failing.
      status: ms > SLOW_MS ? 'degraded' : 'ok',
      ms,
      ...(outcome?.detail ? { detail: outcome.detail } : ms > SLOW_MS ? { detail: `took ${ms}ms` } : {}),
    }
  }
  catch (error) {
    return {
      name,
      status: 'failed',
      ms: Date.now() - started,
      // The message, not the stack. This endpoint is unauthenticated, and a
      // stack trace names paths and packages a prober has no business reading.
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
