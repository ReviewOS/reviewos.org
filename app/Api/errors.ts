/**
 * Errors that name the field and the fix.
 *
 * **"Validation failed" costs a retry loop that will never succeed.** An agent
 * that gets a 422 with no detail has three options: give up, retry the same
 * request forever, or guess. All three are bad, and the third is the one that
 * fills an issue tracker with near-miss attempts.
 *
 * So every error carries three things a program can act on:
 *
 * - a **stable code**, which is the only part it should branch on. Messages get
 *   reworded, translated and improved; a client keyed on the prose breaks when
 *   somebody fixes a typo.
 * - the **field**, when there is one, so a client knows which of the eleven
 *   things it sent was wrong rather than resubmitting all of them.
 * - a **fix**, in words. Not a restatement of the rule - "must match pattern
 *   ^[a-z]" tells somebody what failed, not what to do.
 */

/**
 * The codes, as a closed set.
 *
 * Closed on purpose: a client can exhaustively handle these, and adding one is
 * a deliberate act that shows up in review rather than a string somebody typed
 * at a call site. The names describe the *situation* rather than the HTTP
 * status, because two different situations share a status all the time.
 */
export const ERROR_CODES = {
  /** The request is malformed in a way no field can localise. */
  invalid_request: 400,
  /** A named field is wrong. Carries `field`. */
  invalid_field: 422,
  /** A required field is absent. Carries `field`. */
  missing_field: 422,
  /** No credential, or one that is not valid. */
  unauthenticated: 401,
  /** A valid credential that may not do this. */
  forbidden: 403,
  /** The thing is not here, or is not visible to this caller. */
  not_found: 404,
  /** The request contradicts the current state. */
  conflict: 409,
  /** An idempotency key was reused with a different body. */
  idempotency_conflict: 422,
  /** An idempotent request is still being processed. */
  idempotency_in_flight: 409,
  /** Too many requests. Always paired with `Retry-After`. */
  rate_limited: 429,
  /** Something here broke. */
  internal: 500,
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export interface ApiErrorBody {
  error: {
    code: ErrorCode
    message: string
    /** The field at fault, in the shape the request used. */
    field?: string
    /** What to do about it, in words. */
    fix?: string
    /** Set on `rate_limited`, in seconds, and true rather than fixed. */
    retryAfter?: number
  }
}

/**
 * An error response.
 *
 * The status comes from the code rather than from the caller, so the two cannot
 * disagree - a `not_found` answered with a 200 is the kind of thing that only
 * shows up when somebody's retry loop never terminates.
 */
export function apiError(
  code: ErrorCode,
  message: string,
  detail: { field?: string, fix?: string, retryAfter?: number, headers?: Record<string, string> } = {},
): Response {
  const status = ERROR_CODES[code]

  const body: ApiErrorBody = {
    error: {
      code,
      message,
      ...(detail.field ? { field: detail.field } : {}),
      ...(detail.fix ? { fix: detail.fix } : {}),
      ...(detail.retryAfter !== undefined ? { retryAfter: detail.retryAfter } : {}),
    },
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...detail.headers,
  }

  // `Retry-After` on the response as well as in the body. A client using a
  // generic HTTP layer reads the header; one written against this API reads the
  // body. Sending only one means half of them busy-loop.
  if (detail.retryAfter !== undefined)
    headers['Retry-After'] = String(Math.max(1, Math.ceil(detail.retryAfter)))

  return new Response(JSON.stringify(body), { status, headers })
}

/** A missing field, phrased as what to do. */
export function missingField(field: string, fix: string): Response {
  return apiError('missing_field', `${field} is required`, { field, fix })
}

/** A field that is present and wrong. */
export function invalidField(field: string, message: string, fix: string): Response {
  return apiError('invalid_field', message, { field, fix })
}
