/**
 * Things the generated OpenAPI document says about every endpoint.
 *
 * An action declares what it answers with; the pieces that are true of the
 * whole surface live here so they are written once and cannot drift into
 * seventeen slightly different sentences.
 */

/**
 * The rate-limit headers every throttled response carries.
 *
 * On the response rather than in it, which is why they need declaring
 * separately: a client that only reads a body learns nothing about its budget
 * until it is refused, and a document that omits them describes an API that
 * appears to have no limits until somebody meets one at three in the morning.
 *
 * The names match what `app/Api/rate-limit.ts` actually sends - `X-RateLimit-*`
 * rather than RFC 9331's `RateLimit-*`, for the reason set out there - and if
 * that ever changes, both have to. Documenting a header the API does not send
 * is worse than documenting nothing: a client written against it reads
 * `undefined` and treats it as zero.
 */
export const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit': {
    description: 'How many requests this credential may make in the current window.',
    schema: { type: 'integer' },
  },
  'X-RateLimit-Remaining': {
    description: 'How many are left. Zero means the next request is refused with 429.',
    schema: { type: 'integer' },
  },
  'X-RateLimit-Reset': {
    description: 'When the window resets, as seconds since the epoch.',
    schema: { type: 'integer' },
  },
} as const

/**
 * The answers a repository-scoped endpoint gives when the caller may not have it.
 *
 * `404` for a repository the caller cannot see is the important one and the one
 * a generated client most needs a branch for: a `403` would confirm that a
 * private repository exists, so this surface answers as though it does not.
 */
export const REPOSITORY_ERRORS = {
  401: { description: 'No credential, or one this instance does not recognise.' },
  403: { description: 'The caller may see this repository but not do this to it, or their token does not carry the permission.' },
  404: { description: 'No such repository, or one this caller may not see - deliberately the same answer.' },
} as const
