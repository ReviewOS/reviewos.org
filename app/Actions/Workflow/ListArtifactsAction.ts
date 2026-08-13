import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { megabytes } from '../Artifact/storage'
import { authorizeRepository } from '../Repo/authorize'

/**
 * What a run produced, for whoever comes to collect it.
 *
 * Behind `repository:read`, which is the whole access rule: an artifact is
 * built from a repository's code and often contains it, so a private
 * repository's build output is as private as the repository. There is no
 * separate artifact permission, because a second permission that has to be kept
 * in step with the first is one that eventually is not.
 *
 * The expiry is in the response rather than left implied. A client that has to
 * guess when an artifact disappears either re-downloads everything constantly
 * or finds out by 404.
 */
export default new Action({
  name: 'ListArtifacts',
  description: 'The artifacts a workflow run produced',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
  },

  responses: {
    200: {
      description: 'Every artifact this run still holds, with the digest to check a download against and the date each one stops being available.',
      schema: {
        type: 'object',
        properties: {
          artifacts: { type: 'array', items: { type: 'object' } },
          total_bytes: { type: 'integer' },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    404: { description: 'No such repository, or no run with that number.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const number = Number(request.get('number'))

    if (!Number.isInteger(number) || number <= 0)
      return response.json({ error: 'A run number is required' }, 422)

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', Number(repository.id))
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const rows: any[] = await db
      .selectFrom('workflow_artifacts')
      .selectAll()
      .where('workflow_run_id', '=', Number(run.id))
      .orderBy('name')
      .execute()

    return response.json({
      artifacts: rows.map(row => ({
        id: Number(row.id),
        name: String(row.name),
        digest: String(row.digest),
        size_bytes: Number(row.size_bytes) || 0,
        // The same number in the units a person reads, so a page does not have
        // to reimplement the arithmetic and disagree about a megabyte.
        size: megabytes(Number(row.size_bytes) || 0),
        content_type: row.content_type ? String(row.content_type) : null,
        job_id: row.workflow_job_id ? Number(row.workflow_job_id) : null,
        runner: row.runner_id ? String(row.runner_id) : null,
        expires_at: row.expires_at ? String(row.expires_at) : null,
        created_at: row.created_at ? String(row.created_at) : null,
      })),
      total_bytes: rows.reduce((total, row) => total + (Number(row.size_bytes) || 0), 0),
    })
  },
})
