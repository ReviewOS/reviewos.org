import { Action } from '@stacksjs/actions'
import { passwordResets } from '@stacksjs/auth'
import { wantsHtml } from './session'

/**
 * Ask for a password reset link, and use one.
 *
 * One endpoint for both halves of the flow, because they are the same
 * conversation and splitting them means two places that have to agree on how a
 * token is spelled. `operation=request` sends the mail; anything else with a
 * token resets.
 *
 * **The request half always answers the same way.** Whether the address is
 * registered here or not, the reply is "if that address has an account, a link
 * is on its way". Reporting the difference turns a public endpoint into a way
 * to test whether somebody has an account on this forge, which is the first
 * step of every credential-stuffing run - and on a forge it is worse than
 * usual, because the answer is also "does this person work here".
 *
 * Everything the token does is `@stacksjs/auth`'s `passwordResets`: it hashes
 * the token before storing it, expires it, rotates any outstanding one, revokes
 * every session and access token on success, and mails a notice that the
 * password changed. None of that is reimplemented here.
 *
 * `.skipCsrf()` is not used and is not needed - the form is served by this
 * product, so it carries a token like every other form.
 */
export default new Action({
  name: 'PasswordReset',
  description: 'Request a password reset link, or use one',
  method: 'POST',

  async handle(request: RequestInstance) {
    const email = String(request.get('email') ?? '').trim().toLowerCase()

    if (!email)
      return answer(request, 422, { error: 'An email address is required' })

    const resets = passwordResets(email)

    if (String(request.get('operation') ?? 'request') === 'request') {
      /*
       * Failures are swallowed on purpose. `sendEmail` throws for an address
       * with no account, and a mail transport that is down throws too - and
       * both must look identical from outside, or the timing and the status
       * code between them become the oracle the flat message was written to
       * avoid.
       */
      try {
        await resets.sendEmail()
      }
      catch (error) {
        console.error('[auth] password reset request:', error)
      }

      return answer(request, 200, { sent: true }, '/login?reset=sent')
    }

    const token = String(request.get('token') ?? '')
    const password = String(request.get('password') ?? '')

    if (!token)
      return answer(request, 422, { error: 'That reset link is not valid' })

    // The same floor registration applies. A reset is the one moment somebody
    // is guaranteed to be choosing a password, and letting it be weaker than
    // the one they signed up with is a strange place to relax.
    if (password.length < 8)
      return answer(request, 422, { error: 'A password needs at least 8 characters' })

    const result = await resets.resetPassword(token, password)

    if (!result.success)
      return answer(request, 422, { error: result.message ?? 'That reset link is not valid or has expired' })

    /*
     * Signed out everywhere, not signed in here. `resetPassword` revokes every
     * session and token, and it should: the usual reason to reset a password is
     * that somebody else may have had it. Handing back a fresh session at the
     * end of that would undo the one useful thing the reset just did for every
     * device except this one.
     */
    return answer(request, 200, { reset: true }, '/login?reset=done')
  },
})

/** JSON for a client, a redirect for a browser. The pattern the auth actions share. */
function answer(request: any, status: number, body: Record<string, unknown>, to?: string): Response {
  if (to && status < 400 && wantsHtml(request))
    return new Response(null, { status: 303, headers: { Location: to } })

  if (wantsHtml(request) && status >= 400) {
    // Back to the form with the reason in the query, since there is no session
    // flash and a reader who is told nothing tries the same thing again.
    const reason = encodeURIComponent(String(body.error ?? 'That did not work'))

    return new Response(null, { status: 303, headers: { Location: `/forgot-password?error=${reason}` } })
  }

  return response.json(body, status)
}
