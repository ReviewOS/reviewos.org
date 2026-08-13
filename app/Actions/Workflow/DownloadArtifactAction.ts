import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { artifactPath } from '../Artifact/storage'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Handing an artifact back.
 *
 * **Always a download, never a rendered page.** The bytes came off a machine
 * running somebody's build, and a browser willing to render them in place turns
 * an artifact into stored cross-site scripting - an HTML report, or an SVG,
 * which is a document with scripting in it that happens to look like a picture.
 * So `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`,
 * on everything, whatever the uploader claimed the type was.
 *
 * The id is a number anybody can increment, so it is checked against the
 * repository the caller named rather than trusted: without that this endpoint
 * is a way to read another repository's build output one integer at a time.
 *
 * The digest is returned as a header. A client that asked for a specific
 * artifact can check what it got against what the list said, which is the point
 * of storing by content in the first place.
 */
export default new Action({
  name: 'DownloadArtifact',
  description: 'Download one artifact a run produced',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    id: { rule: schema.number().required() },
  },

  responses: {
    200: { description: 'The bytes, as an attachment. X-Artifact-Digest carries the SHA-256 a client can check them against.' },
    401: { description: 'No credential, or one this instance does not recognise.' },
    404: { description: 'No such repository, no such artifact, or one belonging to a repository this caller may not see - deliberately the same answer.' },
    410: { description: 'The artifact expired. The row is gone and so are the bytes; the date was in every listing that ever showed it.' },
  },

  responseHeaders: {
    'X-Artifact-Digest': {
      description: 'SHA-256 of the bytes, so a client can verify what it received.',
      schema: { type: 'string' },
    },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const id = Number(request.get('id'))

    if (!Number.isInteger(id) || id <= 0)
      return response.json({ error: 'An artifact id is required' }, 422)

    /*
     * Joined to the run and filtered on the repository, which is the check
     * that matters. The id is a number anybody can increment, and without this
     * the endpoint reads out every repository's artifacts in turn.
     */
    const row: any = await db
      .selectFrom('workflow_artifacts')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_artifacts.workflow_run_id')
      .select([
        'workflow_artifacts.id as id',
        'workflow_artifacts.name as name',
        'workflow_artifacts.digest as digest',
        'workflow_artifacts.size_bytes as size_bytes',
        'workflow_artifacts.content_type as content_type',
        'workflow_artifacts.expires_at as expires_at',
      ])
      .where('workflow_artifacts.id', '=', id)
      .where('workflow_runs.repository_id', '=', Number(repository.id))
      .executeTakeFirst()

    if (!row)
      return response.json({ error: 'No such artifact' }, 404)

    // Expired but not yet swept. The sweep is how the disk follows the promise,
    // not how the promise is defined - so the answer is 410 the moment the date
    // passes rather than whenever a job next runs.
    const expires = row.expires_at ? Date.parse(String(row.expires_at)) : Number.NaN

    if (Number.isFinite(expires) && expires <= Date.now())
      return response.json({ error: 'This artifact has expired' }, 410)

    const file = Bun.file(artifactPath(String(row.digest)))

    if (!(await file.exists())) {
      // The row outlived its bytes, which should not happen - the sweep removes
      // the row first for exactly this reason. Said plainly rather than as a
      // 404, because "it is gone" and "we lost it" are different problems and
      // an operator should be able to tell them apart in a log.
      return response.json({ error: 'The stored copy of this artifact is missing' }, 410)
    }

    return new Response(file, {
      headers: {
        'Content-Type': String(row.content_type ?? 'application/octet-stream'),
        // The name the uploader gave, quoted, and never a path: it is metadata
        // here, and the file on disk is addressed by its digest.
        'Content-Disposition': `attachment; filename="${String(row.name).replace(/["\\]/g, '')}"`,
        'X-Content-Type-Options': 'nosniff',
        'X-Artifact-Digest': String(row.digest),
        'Content-Length': String(Number(row.size_bytes) || 0),
      },
    })
  },
})
