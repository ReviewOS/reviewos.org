/**
 * How long to wait before trying a failed step again.
 *
 * The parser already reads `retry: 2` and `retry: { attempts: 2, exit-status:
 * [137] }` - how many times, and for which failures. What it had no answer for
 * is *when*, and the answer matters more than it sounds: retrying a step that
 * failed because a registry was rate limiting, immediately, three times, is
 * three more requests to a service that just asked for fewer. Constant delay
 * fixes that case; exponential fixes the case where the service is down rather
 * than busy.
 *
 * ## Why jitter is not optional
 *
 * A matrix of twenty jobs that all fail against the same flaky dependency will
 * all retry at the same instant, and again at the same instant, and the
 * synchronized thundering herd is often what keeps the dependency down. The
 * jitter here is proportional and bounded, so a delay of ten seconds becomes
 * somewhere in eight to ten rather than exactly ten.
 *
 * ## Pure, and deliberately so
 *
 * Nothing here reads a clock or a database. A retry schedule that can only be
 * checked by waiting for it is one nobody tests, and the tests are the whole
 * reason to believe an exponential backoff does not overflow into a delay of
 * four years on attempt thirty.
 */

/** The shapes a workflow may ask for. */
export type Backoff = 'constant' | 'linear' | 'exponential'

export interface RetryPolicy {
  /** How many attempts in total, including the first. 1 means no retry. */
  attempts: number
  /** The base wait, in milliseconds. */
  delayMs: number
  backoff: Backoff
  /** A ceiling, so exponential does not become "next week". */
  maxDelayMs: number
  /**
   * Which exit statuses may be retried. Empty means any failure.
   *
   * The distinction people actually want: 137 is a machine that ran out of
   * memory and is worth another try on a bigger one; 1 is a test that failed
   * and will fail again.
   */
  exitStatuses: number[]
}

export const DEFAULT_POLICY: RetryPolicy = {
  attempts: 1,
  delayMs: 5_000,
  backoff: 'exponential',
  // Five minutes. Past that a workflow is waiting longer than most people wait
  // before rerunning it by hand, which makes the automation the slower path.
  maxDelayMs: 5 * 60_000,
  exitStatuses: [],
}

/**
 * Read a policy out of what the parser produced.
 *
 * Tolerant on the way in and strict on the way out: a value this cannot read
 * falls back to the default rather than failing the run, because a workflow
 * whose retry stanza has a typo should still run - it just should not retry in
 * some way nobody asked for.
 */
export function policyFrom(settings: unknown): RetryPolicy {
  const raw = (settings ?? {}) as Record<string, unknown>

  const attempts = Number(raw.attempts ?? raw.limit ?? DEFAULT_POLICY.attempts)
  const delay = Number(raw.delay ?? raw['delay-ms'] ?? DEFAULT_POLICY.delayMs)
  const maxDelay = Number(raw['max-delay'] ?? raw.maxDelay ?? DEFAULT_POLICY.maxDelayMs)
  const backoff = String(raw.backoff ?? DEFAULT_POLICY.backoff).toLowerCase()

  const statuses = Array.isArray(raw['exit-status'])
    ? (raw['exit-status'] as unknown[]).map(one => Number(one)).filter(one => Number.isInteger(one))
    : []

  return {
    // Bounded at both ends. Zero or a negative would mean "never run it",
    // which is not what anybody writing `retry:` meant; the ceiling is there
    // because a workflow asking for a thousand attempts of a failing step is a
    // loop with extra steps.
    attempts: Number.isFinite(attempts) ? Math.min(Math.max(Math.round(attempts), 1), 10) : DEFAULT_POLICY.attempts,
    delayMs: Number.isFinite(delay) && delay >= 0 ? Math.round(delay) : DEFAULT_POLICY.delayMs,
    backoff: (['constant', 'linear', 'exponential'] as const).includes(backoff as Backoff)
      ? backoff as Backoff
      : DEFAULT_POLICY.backoff,
    maxDelayMs: Number.isFinite(maxDelay) && maxDelay > 0 ? Math.round(maxDelay) : DEFAULT_POLICY.maxDelayMs,
    exitStatuses: statuses,
  }
}

/**
 * The wait before `attempt`, where the first retry is attempt 2.
 *
 * `jitter` is a number from 0 to 1 - passed in rather than generated, because
 * a function that reaches for randomness is one that cannot be tested and,
 * inside an orchestrator, one that breaks replay.
 */
export function delayFor(policy: RetryPolicy, attempt: number, jitter = 1): number {
  const retry = Math.max(0, Math.round(attempt) - 1)

  if (retry <= 0)
    return 0

  const raw = policy.backoff === 'constant'
    ? policy.delayMs
    : policy.backoff === 'linear'
      ? policy.delayMs * retry
      // Doubling from the base: retry 1 waits the base, retry 2 twice it.
      // Capped before the multiplication would overflow into a number nobody
      // meant, which at attempt 30 it certainly would.
      : policy.delayMs * 2 ** Math.min(retry - 1, 30)

  const capped = Math.min(raw, policy.maxDelayMs)

  /*
   * Proportional and bounded: a delay of ten seconds becomes eight to ten,
   * never twelve. Spreading upward would let a retry storm push itself past a
   * timeout that was set against the stated delay.
   */
  const spread = Math.max(0, Math.min(1, jitter))

  return Math.round(capped * (0.8 + 0.2 * spread))
}

/** Whether a failure is one this policy retries. */
export function shouldRetry(policy: RetryPolicy, attempt: number, exitStatus: number | null | undefined): boolean {
  if (attempt >= policy.attempts)
    return false

  if (policy.exitStatuses.length === 0)
    return true

  // A status nobody recorded cannot be matched against a list somebody wrote,
  // and guessing would retry the failures they excluded.
  if (exitStatus === null || exitStatus === undefined)
    return false

  return policy.exitStatuses.includes(Number(exitStatus))
}

/**
 * The whole schedule, for a screen or a log.
 *
 * A person deciding whether a retry policy is sane should be able to read what
 * it will actually do rather than simulate it in their head - "3 attempts, 5s
 * then 10s" is a sentence somebody can disagree with.
 */
export function scheduleOf(policy: RetryPolicy): number[] {
  return Array.from({ length: Math.max(0, policy.attempts - 1) }, (_, index) => delayFor(policy, index + 2, 1))
}
