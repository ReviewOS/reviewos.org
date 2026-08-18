import { Action } from '@stacksjs/actions'
import { publicKeys } from '../Workflow/oidc'

/**
 * The public half of the keys this instance signs job tokens with.
 *
 * Public and uncredentialed, because that is the point: a cloud provider
 * verifying a token this instance issued has no account here and never will.
 * The document contains no secret - a public key is a thing you publish - and
 * an instance that required a credential to serve it would be an instance
 * nobody could federate with.
 *
 * **Every key, current and retired.** A token signed a minute before a rotation
 * still has fourteen minutes to live, and a JWKS holding only the newest key
 * would make those unverifiable - which is a rotation that takes an outage with
 * it, and therefore a rotation nobody performs.
 */
export default new Action({
  name: 'Jwks',
  description: 'The public keys that verify this instance\'s job identity tokens',
  method: 'GET',

  responses: {
    200: {
      description: 'A JWK set. Every key a verifier should still accept, including recently retired ones.',
      schema: {
        type: 'object',
        properties: { keys: { type: 'array', items: { type: 'object' } } },
      },
    },
  },

  async handle() {
    const keys = await publicKeys()

    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        /*
         * Cached, but briefly. A verifier that caches this for a day cannot
         * verify a token signed by a key generated an hour ago, and one that
         * fetches it per request turns a deploy into a load test.
         */
        'Cache-Control': 'public, max-age=300',
      },
    })
  },
})
