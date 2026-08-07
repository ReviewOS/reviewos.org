/**
 * Unsubscribing from a link in an email, without signing in.
 *
 * Somebody reading a notification at 23:00 on their phone should be one tap
 * from making it stop. Requiring a sign-in first is how people give up and add
 * a mail rule instead - and a mail rule is invisible to this product forever,
 * so the reviewer everybody is waiting on becomes unreachable and nothing here
 * knows.
 *
 * **Scoped to one thread, not to the address.** Unsubscribing from a pull
 * request is what somebody means when they press the button in an email about a
 * pull request. Treating it as "never email me again" is the interpretation
 * that loses people permanently, and it is the one they cannot undo without
 * finding a settings page they were already avoiding.
 *
 * The scope is signed into the token by `@stacksjs/email`, not carried beside
 * it: a scope in a query string is one anybody can edit, and editing it from
 * "this pull request" to "everything" is a one-character attack on somebody
 * else's settings.
 *
 * Pure over plain values. `UnsubscribeAction` does the database work.
 */

export type SubjectType = 'repository' | 'organization' | 'issue' | 'pull_request'

export interface Scope {
  type: SubjectType
  id: number
}

const TYPES: readonly string[] = ['repository', 'organization', 'issue', 'pull_request']

/** Thirty days. Long enough that an archived email still works months later. */
export const UNSUBSCRIBE_TTL = 30 * 24 * 60 * 60

/** `pull_request:42`, as the token carries it. */
export function scopeString(scope: Scope): string {
  return `${scope.type}:${scope.id}`
}

/**
 * Read a scope back, or null.
 *
 * Null covers both "the token had no scope" and "the token had a scope this
 * product does not recognise", and both mean the same thing here: there is no
 * thread to unsubscribe from, so the link falls back to offering the settings
 * page rather than guessing at something broader. Guessing broader is how a
 * malformed link turns into a silent global opt-out.
 */
export function parseScope(scope: string | undefined | null): Scope | null {
  if (!scope)
    return null

  const separator = scope.lastIndexOf(':')
  if (separator <= 0)
    return null

  const type = scope.slice(0, separator)
  const id = Number(scope.slice(separator + 1))

  if (!TYPES.includes(type) || !Number.isInteger(id) || id <= 0)
    return null

  return { type: type as SubjectType, id }
}

/**
 * What the page says the link will do.
 *
 * Written out rather than assembled from the type, because "this pull request"
 * and "this issue" are what a reader recognises and `pull_request` is not.
 */
export function describeScope(scope: Scope | null): string {
  if (!scope)
    return 'these notifications'

  switch (scope.type) {
    case 'pull_request':
      return 'this pull request'
    case 'issue':
      return 'this issue'
    case 'organization':
      return 'this organization'
    default:
      return 'this repository'
  }
}
