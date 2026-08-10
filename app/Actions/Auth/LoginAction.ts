import { Action } from '@stacksjs/actions'
import { isSecureRequest, safeRedirect, sessionCookie, sessionCookieName, wantsHtml } from './session'

/**
 * Sign in, and leave the browser actually signed in.
 *
 * Overrides the framework default, which answers with JSON and sets no cookie.
 * That is right for an API client reading `access_token`; it is wrong for a
 * form, which would show a reader raw JSON and leave them signed out, because
 * every page here identifies its reader from the session cookie.
 *
 * Credentials go to `Auth.attempt` rather than being compared here. Password
 * verification is one of the few things in a product that must have exactly one
 * implementation, and the framework's is it.
 *
 * **One message for both failures.** "No such account" and "wrong password" are
 * different facts and the same answer, because distinguishing them turns this
 * endpoint into a way to test whether an address has an account here - which is
 * the first step of every credential-stuffing run.
 */
export default new Action({
  name: 'LoginAction',
  description: 'Sign in and start a session',
  method: 'POST',

  async handle(request: any) {
    const email = String(request.get('email') ?? '').trim().toLowerCase()
    const password = String(request.get('password') ?? '')

    if (!email || !password)
      return refuse(request, 'Enter your email and password.')

    const { Auth } = await import('@stacksjs/auth')

    // The device, read once and used twice: written onto the session below, and
    // compared against every earlier session to decide whether this is somewhere
    // new.
    const device = {
      userAgent: String(request?.headers?.get?.('user-agent') ?? '') || null,
      ipAddress: String(request?.headers?.get?.('x-forwarded-for') ?? '').split(',')[0]?.trim()
        || String(request?.headers?.get?.('x-real-ip') ?? '').trim()
        || null,
    }

    let signedInUserId = 0
    let result: any = null

    try {
      if (await Auth.attempt({ email, password })) {
        const user: any = await db
          .selectFrom('users')
          .select(['id'])
          .where('email', '=', email)
          .executeTakeFirst()

        signedInUserId = Number(user.id)

        if (user) {
          /*
           * The device, recorded on the session row.
           *
           * So `SessionsAction` can show somebody a list they can recognise -
           * without this the page is a column of identical timestamps and
           * "revoke" is guesswork. Untrusted, both of them: a user agent is a
           * string a client chose and an address is what the nearest trusted
           * proxy saw. Nothing authorises on either; they are there to be read
           * by the person the session belongs to.
           */
          result = await Auth.loginUsingId(Number(user.id), device)
        }
      }
    }
    catch {
      // A failure inside auth is not a reason to say something different from
      // a wrong password. The log is where the difference belongs.
      result = null
    }

    if (!result?.token)
      return refuse(request, 'Incorrect email or password.')

    /*
     * A notice, when this account has not been signed into from here before.
     *
     * After the session exists and never able to fail it: refusing to sign
     * somebody in because a notification could not be written is a worse
     * outcome than the notification not arriving, and it is the outcome that
     * gets the feature removed.
     *
     * The new session is excluded from the comparison by id - it is not
     * evidence of itself - which is why this runs here rather than before the
     * login, where the answer would be right for a different reason and stop
     * being right the moment somebody reorders these lines.
     */
    const { noticeSignIn } = await import('./newDevice')

    await noticeSignIn({
      userId: signedInUserId,
      tokenId: await tokenIdOf(String(result.token)),
      ...device,
    })

    const name = await sessionCookieName()

    // The cookie's life matches the token's, so neither outlives the other. A
    // cookie that outlives its token means a reader who looks signed in and is
    // refused by every write; a token that outlives its cookie is a credential
    // nothing will clear.
    const cookie = sessionCookie(name, String(result.token), {
      maxAgeSeconds: Number(result.expiresIn ?? 60 * 60 * 24 * 7),
      secure: isSecureRequest(request),
    })

    const next = safeRedirect(request.get('next'), '/reviews')

    if (wantsHtml(request)) {
      return new Response(null, {
        status: 303,
        headers: { 'Location': next, 'Set-Cookie': cookie },
      })
    }

    // The API shape the framework's clients already expect, plus the cookie -
    // so one endpoint serves a form and a script without either being a special
    // case that drifts.
    return new Response(JSON.stringify({
      access_token: result.token,
      refresh_token: result.refreshToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
    })
  },
})

/**
 * The id of the session row a plaintext token hashes to.
 *
 * So the session that was just created can be excluded from "have we seen this
 * device before" - without it, every sign-in matches itself and nobody is ever
 * told about anything. Recomputed here rather than imported from the auth
 * package, because the hashing helper's shape has changed twice and a silent
 * mismatch would turn this feature off rather than break it visibly.
 */
async function tokenIdOf(plaintext: string): Promise<number | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext))
    const hashed = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')

    const row: any = await db
      .selectFrom('oauth_access_tokens')
      .select(['id'])
      .where('token', '=', hashed)
      .executeTakeFirst()

    return row ? Number(row.id) : null
  }
  catch {
    return null
  }
}

/**
 * The same answer for every reason it did not work.
 *
 * A form gets the page back with the message on it rather than a bare 401, so
 * somebody who mistyped is one keystroke from fixing it rather than pressing
 * back and losing what they typed.
 */
function refuse(request: any, message: string): Response {
  if (wantsHtml(request)) {
    const next = safeRedirect(request.get('next'), '/reviews')

    return new Response(null, {
      status: 303,
      headers: { Location: `/login?error=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}` },
    })
  }

  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}
