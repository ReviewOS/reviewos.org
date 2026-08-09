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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from '../Actions/Git/storage'
import { draining } from './shutdown'

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
    await queue(),
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
    const db = (globalThis as any).db

    const pending: any = await db
      .selectFrom('jobs')
      .select(db.fn.count('id').as('count'))
      .executeTakeFirst()

    const depth = Number(pending?.count ?? 0)

    const oldest: any = await db
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

    if (!writeProbe) {
      // The cheap half, for a liveness probe: the directory is there.
      mkdirSync(root, { recursive: true })
      return undefined
    }

    const probe = join(root, `.health-${process.pid}`)

    try {
      mkdirSync(root, { recursive: true })
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
