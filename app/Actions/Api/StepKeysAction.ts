import { Action } from '@stacksjs/actions'
import { publicKeys } from '../Workflow/oidc'

/**
 * The public half of the keys this instance signs dispatched work with.
 *
 * **A separate document from `jwks.json`, deliberately.** That one says "these
 * keys speak for a job's identity to somebody outside"; this one says "these
 * keys say what a runner should execute". Publishing both in one set would
 * invite a verifier to accept either statement in place of the other, which is
 * the confusion the separate key exists to prevent - and it would be a strange
 * thing to hand a cloud provider that only asked who a job is.
 *
 * Uncredentialed, like the other: the content is public keys, and an operator
 * checking a signature by hand should not need a token to fetch one.
 */
export default new Action({
  name: 'StepKeys',
  description: 'The public keys that verify the work this instance dispatches to runners',
  method: 'GET',

  responses: {
    200: {
      description: 'A JWK set. Every key a runner should still accept, including recently retired ones.',
      schema: {
        type: 'object',
        properties: { keys: { type: 'array', items: { type: 'object' } } },
      },
    },
  },

  async handle() {
    const keys = await publicKeys('steps')

    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Briefly, for the same reason as the identity set: a runner that
        // cached this for a day could not verify work signed by a key made an
        // hour ago, and one that never caches turns a fleet into a load test.
        'Cache-Control': 'public, max-age=300',
      },
    })
  },
})
