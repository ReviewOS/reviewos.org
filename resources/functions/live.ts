import { writeHeaders } from './csrf'

/**
 * Watching a pull request change while you read it.
 *
 * **Polling is the baseline and the socket is an upgrade**, which is the
 * opposite of the usual arrangement and deliberate. Make the socket primary and
 * polling the fallback, and the fallback is the path nobody exercises - so it
 * is broken on the day the socket is not available, which is exactly the day it
 * matters. Here the poll always runs; a socket, when there is one, only makes
 * it faster.
 *
 * Both ask the same endpoint for the same shape, so there is no second
 * implementation to drift.
 *
 * **It reports counts, never content.** Splicing new comments into a page the
 * reader has scrolled, folded, or started a draft in means reconciling against
 * their unsaved work, and getting that wrong loses somebody's half-written
 * review. A banner costs a reload they choose and never takes anything.
 */

export interface LiveSnapshot {
  comments: number
  reviews: number
  head: string
  state: string
  watching: string[]
  watchingExtra: number
  pollAfterMs: number
}

export interface LiveHandle {
  /** Stop polling and close the socket. */
  stop: () => void
}

export interface LiveOptions {
  owner: string
  repository: string
  number: number
  /** Called whenever a reading arrives, changed or not. */
  onState: (state: LiveSnapshot) => void
  /** Called once per distinct change, with a sentence and whether it is stale. */
  onChange: (summary: string, stale: boolean) => void
}

/**
 * Start watching.
 *
 * Returns a handle rather than running forever. A page that navigates away with
 * a poll still running is a tab that keeps claiming presence and keeps asking -
 * and on a product people leave open all day, that is the difference between a
 * heartbeat and a leak.
 */
export function watchPullRequest(options: LiveOptions): LiveHandle {
  let stopped = false
  let timer: any = null
  let socket: WebSocket | null = null
  let previous: LiveSnapshot | null = null

  async function read(): Promise<void> {
    if (stopped)
      return

    try {
      const answer = await fetch('/api/repos/pulls/live', {
        method: 'POST',
        headers: writeHeaders('application/json'),
        body: JSON.stringify({
          owner: options.owner,
          repository: options.repository,
          number: options.number,
        }),
      })

      if (!answer.ok)
        return schedule(30_000)

      const state = (await answer.json()) as LiveSnapshot

      options.onState(state)

      if (previous) {
        const change = describe(previous, state)

        // Only on a transition. Reporting every reading would re-announce the
        // same three comments once a poll, which is how a banner becomes
        // something people learn to ignore.
        if (change.changed)
          options.onChange(change.summary, change.stale)
      }

      previous = state
      schedule(state.pollAfterMs || 20_000)
    }
    catch {
      // A failed read is not a reason to stop. The reader may have walked away
      // from a laptop that lost its network, and giving up would mean the page
      // is silently stale from then on - the exact failure the roadmap names.
      schedule(30_000)
    }
  }

  function schedule(ms: number): void {
    if (stopped)
      return

    clearTimeout(timer)
    // A socket does not stop the poll, it slows it. The poll is what keeps
    // presence alive and what catches anything the socket missed while the
    // laptop was asleep - a socket that reconnects has no idea what it lost.
    timer = setTimeout(read, socket ? Math.max(ms * 3, 60_000) : ms)
  }

  /**
   * Upgrade to a socket if one is there.
   *
   * Best effort in the strongest sense: no retry, no backoff, no reconnect
   * loop. If it is not available the poll is already running and the reader
   * loses nothing but latency, and a reconnect loop against a server that does
   * not speak WebSocket is a page that hammers it forever.
   */
  function upgrade(): void {
    if (typeof WebSocket === 'undefined')
      return

    try {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const channel = `pull.${options.owner}.${options.repository}.${options.number}`
      const next = new WebSocket(`${scheme}//${location.host}/ws?channel=${encodeURIComponent(channel)}`)

      next.addEventListener('open', () => {
        if (stopped)
          return next.close()

        socket = next
        schedule(60_000)
      })

      // The message is a nudge, not the state. Reading from the endpoint keeps
      // one source of truth and means a socket that sends something malformed
      // cannot put the page into a state the server never described.
      next.addEventListener('message', () => read())

      next.addEventListener('close', () => {
        socket = null
        // Straight back to the fast poll. The window between a socket dropping
        // and the next slow poll is where "silently going stale" lives.
        schedule(2_000)
      })

      next.addEventListener('error', () => {
        socket = null
      })
    }
    catch {
      // No socket. The poll is already running.
    }
  }

  read()
  upgrade()

  return {
    stop() {
      stopped = true
      clearTimeout(timer)
      socket?.close()
      socket = null
    },
  }
}

/** The same rules as the server's `describeChange`, for the client's banner. */
function describe(before: LiveSnapshot, after: LiveSnapshot): { changed: boolean, summary: string, stale: boolean } {
  const parts: string[] = []

  const comments = after.comments - before.comments
  const reviews = after.reviews - before.reviews

  if (comments > 0)
    parts.push(`${comments} new comment${comments === 1 ? '' : 's'}`)

  if (reviews > 0)
    parts.push(`${reviews} new review${reviews === 1 ? '' : 's'}`)

  const moved = Boolean(before.head && after.head && before.head !== after.head)

  if (after.state !== before.state)
    parts.push(`this pull request is now ${after.state}`)

  if (moved)
    parts.push('the branch has new commits')

  return {
    changed: parts.length > 0,
    summary: parts.join(', '),
    // A new comment leaves the diff correct and adds to it. A new head does
    // not: every line number on screen may have moved, and a draft anchored to
    // one is anchored to the wrong line.
    stale: moved || after.state !== before.state,
  }
}
