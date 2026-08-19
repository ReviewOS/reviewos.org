import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { artifactName } from '../Artifact/storage'
import { openArtifact } from '../Artifact/read'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * An artifact from earlier in this run, by name.
 *
 * **This is the only reason most artifacts exist.** A build job produces a
 * binary and a deploy job needs it; a test job produces a coverage file and a
 * report job reads it. Uploading with nothing able to fetch it back inside the
 * run is half a feature - the half that looks finished on a screen.
 *
 * By name rather than by id, because a later job knows what the earlier one
 * called its output and does not know a database id. The name is the one the
 * uploader gave, through the same cleaning the upload applied, so a job asking
 * for `out/report.txt` finds what `out/report.txt` stored.
 *
 * Scoped to the run by the **job token**, never by anything in the request. A
 * runner that could name the run could read another run's build output, and on
 * a fork's pull request that output belongs to somebody else's commit.
 */
export default new Action({
  name: 'FetchArtifact',
  description: 'Download an artifact this run produced, by name',
  method: 'POST',

  validations: {
    name: { rule: schema.string() },
  },

  responses: {
    200: { description: 'The bytes, with X-Artifact-Digest so the job can check them.' },
    404: { description: 'This run has no artifact by that name - or it expired, which is the same answer to a job that needed it.' },
    410: { description: 'The row is here but the bytes are gone, which is a disk that lost them rather than a name that was wrong.' },
    426: { description: 'This runner speaks a protocol version the server does not.' },
    401: { description: 'No job credential, or one this instance does not recognise.' },
  },

  responseHeaders: {
    'X-Artifact-Digest': {
      description: 'SHA-256 of the bytes, so a job can verify what it received.',
      schema: { type: 'string' },
    },
  },

  async handle(request: RequestInstance) {
    const protocol = protocolOf(request)

    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)

    if (!held)
      return runnerJson({ error: 'Unknown or expired job token' }, 401)

    const job = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'workflow_run_id'])
      .where('id', '=', held.jobId)
      .executeTakeFirst()

    if (!job)
      return runnerJson({ error: 'The credential names a job that has gone' }, 404)

    const name = artifactName(request.get('name'))

    const row = await db
      .selectFrom('workflow_artifacts')
      .select(['id', 'name', 'digest', 'size_bytes', 'expires_at'])
      .where('workflow_run_id', '=', Number(job.workflow_run_id))
      .where('name', '=', name)
      .executeTakeFirst()

    if (!row)
      return runnerJson({ error: `This run has no artifact called ${name}` }, 404)

    /*
     * Expiry is checked here as well as by the sweep. A row whose date has
     * passed but which the sweep has not reached yet is not something to hand
     * over: the promise a retention date makes is about availability, and
     * honouring it only when a background job happens to have run is not a
     * promise.
     */
    if (row.expires_at && Date.parse(String(row.expires_at)) < Date.now())
      return runnerJson({ error: `The artifact ${name} has expired` }, 404)

    const stream = await openArtifact(row)

    if (!stream) {
      // Told apart from a wrong name on purpose: this is a disk that lost the
      // bytes, and an operator reading the log should not go looking for a typo.
      return runnerJson({ error: `The bytes for ${name} are not on this instance any more` }, 410)
    }

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name.replace(/["\\]/g, '')}"`,
        'X-Artifact-Digest': String(row.digest),
        'Cache-Control': 'no-store',
      },
    })
  },
})
