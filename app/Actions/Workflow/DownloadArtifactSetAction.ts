import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { artifactPath } from '../Artifact/storage'
import { buildTar } from '../Artifact/tar'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'

/** The most bytes to assemble in memory for one archive. */
export const MAX_SET_BYTES = 200 * 1024 * 1024

/**
 * Everything one run produced, as a single file.
 *
 * One download rather than fourteen right-clicks, which is what somebody wants
 * when they are collecting evidence from a failed run or handing a build to a
 * colleague.
 *
 * **A tar, and it says so.** Zip would need a compressor and a central
 * directory; tar is a header and padding, which is why it is written here
 * rather than pulled in - and every machine that runs CI has `tar`. Not
 * compressed on purpose: artifacts are usually compressed already, and spending
 * the instance's CPU to make a build's tarball three percent smaller is the
 * wrong trade.
 *
 * Assembled in memory, which is why there is a ceiling. Streaming it entry by
 * entry is the change to make when somebody has a run with a gigabyte of
 * output; refusing with the size and the reason is better than an instance that
 * falls over when they do.
 */
export default new Action({
  name: 'DownloadArtifactSet',
  description: 'Download every artifact a run produced, as one archive',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
  },

  responses: {
    200: { description: 'A tar archive of every artifact this run still holds.' },
    ...REPOSITORY_ERRORS,
    404: { description: 'No such repository, no such run, or a run with nothing in it.' },
    410: { description: 'The rows are here but the bytes are gone, which is a disk that lost them rather than a run that produced nothing.' },
    413: { description: 'The set is larger than this instance will assemble in one archive. The individual downloads still work.' },
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

    const run = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', Number(repository.id))
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const rows = await db
      .selectFrom('workflow_artifacts')
      .select(['name', 'digest', 'size_bytes', 'expires_at'])
      .where('workflow_run_id', '=', Number(run.id))
      .orderBy('name')
      .execute()

    /*
     * Expired rows are left out here as well as by the sweep, for the same
     * reason the single download checks: the promise a retention date makes is
     * about availability, and honouring it only when a background job happens
     * to have run is not a promise.
     */
    const live = rows.filter(row => !row.expires_at || Date.parse(String(row.expires_at)) >= Date.now())

    if (live.length === 0)
      return response.json({ error: 'This run has no artifacts' }, 404)

    const total = live.reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0)

    if (total > MAX_SET_BYTES) {
      return response.json({
        error: `This run holds ${total} bytes of artifacts, and this instance assembles at most ${MAX_SET_BYTES} in one archive. Download them individually.`,
      }, 413)
    }

    const entries: Array<{ name: string, bytes: Uint8Array }> = []

    for (const row of live) {
      const file = Bun.file(artifactPath(String(row.digest)))

      // A row whose bytes are gone is skipped rather than failing the archive:
      // thirteen artifacts and one missing file is still thirteen artifacts
      // somebody wanted.
      if (!await file.exists())
        continue

      entries.push({ name: String(row.name), bytes: new Uint8Array(await file.arrayBuffer()) })
    }

    if (entries.length === 0)
      return response.json({ error: 'The bytes for this run\'s artifacts are not on this instance any more' }, 410)

    const archive = buildTar(entries)

    return new Response(archive.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-tar',
        'Content-Disposition': `attachment; filename="run-${number}-artifacts.tar"`,
        'Content-Length': String(archive.length),
        'Cache-Control': 'no-store',
      },
    })
  },
})
