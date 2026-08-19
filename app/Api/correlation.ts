/**
 * One id that follows a request into the work it starts.
 *
 * The question this answers is the one support actually gets: *a program of
 * ours called your API twenty minutes ago and something odd happened - what did
 * that call do?* Without a correlation id the answer is reconstructed from
 * timestamps, and timestamps are the worst possible key on an instance where
 * three deploy bots dispatch the same workflow every few minutes.
 *
 * So a caller's `X-Request-Id` is kept, and one is minted when they send none.
 * Kept rather than replaced, because the whole value is on the caller's side:
 * they already logged that id beside their own stack trace, and an id this
 * instance invented is one they cannot search for.
 *
 * ## Where it goes
 *
 * Onto the run, and out to the machine in its claim. A dispatched run is the
 * longest-lived consequence an API call has - minutes of work on somebody
 * else's hardware - and it is exactly the consequence nobody can trace back
 * afterwards. A job that prints the id it was given makes a build log
 * searchable by the request that caused it.
 *
 * ## What it is not
 *
 * Not a credential, not a secret, and not trusted. It is a caller's own label,
 * bounded and stripped of anything that is not printable, and nothing anywhere
 * makes a decision on it. A value that decided something would be a value worth
 * forging.
 */

/** How much of a caller's id is kept. Long enough for a UUID, short enough for a column. */
const LIMIT = 120

/**
 * The id this request should be known by.
 *
 * `X-Request-Id` if the caller sent one, `X-Correlation-Id` if they sent that
 * instead - both are in the wild and a client that has to be told which one
 * this instance prefers is a client that will get it wrong.
 */
export function requestIdOf(request: { headers?: { get?: (name: string) => string | null } } | null | undefined): string {
  const sent = header(request, 'x-request-id') || header(request, 'x-correlation-id')
  const cleaned = clean(sent)

  return cleaned || mint()
}

/** One header, whatever the request object is. */
function header(request: any, name: string): string {
  try {
    return String(request?.headers?.get?.(name) ?? '')
  }
  catch {
    return ''
  }
}

/**
 * A caller's id, as a column can hold it.
 *
 * Printable ASCII only and bounded. A correlation id ends up in a log line, a
 * database column and an environment variable on somebody else's machine, and
 * a caller who sends a newline in one should not get to decide how any of those
 * three are shaped.
 */
export function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, LIMIT)
}

/** A new one, when the caller brought none. */
function mint(): string {
  return `req_${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('hex')}`
}
