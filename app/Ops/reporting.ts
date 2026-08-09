/**
 * Sending an error somewhere an operator will see it.
 *
 * **Off unless configured**, and that default is the product decision rather
 * than laziness: this is self-hosted software, and software that phones home by
 * default is software people stop trusting. Nothing leaves an instance until
 * somebody sets `ERROR_REPORTING_URL`.
 *
 * A webhook rather than an SDK for a named service. An SDK is a dependency, a
 * supply-chain surface, and a bet on which vendor the operator uses; a POST of
 * JSON is something Sentry, a Slack relay, an internal collector and a file on
 * a box behind `nc` can all accept. The people running one of these have a
 * pipeline already.
 *
 * ## What matters more than delivery
 *
 * Three things, in this order:
 *
 * 1. **Never leak a secret.** A stack trace and a request context are the two
 *    places credentials most reliably turn up - a connection string in a
 *    message, a bearer in a header, a password in a form body. Redaction is not
 *    a nicety here: an error reporter is a machine for taking the contents of
 *    your process and posting them to a third party.
 * 2. **Never fail the request.** The report is a consequence of a failure that
 *    already happened; making it a second one is worse than losing it.
 * 3. **Never become the outage.** An error loop sends the same report a
 *    thousand times a minute, which fills somebody's quota, costs them money,
 *    and buries the one report that mattered. So the same error is sent once
 *    per window and counted rather than repeated.
 */

export interface Report {
  message: string
  /** Where it happened, when the runtime gave us that. */
  stack?: string
  /** The request id, so a report in somebody's dashboard joins to a log line here. */
  traceId?: string
  /** Whatever the caller thought was relevant, after redaction. */
  context?: Record<string, unknown>
  /** How many of this error were suppressed since the last one was sent. */
  suppressed?: number
}

export interface ReportingConfig {
  url: string
  /** Sent as `Authorization`, if the collector wants one. */
  token?: string
  /** How long to wait before giving up. */
  timeoutMs: number
  /** How long one error's fingerprint stays quiet after being reported. */
  windowMs: number
}

/**
 * The reporting configuration, or null when it is off.
 *
 * Read per call rather than cached, because a test that sets the variable and a
 * process that reloads its environment should both take effect - and because
 * reading two strings is not a cost worth caching.
 */
export function reportingConfig(env: Record<string, string | undefined> = process.env): ReportingConfig | null {
  const url = String(env.ERROR_REPORTING_URL ?? '').trim()
  if (!url)
    return null

  // An address that is not an address is off, loudly at boot rather than
  // silently at the first error - `app/Ops/config.ts` is where that is said.
  if (!/^https?:\/\//.test(url))
    return null

  return {
    url,
    token: String(env.ERROR_REPORTING_TOKEN ?? '').trim() || undefined,
    timeoutMs: Number(env.ERROR_REPORTING_TIMEOUT_MS ?? 3000) || 3000,
    windowMs: Number(env.ERROR_REPORTING_WINDOW_MS ?? 300_000) || 300_000,
  }
}

/**
 * Anything that looks like a credential, replaced.
 *
 * Deliberately aggressive. The cost of redacting something harmless is a report
 * that says `[redacted]` where it could have said `main`; the cost of missing
 * one is a live credential in a third party's database, in a message somebody
 * else's alerting will forward to a chat channel.
 *
 * Pure, and exported, because this is the part worth testing hardest.
 */
export function redact(value: string): string {
  return value
    // This project's own tokens. The prefix is public and the secret is not, so
    // the prefix survives - it is what identifies which token to revoke.
    .replace(/\b(ros_[a-f0-9]+)_[a-f0-9]+\b/gi, '$1_[redacted]')
    // Bearer and basic credentials, wherever they appear in prose or a header
    // dump.
    .replace(/\b(bearer|basic)\s+[\w\-.=+/]+/gi, '$1 [redacted]')
    // A connection string's password: postgres://user:secret@host
    .replace(/(\w+:\/\/[^:/\s]+:)[^@\s]+@/g, '$1[redacted]@')
    // `password=x`, `secret: y`, `token" : "z"` in any of the shapes a body or
    // a query string produces.
    .replace(/\b(password|passwd|secret|token|api[_-]?key|authorization)\b(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi, '$1$2[redacted]')
    /*
     * Anything long enough to be a key, in a field nobody named.
     *
     * Hashes are exempt at the lengths hashes actually are - 7 and 8 for an
     * abbreviated sha, 32, 40 and 64 for md5, sha1 and sha256 - because a
     * commit sha is the single most useful token in a git-related report.
     *
     * "Any string of hex characters" was the first version of that rule and it
     * was far too loose: `Ab3Ab3Ab3...` is hex, sixty characters long, and
     * exactly the shape of a key.
     */
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, match => (isHash(match) ? match : '[redacted]'))
}

/** Whether this is a hash at a length hashes are, rather than merely hex-ish. */
function isHash(value: string): boolean {
  return /^[a-f0-9]+$/i.test(value) && [7, 8, 32, 40, 64].includes(value.length)
}

/** The same treatment, through a structure. */
export function redactContext(context: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> | undefined {
  if (!context || depth > 4)
    return undefined

  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(context)) {
    /*
     * The key decides first. A field *called* `password` is redacted whatever
     * its value looks like, because a short password is exactly the one the
     * value-shaped rules above would let through.
     */
    if (/pass|secret|token|key|authorization|cookie/i.test(key)) {
      out[key] = '[redacted]'
      continue
    }

    if (typeof value === 'string')
      out[key] = redact(value)
    else if (value && typeof value === 'object' && !Array.isArray(value))
      out[key] = redactContext(value as Record<string, unknown>, depth + 1)
    else
      out[key] = value
  }

  return out
}

/**
 * A fingerprint for "the same error".
 *
 * The message with its variable parts removed, plus the first frame of the
 * stack. Numbers, ids and paths are stripped so `user 4181 not found` and
 * `user 9022 not found` are one error rather than two - which is the difference
 * between suppressing a loop and suppressing nothing.
 */
export function fingerprint(report: { message: string, stack?: string }): string {
  const generalised = report.message
    .replace(/\b\d+\b/g, 'N')
    .replace(/\b[0-9a-f]{7,}\b/gi, 'H')
    .slice(0, 200)

  const frame = String(report.stack ?? '').split('\n').find(line => line.includes('at ')) ?? ''

  return `${generalised}|${frame.trim().slice(0, 200)}`
}

/** When each fingerprint was last sent, and how many were suppressed since. */
const recent = new Map<string, { sentAtMs: number, suppressed: number }>()

/**
 * Whether to send this one, and what to say about the ones we did not.
 *
 * Exported separately from sending so the suppression rule is testable without
 * a network - it is the part that decides whether an error loop costs somebody
 * their quota.
 */
export function decideSend(
  key: string,
  windowMs: number,
  nowMs: number = Date.now(),
): { send: boolean, suppressed: number } {
  const seen = recent.get(key)

  if (!seen || nowMs - seen.sentAtMs >= windowMs) {
    const suppressed = seen?.suppressed ?? 0
    recent.set(key, { sentAtMs: nowMs, suppressed: 0 })

    // The count travels with the next report that *is* sent, so a loop shows up
    // as one report saying "and 4,812 more" rather than as silence.
    return { send: true, suppressed }
  }

  recent.set(key, { sentAtMs: seen.sentAtMs, suppressed: seen.suppressed + 1 })

  return { send: false, suppressed: seen.suppressed + 1 }
}

/**
 * Report an error, if reporting is on.
 *
 * Never throws and never waits on the network for longer than the timeout. The
 * caller is on a path that has already failed; this must not make that worse.
 */
export async function report(input: {
  error: unknown
  context?: Record<string, unknown>
  traceId?: string
}, env: Record<string, string | undefined> = process.env): Promise<'sent' | 'suppressed' | 'off' | 'failed'> {
  const config = reportingConfig(env)
  if (!config)
    return 'off'

  try {
    const error = input.error
    const message = redact(error instanceof Error ? error.message : String(error))
    const stack = error instanceof Error && error.stack ? redact(error.stack) : undefined

    const decision = decideSend(fingerprint({ message, stack }), config.windowMs)
    if (!decision.send)
      return 'suppressed'

    const body: Report = {
      message,
      stack,
      traceId: input.traceId ?? currentTrace(),
      context: redactContext(input.context),
      ...(decision.suppressed > 0 ? { suppressed: decision.suppressed } : {}),
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)

    try {
      const answer = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      return answer.ok ? 'sent' : 'failed'
    }
    finally {
      clearTimeout(timer)
    }
  }
  catch {
    /*
     * Swallowed, and deliberately not logged.
     *
     * The caller is already handling an error; a second line saying the report
     * of it failed is noise on the path somebody is reading to understand the
     * first. A collector that is down shows up as an absence of reports, which
     * is what the collector's own monitoring is for.
     */
    return 'failed'
  }
}

/** The active trace, when there is one, so a report joins to the local log. */
function currentTrace(): string | undefined {
  try {
    const storage = (globalThis as Record<symbol, unknown>)[Symbol.for('stacks.router.traceStorage')] as
      | { getStore: () => string | undefined }
      | undefined

    return storage?.getStore?.()
  }
  catch {
    return undefined
  }
}

/** For tests, which need to send the same error twice. */
export function resetReporting(): void {
  recent.clear()
}
