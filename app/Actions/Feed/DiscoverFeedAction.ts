import { Action } from '@stacksjs/actions'
import { discoverFeed, withHandles } from './read'

/**
 * Recent activity in repositories that are public on this instance.
 *
 * The page renders its first batch on the server. This endpoint carries the
 * same read for clients and for later pages, using the last event id as the
 * cursor so a long feed never pays an offset scan.
 */
export default new Action({
  name: 'DiscoverFeed',
  description: 'Recent activity in public repositories',
  method: 'GET',

  async handle(request: any) {
    const before = Number(request.get('before'))
    const page = await withHandles(await discoverFeed({
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
      cursor: page.cursor,
    })
  },
})
