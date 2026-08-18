import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { dashboardFeed, withHandles } from './read'

/**
 * What happened in the repositories this reader watches.
 *
 * The dashboard page renders its first page on the server, like every other
 * page here. This exists for the second page and beyond: a feed is the one
 * screen people page through, and a full reload per page would lose their
 * scroll position every time.
 *
 * Keyset paginated. `before` is the id of the last row the reader has, so every
 * page costs the same - `OFFSET 200` would make Postgres read and discard two
 * hundred rows to return twenty, and the pages people actually reach are the
 * expensive ones.
 */
export default new Action({
  name: 'DashboardFeed',
  description: 'Activity from the repositories the caller watches',
  method: 'GET',

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const before = Number(request.get('before'))

    const page = await withHandles(await dashboardFeed({
      viewerId: user.id,
      before: Number.isInteger(before) && before > 0 ? before : null,
    }))

    return response.json({
      entries: page.entries.map(entry => ({
        id: entry.id,
        actor: entry.actorHandle,
        verb: entry.verb,
        phrase: entry.phrase,
        target: entry.target,
        title: entry.title,
        url: entry.url,
        at: new Date(entry.at).toISOString(),
      })),
      // Null means there is no more, which is what the page needs to stop
      // offering a button that would return nothing.
      cursor: page.cursor,
    })
  },
})
