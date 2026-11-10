import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { CLI_TOKEN_PERMISSIONS, cliTokenName, openCliGrant } from './cliLogin'
import { issueAccessToken } from './issue'

/**
 * Turn an approval into a token, for the terminal that asked for it.
 *
 * Unauthenticated on purpose: the caller is a command line that is not signed
 * in yet. What it holds instead is the code a signed-in person approved and
 * the verifier that code was approved *for*, and only the terminal that began
 * the login has the second. See `cliLogin.ts`.
 *
 * The token is an ordinary fine-grained one, named for the machine, listed on
 * the settings page beside the rest, expiring on the usual schedule and
 * revocable there. Signing in twice from one machine issues two; `reviewos
 * logout` forgets the local copy and the page revokes it.
 */
export default new Action({
  name: 'ExchangeCliLogin',
  description: 'Exchange an approved command line sign-in for an access token',
  method: 'POST',

  validations: {
    code: { rule: schema.string().required() },
    verifier: { rule: schema.string().required() },
  },

  responses: {
    201: { description: 'The token, shown once, with the handle it signs in as.' },
    403: { description: 'Not approved, expired after two minutes, or not the terminal that asked.' },
    422: { description: 'The account can no longer hold a token.' },
  },

  async handle(request: RequestInstance) {
    const opened = openCliGrant(request.get('code'), request.get('verifier'))
    if (!opened.ok)
      return response.json({ error: opened.error }, 403)

    // The approval is two minutes old at most, but an account can be removed
    // in two minutes, and a token for nobody is a row that authenticates as
    // nothing.
    const owner = await db
      .selectFrom('users')
      .select(['id', 'handle'])
      .where('id', '=', opened.grant.userId)
      .executeTakeFirst()

    if (!owner)
      return response.json({ error: 'That account no longer exists.' }, 403)

    const issued = await issueAccessToken({
      userId: Number(owner.id),
      name: cliTokenName(opened.grant.device),
      selection: 'all',
      permissions: CLI_TOKEN_PERMISSIONS,
      detail: { via: 'cli-login', device: opened.grant.device },
    })

    if (!issued.ok)
      return response.json({ error: issued.error }, issued.status)

    return response.json({
      token: issued.token.token,
      handle: String(owner.handle),
      name: issued.token.name,
      expires_at: issued.token.expires_at,
    }, 201)
  },
})
