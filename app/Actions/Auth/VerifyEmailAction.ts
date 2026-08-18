import { Action } from '@stacksjs/actions'
import { sendVerificationEmail, verifyEmail } from '@stacksjs/auth'
import { currentUser } from '../Identity/lookup'
import { wantsHtml } from './session'

/**
 * Verify an email address, or ask for the link again.
 *
 * Overrides the framework default for one reason: that one answers JSON, and
 * this link is clicked in a mail client by a browser. A browser shown
 * `{"success":true}` has verified nothing as far as its reader can tell.
 *
 * **GET, because it is a link in an email**, which is the one place the usual
 * rule about GET not changing anything has to bend - a mail client cannot POST,
 * and asking somebody to copy a token into a form loses most of them. What
 * makes it safe enough is that the token is single-use, expires, and is
 * unguessable, so the worst a prefetching mail client can do is verify an
 * address its own user asked to verify.
 *
 * Resending is a POST from a signed-in reader and needs no token in the
 * request: it goes to the address on their own account, so there is no
 * parameter that could point it somewhere else.
 */
export default new Action({
  name: 'VerifyEmail',
  description: 'Verify an email address, or send the link again',
  method: 'GET',

  async handle(request: any) {
    if (String(request.method ?? 'GET').toUpperCase() === 'POST')
      return await resend(request)

    const userId = Number(request.get('id') ?? request.params?.id)
    const token = String(request.get('token') ?? request.params?.token ?? '')

    if (!Number.isInteger(userId) || userId <= 0 || !token)
      return answer(request, 422, { error: 'That verification link is not valid' })

    const result = await verifyEmail(userId, token)

    if (!result.success)
      return answer(request, 422, { error: result.message ?? 'That verification link is not valid or has expired' })

    // Not signed in as a side effect. Clicking a link in an email is not proof
    // of anything except reaching the mailbox, and a mailbox somebody else is
    // reading is exactly the case verification exists to notice.
    return answer(request, 200, { verified: true }, '/login?verified=1')
  },
})

/** Send the link again, to the address on the caller's own account. */
async function resend(request: any): Promise<Response> {
  const user = await currentUser(request)
  if (!user)
    return answer(request, 401, { error: 'Unauthenticated' })

  const row = await db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'email_verified_at'])
    .where('id', '=', user.id)
    .executeTakeFirst()

  if (!row)
    return answer(request, 404, { error: 'No such account' })

  // Already verified is success, not an error. The desired state holds, and the
  // way to reach this is a stale tab or a second click.
  if (row.email_verified_at)
    return answer(request, 200, { verified: true, already: true }, '/settings/profile?verified=1')

  try {
    await sendVerificationEmail({ id: Number(row.id), email: String(row.email), name: String(row.name ?? '') })
  }
  catch (error) {
    // A mail transport that is down is not the reader's problem to solve, and
    // telling them it failed invites them to press it repeatedly.
    console.error('[auth] verification resend:', error)
  }

  return answer(request, 200, { sent: true }, '/settings/profile?verification=sent')
}

/** JSON for a client, a redirect for a browser. The pattern the auth actions share. */
function answer(request: any, status: number, body: Record<string, unknown>, to?: string): Response {
  if (wantsHtml(request)) {
    const target = status < 400 && to
      ? to
      : `/login?error=${encodeURIComponent(String(body.error ?? 'That did not work'))}`

    return new Response(null, { status: 303, headers: { Location: target } })
  }

  return response.json(body, status)
}
