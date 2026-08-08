import { Action } from '@stacksjs/actions'
import { checkHandle, normalizeHandle } from '../Identity/handles'
import { isSecureRequest, safeRedirect, sessionCookie, sessionCookieName, wantsHtml } from './session'

/** The shortest password worth having. Long enough to matter, short enough to type. */
const MIN_PASSWORD = 10

/**
 * Create an account.
 *
 * Overrides the framework default, which knows nothing about handles - and a
 * handle is not a profile field here, it is the URL segment. `acme/api` and
 * `/chris` are the same namespace, so an account without one is an account with
 * no page, and picking it later would mean the page moves.
 *
 * **The handle is checked before the account is made, and taken as a whole.**
 * `checkHandle` is the same rule the reserved-route list comes from, so an
 * account can never be created at a handle that would shadow `/settings` or
 * `/explore` - which is not a cosmetic problem: it would make part of the
 * product unreachable and give whoever registered it a page every reader trusts.
 */
export default new Action({
  name: 'RegisterAction',
  description: 'Create an account and start a session',
  method: 'POST',

  async handle(request: any) {
    const handle = normalizeHandle(String(request.get('handle') ?? ''))
    const email = String(request.get('email') ?? '').trim().toLowerCase()
    const password = String(request.get('password') ?? '')
    const name = String(request.get('name') ?? '').trim()

    const shape = checkHandle(handle)
    if (!shape.ok)
      return refuse(request, shape.message ?? 'That handle cannot be used.')

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return refuse(request, 'Enter a valid email address.')

    // Length, and nothing else. A composition rule - one capital, one symbol -
    // measurably produces worse passwords, because people satisfy it the same
    // way and then reuse the result.
    if (password.length < MIN_PASSWORD)
      return refuse(request, `A password needs at least ${MIN_PASSWORD} characters.`)

    /*
     * Taken is a separate question from well-formed, and it needs the database.
     *
     * Checked here for the message, and the unique index is what actually
     * enforces it: two registrations in the same millisecond both pass this and
     * one loses at the insert. A check without the index is a race; an index
     * without the check is a stack trace where a sentence belongs.
     */
    const clash: any = await db
      .selectFrom('users')
      .select(['id'])
      .where('handle', '=', handle)
      .executeTakeFirst()

    if (clash)
      return refuse(request, 'That handle is taken.')

    const existingEmail: any = await db
      .selectFrom('users')
      .select(['id'])
      .where('email', '=', email)
      .executeTakeFirst()

    // Deliberately the same phrasing as a taken handle rather than "you already
    // have an account". An address that is registered here is something only
    // its owner should learn, and the sign-in page is where they learn it.
    if (existingEmail)
      return refuse(request, 'That email address cannot be used.')

    let result: any = null

    try {
      /*
       * The row is written here rather than through the framework's `register`,
       * and the reason is `handle`.
       *
       * `register` inserts a user with no handle, and `users.handle` is NOT
       * NULL because it is the URL segment - so registering and then setting it
       * fails at the insert, before there is a row to update. Making the column
       * nullable to suit the helper would mean accounts that exist and have no
       * page, which is the wrong end to bend.
       *
       * **The hash is still the framework's.** `makeHash` is the function
       * `Auth.attempt` verifies against, so this is the same implementation and
       * not a second one - the day the framework changes algorithm, this changes
       * with it. That is the part that would be dangerous to reimplement; the
       * insert is not.
       *
       * The display name falls back to the handle. Asking for one and refusing
       * without it is a field people fill with their handle anyway.
       */
      const { makeHash } = await import('@stacksjs/security')
      const { Auth } = await import('@stacksjs/auth')

      const created: any = await db
        .insertInto('users')
        .values({
          handle,
          name: name || handle,
          email,
          password: await makeHash(password, { algorithm: 'bcrypt' }),
        })
        .returning(['id'])
        .executeTakeFirst()

      if (created?.id)
        result = await Auth.loginUsingId(Number(created.id))
    }
    catch (error) {
      // The unique index firing lands here, which is the race above losing.
      // Reported as the same sentence a reader would have seen a moment
      // earlier rather than as a failure.
      console.error('[register] could not create the account:', error)

      return refuse(request, 'That handle is taken.')
    }

    if (!result?.token)
      return refuse(request, 'The account was created but could not be signed in. Try signing in.')

    const cookie = sessionCookie(await sessionCookieName(), String(result.token), {
      maxAgeSeconds: Number(result.expiresIn ?? 60 * 60 * 24 * 7),
      secure: isSecureRequest(request),
    })

    // Straight to their own profile. It is the page that proves the account
    // exists, and the one they will want to fill in.
    const next = safeRedirect(request.get('next'), `/${handle}`)

    if (wantsHtml(request)) {
      return new Response(null, {
        status: 303,
        headers: { 'Location': next, 'Set-Cookie': cookie },
      })
    }

    return new Response(JSON.stringify({
      access_token: result.token,
      refresh_token: result.refreshToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      handle,
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
    })
  },
})

/**
 * Back to the form with the reason, keeping what they typed.
 *
 * The handle and the email travel back in the query string so the page can
 * refill them. Losing four fields because the fifth was wrong is how people
 * abandon a sign-up, and the password is deliberately not among them.
 */
function refuse(request: any, message: string): Response {
  if (wantsHtml(request)) {
    const query = new URLSearchParams({
      error: message,
      handle: String(request.get('handle') ?? ''),
      email: String(request.get('email') ?? ''),
      name: String(request.get('name') ?? ''),
    })

    return new Response(null, { status: 303, headers: { Location: `/register?${query}` } })
  }

  return new Response(JSON.stringify({ error: message }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' },
  })
}
