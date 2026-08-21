import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { isSecureRequest, safeRedirect, sessionCookie } from './session'
import { providerFor } from './social'
import { providerNameFromAuthPath } from './socialPath'

/**
 * Start a social sign-in: send the visitor to the provider.
 *
 * ## The state cookie is the whole security story
 *
 * OAuth2's redirect flow has no memory. The callback is a plain GET that
 * anybody can cause a logged-in browser to make, so without a value that this
 * server minted and the browser returns, an attacker can complete *their own*
 * provider sign-in and have the victim's browser hand us the resulting code -
 * which links the attacker's provider account to the victim's session. That is
 * login CSRF, and it is the reason `state` exists rather than being optional.
 *
 * So the state is minted here, put in a short-lived `HttpOnly` cookie, and
 * compared in the callback. Apple's callback is a cross-site POST, so its
 * cookie uses `SameSite=None; Secure`; `Lax` would withhold it. Providers that
 * return with a top-level GET keep `SameSite=Lax`.
 *
 * `next` rides along inside the same cookie rather than in the URL, because a
 * `next` a caller can set on the callback is an open redirect wearing a
 * different hat, and because some providers drop query parameters they do not
 * recognise.
 *
 * An unconfigured provider answers 404 rather than redirecting. A visitor sent
 * to a provider's own error page reads it as this application being broken,
 * and it is - just earlier, and somewhere they cannot see.
 */

export const STATE_COOKIE = 'reviewos_oauth_state'

/** Long enough to sign in at the provider, short enough not to sit around. */
export const STATE_TTL_SECONDS = 10 * 60

export default new Action({
  name: 'SocialRedirect',
  description: 'Send a visitor to a social provider to sign in',
  method: 'GET',

  validations: {
    // The path this sign-in should return to. Refused unless it is a path on
    // this host - see `safeRedirect`, and the note about open redirects on the
    // sign-in page.
    next: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const name = providerNameFromAuthPath(new URL(request.url).pathname)
    const provider = providerFor(name)

    if (!provider)
      return response.json({ error: 'Not found' }, 404)

    const state = crypto.randomUUID().replace(/-/g, '')
    const next = safeRedirect(request.get?.('next'), '/reviews')
    const secure = isSecureRequest(request)

    let url: string
    try {
      url = await provider.getAuthUrl()
    }
    catch {
      // The provider's config passed the registry's check and the driver still
      // refused. Nothing a visitor can do, so say so here rather than sending
      // them onward to find out.
      return new Response(null, {
        status: 303,
        headers: { Location: '/login?error=That+sign-in+method+is+unavailable+right+now.' },
      })
    }

    // The driver builds the URL from config and does not know our state, so it
    // is appended here. `URL` rather than string concatenation, so a driver
    // that already put a query on the URL does not produce two `?`.
    const authUrl = new URL(url)
    authUrl.searchParams.set('state', state)

    const cookie = sessionCookie(STATE_COOKIE, `${state}:${next}`, {
      maxAgeSeconds: STATE_TTL_SECONDS,
      secure,
      sameSite: name === 'apple' && secure ? 'None' : 'Lax',
    })

    return new Response(null, {
      status: 303,
      headers: {
        'Location': authUrl.toString(),
        'Set-Cookie': cookie,
        // The Location carries a one-time value; a cached 303 would replay it.
        'Cache-Control': 'no-store',
      },
    })
  },
})
