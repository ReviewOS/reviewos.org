import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { parseScope } from './unsubscribe'

/**
 * Stop notifying somebody about one thread, from a link in an email.
 *
 * **POST, never GET.** Mail security scanners and link previewers fetch every
 * URL in a message before a human sees it, so an unsubscribe that acted on GET
 * would unsubscribe people who never opened the email. RFC 8058 says the same
 * thing for the same reason, and `List-Unsubscribe-Post` is what tells Gmail
 * its native button may post here. The GET route renders a page with a button
 * on it instead.
 *
 * No session. That is the entire point: somebody reading a notification at
 * 23:00 on their phone should be one tap from making it stop. Requiring a
 * sign-in first is how people give up and add a mail rule instead - and a mail
 * rule is invisible to this product forever, so a reviewer everybody is waiting
 * on becomes unreachable and nothing here knows why.
 *
 * The token is the credential, and it says who and what: the signature covers
 * the address *and* the scope, so a link cannot be edited from "this pull
 * request" into "everything".
 *
 * **The subscription is marked unsubscribed rather than deleted.** A deleted
 * row is one that a later comment would recreate, silently resubscribing
 * somebody who explicitly asked to stop - which is the single fastest way to
 * teach people that unsubscribing here does not work.
 */
export default new Action({
  name: 'Unsubscribe',
  description: 'Unsubscribe from one thread, from an emailed link',
  method: 'POST',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    token: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    // Off the path, so one URL serves both the page and the one-click POST.
    // Read from the pathname the way `ServeAttachmentAction` does rather than
    // through a params binding, which the router does not expose to an action.
    // The body field is the fallback for a caller that cannot put it in a path.
    const token = String(tokenFromPath(request) || request.get('token') || '')
    if (!token)
      return response.json({ error: 'That link is missing its token' }, 400)

    const { verifyUnsubscribeToken } = await import('@stacksjs/email')
    const verified: any = verifyUnsubscribeToken(token)

    if (!verified.valid) {
      // The reason travels back so the page can say "this link has expired"
      // rather than "something went wrong", which is the difference between
      // somebody asking for a new one and somebody giving up on the product.
      const expired = verified.reason === 'expired'

      return response.json(
        { error: expired ? 'That link has expired' : 'That link is not valid', reason: verified.reason },
        expired ? 410 : 400,
      )
    }

    const scope = parseScope(verified.scope)

    // No scope means no thread to unsubscribe from. Falling back to something
    // broader would turn a malformed link into a silent global opt-out, so it
    // refuses and the page points at the settings screen.
    if (!scope)
      return response.json({ error: 'That link does not name anything to unsubscribe from' }, 400)

    const user = await db
      .selectFrom('users')
      .select(['id'])
      .where('email', '=', String(verified.email))
      .executeTakeFirst()

    // A token for an address with no account is answered as though it worked.
    // Saying "no such user" would turn this endpoint into a way to test whether
    // an address has an account here, and there is nothing to unsubscribe
    // anyway.
    if (!user)
      return respond(request, { unsubscribed: true })

    const existing = await db
      .selectFrom('notification_subscriptions')
      .select(['id'])
      .where('user_id', '=', Number(user.id))
      .where('subject_type', '=', scope.type)
      .where('subject_id', '=', scope.id)
      .executeTakeFirst()

    if (existing) {
      await db
        .updateTable('notification_subscriptions')
        .set({ unsubscribed: true })
        .where('id', '=', Number(existing.id))
        .execute()
    }
    else {
      // Nothing was subscribing them, and a row is still written. Being
      // notified does not require a subscription row - a mention reaches
      // somebody who was never subscribed - so without this, unsubscribing from
      // the email that mentioned you would do nothing at all.
      await db.insertInto('notification_subscriptions').values({
        user_id: Number(user.id),
        subject_type: scope.type,
        subject_id: scope.id,
        reason: 'participating',
        unsubscribed: true,
      }).execute()
    }

    return respond(request, { unsubscribed: true, subject_type: scope.type, subject_id: scope.id })
  },
})

/** The last path segment, which is where the token is. */
function tokenFromPath(request: RequestInstance): string {
  try {
    return decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '')
  }
  catch {
    return ''
  }
}

/**
 * A page for a browser, JSON for everything else.
 *
 * Gmail's one-click posts here and reads only the status, so the body shape is
 * for the human who clicked the footer link.
 */
function respond(request: any, body: Record<string, unknown>) {
  const accept = String(request.header?.('accept') ?? request.headers?.get?.('accept') ?? '')

  if (accept.includes('text/html'))
    return response.redirect('/unsubscribed')

  return response.json(body)
}
