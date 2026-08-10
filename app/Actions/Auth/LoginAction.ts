import { Action } from '@stacksjs/actions'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { clearedCookie, isSecureRequest, safeRedirect, sessionCookie, sessionCookieName, wantsHtml } from './session'

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
    const offeredCode = String(request.get('code') ?? '').trim()
    // The assertion a browser sends instead of a code, when this account has a
    // passkey. Untouched here - `verifySecondFactor` is the one place that
    // knows what a passkey has to prove.
    const offeredPasskey = request.get('passkey')

    const { Auth } = await import('@stacksjs/auth')

    /*
     * The second half of a two-step sign-in: a code and the challenge cookie,
     * with no credentials.
     *
     * The password was verified when the challenge was minted, so asking for it
     * again would mean the page holding it in a hidden field - which is the
     * thing a challenge exists to avoid. The cookie is signed and short-lived
     * and by itself proves only that somebody already got the password right.
     */
    const challenged = challengedUser(cookieValue(request, CHALLENGE_COOKIE))

    if (challenged && (offeredCode || offeredPasskey) && !password) {
      const waiting: any = await db
        .selectFrom('users')
        .select(['id', 'two_factor_secret', 'two_factor_enabled'])
        .where('id', '=', challenged)
        .executeTakeFirst()

      const { hasPasskey } = await import('./PasskeyAction')

      if (!waiting || (!waiting.two_factor_enabled && !await hasPasskey(Number(waiting.id))))
        return refuse(request, 'Start again from the sign-in page.')

      const { verifySecondFactor } = await import('./twoFactor')
      const check = await verifySecondFactor(waiting, offeredCode, offeredPasskey)

      if (!check.ok)
        return refuse(request, 'That code is not right.', { needsCode: true })

      const issued = await Auth.loginUsingId(challenged, deviceOf(request))

      if (!issued?.token)
        return refuse(request, 'Start again from the sign-in page.')

      return await signedIn(request, issued, challenged, { clearChallenge: true })
    }

    if (!email || !password)
      return refuse(request, 'Enter your email and password.')

    // The device, read once and used twice: written onto the session below, and
    // compared against every earlier session to decide whether this is somewhere
    // new.
    const device = deviceOf(request)

    let signedInUserId = 0
    let result: any = null

    try {
      if (await Auth.attempt({ email, password })) {
        const user: any = await db
          .selectFrom('users')
          .select(['id', 'two_factor_secret', 'two_factor_enabled'])
          .where('email', '=', email)
          .executeTakeFirst()

        signedInUserId = Number(user?.id ?? 0)

        /*
         * The second factor, between the password and the session.
         *
         * Checked here rather than after the session exists, because a session
         * issued and then withdrawn is a session that briefly worked - and the
         * window is exactly long enough for a client that stored the cookie.
         *
         * A code sent with the credentials is accepted directly, which is what
         * an API client does. A browser sends none on the first attempt and
         * gets a signed challenge cookie back; the second post carries the code
         * and the cookie, so the password is never re-posted and no server-side
         * state has to be kept or expired.
         */
        /*
         * A second factor is required when the account has *either* one.
         *
         * The first version asked only about `two_factor_enabled`, so somebody
         * who registered a passkey and never turned on TOTP got a
         * password-only sign-in - the passkey sat in their settings doing
         * nothing, and the settings page said they were protected. A second
         * factor that is listed and not asked for is worse than none, because
         * it is believed.
         */
        const { hasPasskey } = await import('./PasskeyAction')
        const needsSecondFactor = user
          ? Boolean(user.two_factor_enabled) || await hasPasskey(Number(user.id))
          : false

        if (user && needsSecondFactor) {
          const { verifySecondFactor } = await import('./twoFactor')
          const offered = String(request.get('code') ?? '').trim()

          if (!offered && !offeredPasskey)
            return await challenge(request, Number(user.id))

          const check = await verifySecondFactor(user, offered, offeredPasskey)

          if (!check.ok) {
            // The same refusal whether the code was wrong or the challenge had
            // expired: telling somebody which is telling an attacker which half
            // of the pair they have already got right.
            return refuse(request, 'That code is not right.', { needsCode: true })
          }
        }

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

    return await signedIn(request, result, signedInUserId)
  },
})

/**
 * The tail both sign-in paths share: notice, cookie, answer.
 *
 * One function rather than two copies, because the copy is where the second
 * factor path would quietly stop recording new devices or stop clearing the
 * challenge - and neither omission shows up as a failure anywhere.
 */
async function signedIn(
  request: any,
  result: { token: unknown, refreshToken?: unknown, expiresIn?: unknown },
  userId: number,
  options: { clearChallenge?: boolean } = {},
): Promise<Response> {
  /*
   * A notice, when this account has not been signed into from here before.
   *
   * After the session exists and never able to fail it: refusing to sign
   * somebody in because a notification could not be written is a worse outcome
   * than the notification not arriving, and it is the outcome that gets the
   * feature removed.
   *
   * The new session is excluded from the comparison by id - it is not evidence
   * of itself.
   */
  const { noticeSignIn } = await import('./newDevice')

  await noticeSignIn({
    userId,
    tokenId: await tokenIdOf(String(result.token)),
    ...deviceOf(request),
  })

  const name = await sessionCookieName()
  const secure = isSecureRequest(request)

  // The cookie's life matches the token's, so neither outlives the other. A
  // cookie that outlives its token means a reader who looks signed in and is
  // refused by every write; a token that outlives its cookie is a credential
  // nothing will clear.
  const cookie = sessionCookie(name, String(result.token), {
    maxAgeSeconds: Number(result.expiresIn ?? 60 * 60 * 24 * 7),
    secure,
  })

  // The challenge is spent. Left behind it would be a five-minute window in
  // which a code alone signs somebody in again on that browser.
  const cookies = options.clearChallenge
    ? [cookie, clearedCookie(CHALLENGE_COOKIE, secure)]
    : [cookie]

  const headers = new Headers()
  for (const value of cookies)
    headers.append('Set-Cookie', value)

  const next = safeRedirect(request.get('next'), '/reviews')

  if (wantsHtml(request)) {
    headers.set('Location', next)

    return new Response(null, { status: 303, headers })
  }

  // The API shape the framework's clients already expect, plus the cookie - so
  // one endpoint serves a form and a script without either being a special case
  // that drifts.
  headers.set('Content-Type', 'application/json')

  return new Response(JSON.stringify({
    access_token: result.token,
    refresh_token: result.refreshToken,
    token_type: 'Bearer',
    expires_in: result.expiresIn,
  }), { status: 200, headers })
}

/** What the browser said it was and where it came from. Both untrusted. */
function deviceOf(request: any): { userAgent: string | null, ipAddress: string | null } {
  return {
    userAgent: String(request?.headers?.get?.('user-agent') ?? '') || null,
    ipAddress: String(request?.headers?.get?.('x-forwarded-for') ?? '').split(',')[0]?.trim()
      || String(request?.headers?.get?.('x-real-ip') ?? '').trim()
      || null,
  }
}

/** The value of one cookie on this request, or an empty string. */
function cookieValue(request: any, name: string): string {
  const header = String(request?.headers?.get?.('cookie') ?? request?.header?.('cookie') ?? '')

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')

    if (key === name)
      return decodeURIComponent(rest.join('='))
  }

  return ''
}

/**
 * How long a browser has to enter its code before starting again.
 *
 * Five minutes. Long enough to unlock a phone and find the app, short enough
 * that a challenge left in a cookie on a shared machine is worthless by the
 * time anybody finds it - and it is only half a credential anyway: without the
 * password, the challenge alone was already earned.
 */
const CHALLENGE_TTL_MS = 5 * 60 * 1000

/**
 * Ask for the code, carrying the fact that the password was right.
 *
 * A signed cookie rather than a row: there is nothing to expire, nothing to
 * clean up, and nothing for a second process to fail to see. It carries the
 * user id and a deadline and is signed with the application key, so it cannot
 * be minted or extended by whoever holds it.
 *
 * **Never returned to somebody who got the password wrong**, which is why this
 * is reached only after `Auth.attempt` succeeded. A challenge handed out
 * earlier would be an oracle for which addresses have accounts.
 */
async function challenge(request: any, userId: number): Promise<Response> {
  const secure = isSecureRequest(request)
  const value = signChallenge(userId, Date.now() + CHALLENGE_TTL_MS)
  const cookie = sessionCookie(CHALLENGE_COOKIE, value, { maxAgeSeconds: CHALLENGE_TTL_MS / 1000, secure })

  if (wantsHtml(request)) {
    const next = safeRedirect(request.get('next'), '/reviews')

    return new Response(null, {
      status: 303,
      headers: { 'Location': `/login?code=required&next=${encodeURIComponent(next)}`, 'Set-Cookie': cookie },
    })
  }

  /*
   * The passkey options ride along with the challenge.
   *
   * So a browser learns in one round trip that a second factor is needed *and*
   * gets what it needs to ask for an assertion. The alternative is a second
   * request between the password and the prompt, which is a visible pause
   * exactly where somebody is already waiting.
   *
   * Null when the account has no passkey, which is how the page knows to show
   * the six-digit field instead.
   */
  const { issueAuthenticationChallenge } = await import('./PasskeyAction')
  const passkeyOptions = await issueAuthenticationChallenge(userId).catch(() => null)

  return new Response(JSON.stringify({
    error: 'A two-factor code is required.',
    code_required: true,
    passkey_options: passkeyOptions,
  }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
  })
}

export const CHALLENGE_COOKIE = 'two-factor-challenge'

/** `userId.expiry.signature`, signed with the application key. */
function signChallenge(userId: number, expiresAt: number): string {
  const body = `${userId}.${expiresAt}`

  return `${body}.${createHmac('sha256', applicationKey()).update(body).digest('hex')}`
}

/**
 * The user a challenge cookie names, if it is genuine and current.
 *
 * Exported so the second post can be checked against it. Returns null for
 * anything it cannot verify, which the caller treats the same as no cookie at
 * all - there is nothing useful to say about a forged one that does not also
 * tell whoever forged it how close they were.
 */
export function challengedUser(value: string): number | null {
  const parts = String(value ?? '').split('.')

  if (parts.length !== 3)
    return null

  const [id, expiry, signature] = parts as [string, string, string]
  const expected = createHmac('sha256', applicationKey()).update(`${id}.${expiry}`).digest('hex')

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')

  if (a.length !== b.length || !timingSafeEqual(a, b))
    return null

  if (!Number.isFinite(Number(expiry)) || Number(expiry) < Date.now())
    return null

  const userId = Number(id)

  return Number.isInteger(userId) && userId > 0 ? userId : null
}

/**
 * The key everything here is signed with.
 *
 * Falls back to a per-process random value rather than to a constant. A shared
 * default would make every instance's challenges forgeable by anybody who has
 * read this file; a random one makes challenges stop working across a restart,
 * which is a nuisance and not a hole - and `instance:check` already refuses to
 * start a production instance with no `APP_KEY`.
 */
let ephemeralKey = ''

function applicationKey(): string {
  const configured = String(process.env.APP_KEY ?? '').trim()

  if (configured)
    return configured

  if (!ephemeralKey)
    ephemeralKey = randomBytes(32).toString('hex')

  return ephemeralKey
}

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
function refuse(request: any, message: string, options: { needsCode?: boolean } = {}): Response {
  if (wantsHtml(request)) {
    const next = safeRedirect(request.get('next'), '/reviews')
    const code = options.needsCode ? '&code=required' : ''

    return new Response(null, {
      status: 303,
      headers: { Location: `/login?error=${encodeURIComponent(message)}${code}&next=${encodeURIComponent(next)}` },
    })
  }

  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}
