import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { claimsFor, mintOidcToken, TOKEN_TTL_SECONDS } from '../Workflow/oidc'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * A short-lived token a job can present to a cloud instead of a stored key.
 *
 * The deploy problem: a job that ships somewhere has to prove who it is, and
 * the obvious answer - a long-lived access key in a secret - is a credential
 * that lives forever, works from anywhere, and is one leaked log away from
 * being somebody else's. This one lasts fifteen minutes, says exactly which
 * repository and ref asked for it, and is verifiable by anybody who can fetch
 * this instance's JWKS.
 *
 * **Every claim comes from the run, not the request.** The only thing a caller
 * chooses is the audience, which is the value the other side insists on
 * (`sts.amazonaws.com` and so on). A token whose repository came from the body
 * would be a token any job could mint for any repository, which is the thing
 * this is supposed to replace.
 *
 * **A fork's pull request gets nothing.** By the threat model an untrusted run
 * receives no credentials, and "I am acme/api on main" is the strongest
 * credential this instance can issue.
 */
export default new Action({
  name: 'RequestOidcToken',
  description: 'Mint a short-lived identity token for the job this runner holds',
  method: 'POST',

  validations: {
    audience: { rule: schema.string(), required: false },
  },

  responses: {
    200: {
      description: 'The token and how long it lasts. Present it as a bearer to whatever trusts this instance.',
      schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          expires_in: { type: 'integer' },
          claims: { type: 'object', description: 'What the token says, so a job can log it without decoding one.' },
        },
      },
    },
    403: { description: 'An untrusted run - a fork\'s pull request - gets no identity token.' },
    426: { description: 'This runner speaks a protocol version the server does not.' },
    401: { description: 'No job credential, or one this instance does not recognise.' },
  },

  async handle(request: any) {
    const protocol = protocolOf(request)

    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)

    if (!held)
      return runnerJson({ error: 'Unknown or expired job token' }, 401)

    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'workflow_run_id', 'settings'])
      .where('id', '=', held.jobId)
      .executeTakeFirst()

    if (!job)
      return runnerJson({ error: 'The credential names a job that has gone' }, 404)

    const run: any = await db
      .selectFrom('workflow_runs')
      .innerJoin('repositories', 'repositories.id', '=', 'workflow_runs.repository_id')
      .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select([
        'workflow_runs.id as id',
        'workflow_runs.number as number',
        'workflow_runs.attempt as attempt',
        'workflow_runs.event as event',
        'workflow_runs.event_ref as event_ref',
        'workflow_runs.head_sha as head_sha',
        'workflow_runs.trusted as trusted',
        'workflow_runs.actor_id as actor_id',
        'repositories.name as repository',
        'repositories.visibility as visibility',
        'repositories.owner_type as owner_type',
        'repositories.owner_id as owner_id',
        'workflows.name as workflow',
        'workflows.path as workflow_path',
      ])
      .where('workflow_runs.id', '=', Number(job.workflow_run_id))
      .executeTakeFirst()

    if (!run)
      return runnerJson({ error: 'This job has no run' }, 404)

    if (run.trusted === false) {
      return runnerJson({
        error: 'An untrusted run gets no identity token. A fork\'s pull request stays untrusted until somebody with write access approves the exact commit.',
      }, 403)
    }

    const owner: any = String(run.owner_type) === 'organization'
      ? await db.selectFrom('organizations').select(['handle']).where('id', '=', Number(run.owner_id)).executeTakeFirst()
      : await db.selectFrom('users').select(['handle']).where('id', '=', Number(run.owner_id)).executeTakeFirst()

    const actor: any = run.actor_id
      ? await db.selectFrom('users').select(['handle']).where('id', '=', Number(run.actor_id)).executeTakeFirst()
      : null

    const repository = `${String(owner?.handle ?? 'unknown')}/${String(run.repository)}`

    const claims = claimsFor({
      /*
       * The issuer is where this instance is reachable, which is what a trust
       * policy is written against and what a verifier fetches the JWKS from.
       * Taken from the request rather than a setting, so an instance behind a
       * proxy issues tokens naming the address the world actually uses.
       */
      issuer: issuerOf(request),
      // The value the other side insists on. `sts.amazonaws.com` for AWS,
      // and the instance's own URL when nobody said - a token with no audience
      // is one any service could be persuaded to accept.
      audience: String(request.get('audience') ?? '').trim() || issuerOf(request),
      repository,
      owner: String(owner?.handle ?? 'unknown'),
      visibility: String(run.visibility ?? 'private'),
      runId: Number(run.id),
      runNumber: Number(run.number),
      runAttempt: Number(run.attempt ?? 1),
      workflow: String(run.workflow ?? ''),
      workflowPath: String(run.workflow_path ?? ''),
      ref: String(run.event_ref ?? ''),
      sha: String(run.head_sha ?? ''),
      event: String(run.event ?? ''),
      actor: String(actor?.handle ?? ''),
      environment: environmentOf(job.settings),
    })

    const minted = await mintOidcToken(claims)

    return runnerJson({
      value: minted.token,
      expires_in: TOKEN_TTL_SECONDS,
      // Returned beside the token so a job can log what it asked for without
      // decoding a JWT in a shell script, which is how people end up pasting
      // one into a website.
      claims,
    })
  },
})

/** Where this instance is, as the caller reached it. */
function issuerOf(request: any): string {
  const url = String(request?.url ?? '')

  try {
    const parsed = new URL(url)

    return `${parsed.protocol}//${parsed.host}`
  }
  catch {
    return 'http://localhost:3000'
  }
}

/** The environment a job named, which makes the subject more specific. */
function environmentOf(settings: unknown): string | null {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return typeof parsed?.environment === 'string' ? parsed.environment : null
  }
  catch {
    return null
  }
}
