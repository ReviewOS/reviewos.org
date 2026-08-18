import { Action } from '@stacksjs/actions'

/**
 * The discovery document a cloud provider reads before it will trust anything.
 *
 * AWS, Google and Azure all start from `/.well-known/openid-configuration`:
 * they fetch it, take `jwks_uri`, and pin the issuer. Without it there is no
 * way to register this instance as an identity provider at all, and the tokens
 * it mints are strings nobody accepts.
 *
 * Deliberately minimal. This instance is an *issuer* of workload identity
 * tokens, not an OpenID Provider people log in through - so it advertises what
 * it does and nothing it does not: no authorization endpoint, because there is
 * no interactive flow here, and claiming one would be an instance failing at a
 * dance it never intended to join.
 */
export default new Action({
  name: 'OpenIdConfiguration',
  description: 'Where this instance\'s job identity tokens come from, and how to verify them',
  method: 'GET',

  responses: {
    200: {
      description: 'The issuer and the JWKS URI, which is what a cloud trust policy needs.',
      schema: { type: 'object' },
    },
  },

  async handle(request: any) {
    const issuer = issuerOf(request)

    return new Response(JSON.stringify({
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      /*
       * The claims a policy may match on, listed because "documented and
       * stable" is the promise: somebody writes a trust policy against these
       * names once and it has to keep working.
       */
      claims_supported: [
        'sub', 'aud', 'exp', 'iat', 'iss', 'jti', 'nbf',
        'repository', 'repository_owner', 'repository_visibility',
        'run_id', 'run_number', 'run_attempt',
        'workflow', 'workflow_ref', 'job_workflow_ref',
        'ref', 'ref_type', 'sha', 'event_name', 'actor',
        'environment', 'runner_environment',
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    })
  },
})

/** Where this instance is, as the caller reached it. */
function issuerOf(request: any): string {
  try {
    const parsed = new URL(String(request?.url ?? ''))

    return `${parsed.protocol}//${parsed.host}`
  }
  catch {
    return 'http://localhost:3000'
  }
}
