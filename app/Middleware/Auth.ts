import { Auth } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { HttpError } from '@stacksjs/error-handling'
import { log } from '@stacksjs/logging'
import { Middleware } from '@stacksjs/router'

export default new Middleware({
  name: 'Auth',
  priority: 1,
  async handle(request) {
    // Check bearer token first (API auth)
    const bearerToken = request.bearerToken()

    /*
     * This project's own fine-grained tokens, before the framework's.
     *
     * They are a different credential in a different table, and until this
     * existed the framework's resolver simply did not find them - so a
     * `ros_` token authenticated git over HTTP and the browse endpoints and
     * was answered 401 by every JSON endpoint. The credential
     * [phase 1](docs/todo/01-foundation.md) built could not call the API
     * [phase 12](docs/todo/12-api-and-agents.md) built, which is the parity
     * bug in its purest form.
     *
     * **This establishes identity only.** The token's grants and its reach are
     * applied by `authorizeRepository`, which is the one place that has the
     * repository in hand and can answer "may this token do this *here*".
     * Deciding it here would mean answering with the owner's full authority,
     * which is exactly what a fine-grained token exists to avoid - so this
     * branch deliberately stops at "who", and every repository-scoped action
     * goes through the authorizer.
     */
    if (typeof bearerToken === 'string' && bearerToken.startsWith('ros_')) {
      const { authenticateToken } = await import('../Actions/Tokens/authenticate')
      const result = await authenticateToken(bearerToken)

      if (!result.ok)
        unauthorized(request, 'Unauthorized. Invalid or expired token.')

      const owner = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', result.token.userId)
        .executeTakeFirst()

      if (!owner)
        unauthorized(request, 'Unauthorized. Invalid or expired token.')

      Auth.setUser(owner as any)
      request._authenticatedUser = owner
      // Deliberately not `_currentAccessToken`: that field means a framework
      // token, and filling it with one of ours would have `tokenCan()` and the
      // abilities middleware reading a row whose columns mean different things.
      // Cast, because the field is this application's own: `EnhancedRequest`
      // is the framework's type and declaring an app-specific marker on it
      // would be this project reaching into the framework's shape for its own
      // convenience. `authorizeRepository` reads it back the same way.
      ;(request as any).__fineGrainedToken = result.token

      return
    }

    if (bearerToken) {
      log.debug(`[middleware:auth] Validating bearer token`)
      const user = await Auth.getUserFromToken(bearerToken)
      if (!user)
        unauthorized(request, 'Unauthorized. Invalid token.')

      Auth.setUser(user)
      request._authenticatedUser = user
      request._currentAccessToken = await Auth.currentAccessToken()
      log.debug(`[middleware:auth] Bearer token valid`)
      return
    }

    // Check the login cookie (web auth, token driver). Plain server-rendered
    // <form method="POST"> actions — logout, and any other dashboard form on
    // an auth-guarded route — carry the HttpOnly login cookie that the token
    // driver sets, but no Authorization header, so the bearer check above
    // misses them and the request 401s even though the user is signed in.
    // Validate that cookie as a token, mirroring the auth team helper's
    // resolveTokenUser so every cookie-authenticated entry point behaves
    // identically. Distinct from the session_id branch below, which only
    // applies to the `session` guard driver.
    const tokenCookieName = config.auth?.defaultTokenName || 'auth-token'
    const cookieToken = request.cookie(tokenCookieName)

    if (cookieToken) {
      log.debug(`[middleware:auth] Validating login cookie`)
      const user = await Auth.getUserFromToken(cookieToken)
      if (!user)
        unauthorized(request, 'Unauthorized. Invalid or expired session.')

      Auth.setUser(user)
      request._authenticatedUser = user
      request._currentAccessToken = await Auth.currentAccessToken()

      log.debug(`[middleware:auth] Login cookie valid`)
      return
    }

    // Check session cookie (web auth)
    const sessionId = request.cookie('session_id')

    if (sessionId) {
      log.debug(`[middleware:auth] Validating session`)
      const { sessionUser } = await import('@stacksjs/auth')
      const user = await sessionUser(sessionId)
      if (!user)
        unauthorized(request, 'Unauthorized. Session expired.')

      Auth.setUser(user)
      request._authenticatedUser = user
      log.debug(`[middleware:auth] Session valid`)
      return
    }

    unauthorized(request, 'Unauthorized. No token or session provided.')
  },
})

/**
 * A browser posting a form must not be answered with a page of JSON.
 *
 * This middleware runs before the action, so the `refuse` helper the actions
 * use never gets the chance: a session that lapsed while a form was open was
 * answered `{"message":"Unauthorized. Session expired."}` and the person lost
 * what they had typed with no way back. Signing in again is the only useful
 * answer, so a request that asked for a page gets the login form carrying
 * where to return to, and everything else keeps the 401 it has always had.
 *
 * Thrown rather than returned because that is how this framework's middleware
 * short-circuits - `Throttle` refuses the same way.
 */
function unauthorized(request: any, message: string): never {
  const accept = String(request?.header?.('accept') ?? request?.headers?.get?.('accept') ?? '')

  if (accept.includes('text/html')) {
    const referer = String(request?.header?.('referer') ?? request?.headers?.get?.('referer') ?? '')
    let next = '/'

    try {
      const url = new URL(referer, 'http://referer.invalid')
      const here = new URL(String(request?.url ?? '')).host
      // Same rule as `formPage` in `app/Actions/Support/forge.ts`: a path on
      // this host, or nothing.
      if ((url.origin === 'http://referer.invalid' || !here || url.host === here)
        && url.pathname.startsWith('/') && !url.pathname.startsWith('//')) {
        next = `${url.pathname}${url.search}`
      }
    }
    catch {
      next = '/'
    }

    throw new Response(null, { status: 303, headers: { Location: `/login?next=${encodeURIComponent(next)}` } })
  }

  throw new HttpError(401, message)
}
