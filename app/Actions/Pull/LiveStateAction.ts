import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { isPresent, PRESENCE_TTL_MS, roster } from './live'

/**
 * What a pull request looks like right now, and who else is here.
 *
 * **This is the whole realtime surface.** A socket pushes the same shape and a
 * poll asks for it, and both end up here - so the fallback cannot drift from
 * the live path. The usual arrangement makes the socket primary and polling an
 * emergency route, which means the emergency route is the one nobody exercises
 * and the one that is broken when it is finally needed.
 *
 * It is also the heartbeat: asking is how a reader says they are still looking.
 * Presence and freshness are the same round trip, because two would mean a page
 * that reports itself present while showing stale content.
 *
 * Authorized as a read of the repository, so a private pull request's activity
 * is exactly as private as the pull request. Presence is the sharper edge:
 * "who is looking at this" is information about people, and answering it to
 * anybody who can guess a number would be a way to watch a team work.
 */
export default new Action({
  name: 'PullRequestLiveState',
  description: 'Current activity on a pull request, and who is watching it',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user: viewer } = auth.context
    const number = Number(request.get('number'))

    if (!Number.isInteger(number) || number <= 0)
      return response.json({ error: 'A pull request number is required' }, 422)

    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['id', 'state', 'head_sha'])
      .where('repository_id', '=', Number(repository.id))
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const issue = await db
      .selectFrom('issues')
      .select(['id'])
      .where('repository_id', '=', Number(repository.id))
      .where('number', '=', number)
      .executeTakeFirst()

    const [comments, reviews] = await Promise.all([
      issue
        ? countOf('issue_comments', 'commentable_id', Number(issue.id))
        : Promise.resolve(0),
      countOf('pull_request_reviews', 'pull_request_id', Number(pullRequest.id)),
    ])

    const now = Date.now()
    const watching = viewer
      ? await heartbeat(Number(pullRequest.id), Number(viewer.id), String(viewer.handle ?? ''), now)
      : []

    const seen = roster(watching, String(viewer?.handle ?? ''))

    return response.json({
      comments,
      reviews,
      head: String(pullRequest.head_sha ?? ''),
      state: String(pullRequest.state ?? 'open'),
      watching: seen.shown,
      watchingExtra: seen.extra,
      // The client uses this rather than a hard-coded interval, so the cadence
      // is the server's to change - a busy instance can slow every poller down
      // without shipping anything.
      pollAfterMs: Math.round(PRESENCE_TTL_MS / 3),
    })
  },
})

/** One indexed count. */
async function countOf(table: string, column: string, id: number): Promise<number> {
  const row = await db
    .selectFrom(table as any)
    .select(db.fn.count('id').as('n'))
    .where(column, '=', id)
    .executeTakeFirst()

  return Number(row?.n ?? 0)
}

/**
 * Record that this reader is here, and report who else is.
 *
 * Presence lives in the cache rather than in a table. It is true for sixty
 * seconds and worthless after, and a row per reader per pull request would be
 * a write on every heartbeat from every open tab - which is the one query
 * pattern guaranteed to be the busiest in the product.
 *
 * Never throws. A cache that is down should cost the presence line, not the
 * freshness check next to it: the reader still needs to know a new comment
 * arrived, and "who else is here" is the garnish.
 */
async function heartbeat(pullRequestId: number, userId: number, handle: string, now: number): Promise<string[]> {
  const key = `pull:${pullRequestId}:watching`

  try {
    const { cache } = await import('@stacksjs/cache')
    const current: any = (await cache.get(key)) ?? {}

    const next: Record<string, { handle: string, at: number }> = typeof current === 'object' && current !== null
      ? current
      : {}

    next[String(userId)] = { handle, at: now }

    // Expired readers are dropped on write rather than swept. A tab that
    // closed leaves nothing behind to clean up, and the next heartbeat from
    // anybody at all is what removes it.
    for (const [id, entry] of Object.entries(next)) {
      if (!isPresent(Number(entry?.at ?? 0), now))
        delete next[id]
    }

    // Twice the TTL, so the key outlives the entries in it. An expiry equal to
    // the TTL would drop the whole roster at the moment the last heartbeat is
    // still valid.
    await cache.set(key, next, Math.ceil((PRESENCE_TTL_MS * 2) / 1000))

    return Object.values(next).map(entry => String(entry.handle))
  }
  catch {
    // No cache, no presence. The reader is told nothing rather than told
    // wrongly that they are alone.
    return []
  }
}
