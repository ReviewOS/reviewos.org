import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { dbTimestamp } from '../Support/sql'

/**
 * Mark notifications read: one, several, or the whole filtered view.
 *
 * One endpoint for all three because they are one statement with a different
 * `WHERE`, and splitting them is how the ownership check ends up written three
 * times and forgotten once. That check is the only thing standing between this
 * and marking somebody else's inbox read, so it is applied unconditionally on
 * every path rather than per branch.
 *
 * **Read is a one-way door here.** There is no unmark, deliberately: "read"
 * means somebody looked, and a row they can flip back would make the unread
 * count a preference rather than a fact. What people actually want when they
 * reach for unread-again is to find the thing later, which is a saved item and
 * not a lie about history.
 *
 * `mark_all` is scoped by the same filters the inbox is looking at, not the
 * whole table. Marking everything read from a view showing one repository is
 * the single most destructive thing an inbox can do by accident, and it is
 * destructive precisely because it cannot be undone.
 */
export default new Action({
  name: 'MarkNotificationsRead',
  description: 'Mark notifications as read',
  method: 'POST',

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    // `read_at` is a real datetime column; see `dbTimestamp` for why an ISO
    // string is not a datetime literal.
    const now = dbTimestamp()
    const all = readFlag(request.get('mark_all'))
    const ids = readIds(request.get('ids') ?? request.get('id'))

    if (!all && ids.length === 0)
      return response.json({ error: 'Nothing to mark' }, 422)

    let query = db
      .updateTable('notifications')
      .set({ read_at: now })
      // The ownership check, on every path. Without it this endpoint reads
      // somebody else's inbox for them.
      .where('user_id', '=', user.id)
      // Already-read rows are left alone so `read_at` keeps saying when
      // somebody first looked, rather than when they last pressed the button.
      .whereNull('read_at')

    if (!all)
      query = query.where('id', 'in', ids)

    if (all) {
      // The same filters the view was showing. A repository filter that the
      // interface applies and the endpoint ignores is how somebody clears four
      // hundred rows meaning to clear six.
      const repository = String(request.get('repository') ?? '').trim()
      const reason = String(request.get('reason') ?? '').trim()

      if (repository || reason) {
        // `data` is JSON in a text column, so this filters in the application
        // rather than in SQL. Matching on a substring of the blob would count
        // a repository named in a pull request title as a repository filter.
        const rows = await db
          .selectFrom('notifications')
          .select(['id', 'data'])
          .where('user_id', '=', user.id)
          .whereNull('read_at')
          .execute()

        const matching = rows
          .filter((row) => {
            let data: any = {}
            try {
              data = row.data ? JSON.parse(row.data) : {}
            }
            catch {
              return false
            }

            if (repository && data.repository !== repository)
              return false

            if (reason && data.reason !== reason)
              return false

            return true
          })
          .map(row => Number(row.id))

        if (matching.length === 0)
          return response.json({ marked: 0 })

        query = query.where('id', 'in', matching)
      }
    }

    await query.execute()

    // Counted after the fact rather than from the update's row count, which the
    // drivers disagree about. The number the interface shows is the unread
    // count, and that is what is asked for.
    const remaining = await db
      .selectFrom('notifications')
      .select(db.fn.count('id').as('unread'))
      .where('user_id', '=', user.id)
      .whereNull('read_at')
      .executeTakeFirst()

    const unread = Number(remaining?.unread ?? 0)

    // A form post has nowhere to go afterwards, so it goes back to the inbox.
    // The page reads its own state on every load, so the count is right by
    // construction rather than by the response being believed.
    if (wantsHtml(request))
      return response.redirect('/notifications')

    return response.json({ unread })
  },
})

/** A checkbox, as a form sends it. */
function readFlag(value: unknown): boolean {
  const text = String(value ?? '').toLowerCase()

  return text === 'true' || text === '1' || text === 'on' || text === 'yes'
}

/** One id, a list of them, or a comma-separated field. Anything else is dropped. */
function readIds(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',')

  return [...new Set(
    raw
      .map(entry => Number(String(entry).trim()))
      .filter(id => Number.isInteger(id) && id > 0),
  )]
}

/** Whether this arrived from a form rather than from fetch. */
function wantsHtml(request: RequestInstance): boolean {
  const accept = String(request.header?.('accept') ?? request.headers?.get?.('accept') ?? '')

  return accept.includes('text/html')
}
