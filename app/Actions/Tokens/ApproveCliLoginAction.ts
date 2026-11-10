import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { currentUser } from '../Identity/lookup'
import { deviceName, isChallenge, isOpaque, loopbackPort, loopbackUrl, sealCliGrant } from './cliLogin'

/**
 * Approve, or refuse, a command line that asked to sign in.
 *
 * Posted by the form on `/cli/login`, by somebody signed in in a browser. The
 * answer is a redirect: to the terminal's own loopback listener with a code it
 * can redeem, or, where the terminal said it has no listener, back to the page
 * to show that code for pasting. See `cliLogin.ts` for why the code is safe to
 * put in an address bar.
 *
 * **A person in a browser, never a token.** A request carrying an access token
 * is refused whatever the token may do: approving here issues a token that
 * reaches every repository, so letting a token do it would let a narrow one
 * mint itself a broad one.
 */
export default new Action({
  name: 'ApproveCliLogin',
  description: 'Approve or refuse a command line sign-in started with `reviewos login`',
  method: 'POST',

  validations: {
    challenge: { rule: schema.string().required() },
    state: { rule: schema.string().required() },
    device: { rule: schema.string() },
    port: { rule: schema.string() },
    decision: { rule: schema.enum(['approve', 'deny']) },
  },

  responses: {
    303: { description: 'Approved or refused. The redirect goes to the terminal that asked, on 127.0.0.1, or back to the page with a code to paste.' },
    401: { description: 'Unauthenticated.' },
    403: { description: 'An access token cannot approve a sign-in; only a browser session can.' },
    422: { description: 'The request did not come from `reviewos login`: its challenge or state is missing or malformed.' },
  },

  async handle(request: RequestInstance) {
    const credential = String(request.bearerToken?.() ?? '')
    if (credential.startsWith('ros_') || (request as any).__fineGrainedToken)
      return response.json({ error: 'An access token cannot approve a sign-in. Open the link in a browser you are signed in to.' }, 403)

    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const challenge = request.get('challenge')
    const state = request.get('state')
    if (!isChallenge(challenge) || !isOpaque(state))
      return response.json({ error: 'That link did not come from `reviewos login`. Run it again.' }, 422)

    const device = deviceName(request.get('device'))
    const port = loopbackPort(request.get('port'))
    const approved = String(request.get('decision') ?? 'approve') === 'approve'

    // Refused: the waiting terminal is told, so it stops waiting; with no
    // listener there is nobody to tell, and the page says it instead.
    if (!approved) {
      return redirect(port
        ? loopbackUrl(port, { error: 'denied', state })
        : '/cli/login?refused=1')
    }

    const code = sealCliGrant({ userId: user.id, challenge, device })

    return redirect(port
      ? loopbackUrl(port, { code, state })
      : `/cli/login?code=${encodeURIComponent(code)}&device=${encodeURIComponent(device)}`)
  },
})

function redirect(location: string): Response {
  // 303, so the browser follows with a GET whatever it posted. `no-store`
  // because the target carries a code, and a cached redirect is a code kept.
  return new Response(null, { status: 303, headers: { 'Location': location, 'Cache-Control': 'no-store' } })
}
