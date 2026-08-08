import { Action } from '@stacksjs/actions'
import { clearedCookie, isSecureRequest, sessionCookieName, wantsHtml } from './session'

/**
 * Sign out.
 *
 * **The token is revoked, not just forgotten.** Clearing the cookie alone
 * leaves a live credential in whatever else has a copy of it - a proxy log, a
 * synced browser profile, a shared machine - and signing out on a shared
 * computer is the single most common reason anybody presses this. A logout that
 * only tidies the browser is one that lies to exactly the person relying on it.
 *
 * POST rather than GET, and that is not pedantry: a `<img src="/logout">` in a
 * comment would sign every reader out on GET, which is a denial of service
 * written in one tag by anybody who can post markdown.
 *
 * Answers 200 whether or not anybody was signed in. There is nothing to
 * distinguish - the desired state is "not signed in", and it holds either way.
 */
export default new Action({
  name: 'LogoutAction',
  description: 'End the session and revoke its token',
  method: 'POST',

  async handle(request: any) {
    const name = await sessionCookieName()
    const secure = isSecureRequest(request)

    try {
      /*
       * The token this browser is holding, revoked by name.
       *
       * `Auth.logout()` takes no argument and works from ambient request state
       * the router does not hand an action, so it would end nothing here.
       * `revokeToken` takes the plaintext, which is exactly what the cookie
       * carries - and revoking *this* token rather than every one of theirs is
       * the right scope: signing out on a shared machine should not sign
       * somebody out on their phone.
       */
      const token = cookieValue(request, name)

      if (token) {
        const { revokeToken } = await import('@stacksjs/auth')

        await revokeToken(token)
      }
    }
    catch (error) {
      // The cookie is cleared regardless. A failure to revoke must not leave
      // somebody looking signed in on a machine they are walking away from -
      // and it is reported, because a revocation that quietly stops working is
      // a credential that never expires.
      console.error('[logout] could not revoke the token:', error)
    }

    const cookie = clearedCookie(name, secure)

    if (wantsHtml(request)) {
      return new Response(null, {
        status: 303,
        headers: { 'Location': '/', 'Set-Cookie': cookie },
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
    })
  },
})

/**
 * One cookie off the request, without a parser.
 *
 * The request object differs between the two serving pipelines and neither
 * hands an action a parsed jar, so the header is read directly. A malformed
 * escape in one cookie must not drop the others - the session cookie is
 * usually not the one that is malformed.
 */
function cookieValue(request: any, name: string): string {
  const header = String(request?.header?.('cookie') ?? request?.headers?.get?.('cookie') ?? '')

  for (const part of header.split(';')) {
    const cut = part.indexOf('=')
    if (cut < 0)
      continue

    if (part.slice(0, cut).trim() !== name)
      continue

    try {
      return decodeURIComponent(part.slice(cut + 1).trim())
    }
    catch {
      return part.slice(cut + 1).trim()
    }
  }

  return ''
}
