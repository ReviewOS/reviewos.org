/**
 * **What a job's output costs this instance**
 *
 * Two numbers: how much of it one job may write, and how long any of it is
 * kept. Both were constants in `app/Actions/Runner/logs.ts` with a comment
 * saying they belonged here eventually - which is the right instinct, because
 * they are the two settings whose correct value depends entirely on the disk
 * somebody bought.
 *
 * Its own file rather than a key in an existing one, for the reason
 * `config/git-wal.ts` and `config/push-protection.ts` are: those framework
 * configs carry types from `@stacksjs/types` that do not describe a ReviewOS
 * feature setting.
 *
 * ## The ceiling is enforced on the way in
 *
 * A runner that streams forever is not stopped by a retention policy that runs
 * tomorrow - it fills the disk tonight. Past the ceiling an append is accepted
 * and discarded with one line saying so, because a truncated log that says it
 * was truncated is honest and a runner that starts failing its uploads is a job
 * that fails for a reason nobody can act on.
 *
 * ## Retention is a promise, not a cleanup
 *
 * The default is off: an instance that has never thought about this should keep
 * its build logs, because the first time somebody wants one is six weeks after
 * they stopped caring about the run. Setting it says "these are worth less than
 * the disk", which is a decision an operator makes rather than one a default
 * makes for them.
 *
 * A log deleted by retention leaves its job, its steps, its timings and its
 * conclusion behind. What goes is the text - which is the large part and the
 * part that ages worst.
 */

export interface CiLogsConfig {
  /** The most output one job may store, in bytes. */
  maxJobBytes: number
  /** How long a job's output is kept, in days. Zero keeps it forever. */
  retentionDays: number
}

/**
 * The ceiling per job.
 *
 * Two megabytes of text is an enormous build log - tens of thousands of lines -
 * and small enough that a thousand of them is two gigabytes. It is not a law of
 * nature; a wrong ceiling is recoverable and no ceiling is not.
 */
export function maxJobLogBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CI_LOG_MAX_BYTES ?? 0)

  // A ceiling below a single chunk would discard every append, which is a
  // configuration that silently turns logs off. Floored well above that.
  return Number.isFinite(raw) && raw >= 64 * 1024 ? Math.floor(raw) : 2 * 1024 * 1024
}

/**
 * How long output is kept.
 *
 * Zero - the default - keeps it as long as the run exists. An operator who sets
 * this is saying the text is worth less than the disk it sits on, which is
 * true on a busy instance and false on most.
 */
export function logRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CI_LOG_RETENTION_DAYS ?? 0)

  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

export default {
  maxJobBytes: maxJobLogBytes(),
  retentionDays: logRetentionDays(),
} satisfies CiLogsConfig
