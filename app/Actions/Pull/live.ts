/**
 * What changed on a pull request since you opened it, and who else is here.
 *
 * **One shape, served by two transports.** A socket pushes it and a poll asks
 * for it, and both call the same function - so the fallback cannot drift from
 * the live path. That is the whole design decision here: the usual arrangement
 * makes the socket primary and polling an emergency path, which means the
 * emergency path is the one nobody exercises and the one that is broken when it
 * is finally needed.
 *
 * **It reports counts, not content.** A live view that splices new comments
 * into the page has to reconcile them against a diff the reader may have
 * scrolled, folded, or started a draft in - and getting that wrong loses
 * somebody's half-written review, which is unforgivable in a review tool. A
 * banner saying "3 new comments" costs a reload the reader chooses, and never
 * takes anything from them.
 *
 * Pure over plain rows, so the counting rules are testable without a socket.
 */

/** A version of a pull request's conversation, as far as a reader is concerned. */
export interface LiveState {
  /** Comments on the conversation. */
  comments: number
  /** Reviews submitted. */
  reviews: number
  /** The head commit, so a force push or a new commit is visible. */
  head: string
  /** `open`, `closed`, or `merged`. */
  state: string
  /** Handles looking at this pull request right now. */
  watching: string[]
}

export interface LiveChange {
  /** Whether anything at all moved. */
  changed: boolean
  /** One sentence, or an empty string when nothing did. */
  summary: string
  /**
   * Whether the change makes what is on screen *wrong* rather than incomplete.
   *
   * A new comment leaves the diff correct and adds to it. A new head commit
   * does not: every line number on screen may have moved, and any draft
   * anchored to one is now anchored to the wrong line. The interface says so
   * differently, because "reload when you like" and "what you are reading is
   * stale" are different messages.
   */
  stale: boolean
}

/** The channel a pull request's watchers share. */
export function channelFor(repositoryId: number, number: number): string {
  return `pull.${Number(repositoryId)}.${Number(number)}`
}

/**
 * What moved between two readings.
 *
 * Counts rather than diffs, because the reader is being told whether to reload,
 * not being shown what they missed. "3 new comments" is the whole message, and
 * anything more precise would need the content this deliberately does not send.
 */
export function describeChange(before: LiveState, after: LiveState): LiveChange {
  const parts: string[] = []

  const comments = after.comments - before.comments
  const reviews = after.reviews - before.reviews

  if (comments > 0)
    parts.push(`${comments} new comment${comments === 1 ? '' : 's'}`)

  if (reviews > 0)
    parts.push(`${reviews} new review${reviews === 1 ? '' : 's'}`)

  // Deliberately not counted alongside the others. A head that moved means the
  // diff on screen is of a commit that is no longer the head, and saying "1 new
  // comment and a new commit" buries the half that matters.
  const moved = Boolean(before.head && after.head && before.head !== after.head)

  if (after.state !== before.state)
    parts.push(`this pull request is now ${after.state}`)

  if (moved)
    parts.push('the branch has new commits')

  return {
    changed: parts.length > 0,
    summary: parts.join(', '),
    stale: moved || after.state !== before.state,
  }
}

/**
 * Who to show as present, and in what order.
 *
 * The reader is dropped from their own roster: "you are looking at this" is not
 * information, and including it makes an empty room read as one person.
 *
 * Sorted and capped. Presence is a glance - "somebody else is in here" is the
 * whole signal, and a list of thirty faces on a busy repository is a widget
 * rather than an answer.
 */
export function roster(handles: readonly string[], viewer: string, limit = 5): { shown: string[], extra: number } {
  const others = [...new Set(handles.filter(handle => handle && handle !== viewer))].sort()

  return {
    shown: others.slice(0, limit),
    extra: Math.max(0, others.length - limit),
  }
}

/**
 * The sentence for a presence roster.
 *
 * Written out rather than assembled from a count, because the useful phrasing
 * changes with the number: one name is worth saying, and six is not.
 */
export function presenceText(shown: readonly string[], extra: number): string {
  if (shown.length === 0)
    return ''

  if (extra > 0)
    return `${shown.slice(0, 2).join(', ')} and ${shown.length - 2 + extra} others are looking at this`

  if (shown.length === 1)
    return `${shown[0]} is looking at this`

  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]} are looking at this`
}

/**
 * How long a presence claim survives without a heartbeat.
 *
 * Generous, deliberately. A reader who closed the tab disappears within a
 * minute, and a reader whose laptop slept for thirty seconds does not flicker
 * out and back in - and the flicker is worse than the staleness, because it
 * makes the whole signal look unreliable.
 */
export const PRESENCE_TTL_MS = 60_000

/** Whether a heartbeat is recent enough to count as present. */
export function isPresent(lastSeenMs: number, nowMs: number): boolean {
  return nowMs - lastSeenMs < PRESENCE_TTL_MS
}
