import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { currentUser } from '../Identity/lookup'
import { loadInbox } from './read'

/**
 * Somebody's inbox, as JSON.
 *
 * The page does not use this - it renders on the server from `loadInbox` for
 * the reason the review queue does: an inbox is a list of links, and a page
 * that reads its own state on every load can never show a stale count. This
 * exists for everything that is not the page: a client, a script that wants to
 * know what is waiting, an editor extension.
 *
 * There is no `user` parameter. An inbox is per person by definition, and an
 * endpoint that could name somebody else's is one authorization mistake away
 * from being a way to read it.
 */
export default new Action({
  name: 'ListNotifications',
  description: 'The signed-in user\'s notification inbox',
  method: 'GET',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    reason: { rule: schema.string() },
    repository: { rule: schema.string() },
    unread: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const inbox = await loadInbox(user.id, {
      reason: request.get('reason') ? String(request.get('reason')) : null,
      repository: request.get('repository') ? String(request.get('repository')) : null,
      unreadOnly: String(request.get('unread') ?? '') === 'true',
    })

    return response.json({
      unread: inbox.unread,
      truncated: inbox.truncated,
      repositories: inbox.repositories,
      notifications: inbox.entries.map(entry => ({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        url: entry.url,
        reason: entry.reason,
        repository: entry.repository,
        number: entry.number,
        read: entry.read,
        // Repeated notifications about one thing arrive collapsed, with the
        // count, because that is what the reader is being asked to act on. A
        // client that wants them separately can ask for them unfiltered and
        // group differently; a client that does not want to think about it gets
        // the same list the page shows.
        count: entry.count,
        created_at: new Date(entry.createdAt).toISOString(),
      })),
    })
  },
})
