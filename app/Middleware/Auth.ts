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
        throw new HttpError(401, 'Unauthorized. Invalid or expired token.')

      const owner = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', result.token.userId)
        .executeTakeFirst()

      if (!owner)
        throw new HttpError(401, 'Unauthorized. Invalid or expired token.')

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
        throw new HttpError(401, 'Unauthorized. Invalid token.')

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
        throw new HttpError(401, 'Unauthorized. Invalid or expired session.')

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
        throw new HttpError(401, 'Unauthorized. Session expired.')

      Auth.setUser(user)
      request._authenticatedUser = user
      log.debug(`[middleware:auth] Session valid`)
      return
    }

    throw new HttpError(401, 'Unauthorized. No token or session provided.')
  },
})
