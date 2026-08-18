import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { renderBadge, stateFor } from './badge'

/**
 * The badge a README puts at the top: does this workflow pass on this branch.
 *
 * **Under `/api` because of how this application is routed.** Only that prefix
 * reaches the route registry; everything else is the file-based view router,
 * which would send `/owner/repo/badge.svg` to the repository page. The URL is
 * pasted once into a README and read by machines after that, so the prefix
 * costs nothing.
 *
 * **It never fails, and it never discloses.** A repository that does not exist,
 * one the reader may not see, and one that has simply never run this workflow
 * all get the same grey `unknown` badge with a 200. A 404 would be a broken
 * image in somebody's README, and an answer that differed between "no such
 * repository" and "private repository" would confirm the second to anybody who
 * guessed a name - on an endpoint built to be fetched anonymously.
 *
 * **Cached against the run rather than against the clock.** The `ETag` is the
 * run and its state, so a reader who asks again while nothing has happened gets
 * a 304 and no SVG at all, and a run that finishes a second later invalidates
 * it immediately. A minute of `max-age` on top keeps a popular README from
 * asking on every page view without making a green badge outlive its run.
 */
export default new Action({
  name: 'WorkflowBadge',
  description: 'An SVG status badge for a workflow on a branch',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    workflow: { rule: schema.string(), required: false },
    branch: { rule: schema.string(), required: false },
    label: { rule: schema.string(), required: false },
  },

  responses: {
    200: { description: 'The badge, as SVG. Grey `unknown` when there is nothing to report, whatever the reason.' },
    304: { description: 'Nothing has changed since the `ETag` the caller sent.' },
  },

  async handle(request: RequestInstance) {
    const asked = String(request.get('workflow') ?? '').trim()
    const wantedLabel = String(request.get('label') ?? '').trim()

    /*
     * Resolved as whoever asked - anonymous for a README on a public
     * repository, and as the reader when the browser sends a session. A private
     * repository is readable to the people who can see it and `unknown` to
     * everybody else, which is the behaviour that lets a badge work on an
     * internal instance without a token in the URL.
     */
    const auth = await authorizeRepository(request, 'workflow:read')

    if (!auth.ok)
      return badge(request, wantedLabel || asked || 'build', null, 'missing')

    const { repository } = auth.context

    const candidates = await db
      .selectFrom('workflows')
      .select(['id', 'name', 'path'])
      .where('repository_id', '=', Number(repository.id))
      .execute()
      .catch(() => [])

    /*
     * By path, then by file name, then by the workflow's name - the same three
     * ways a dispatch accepts one, because the string somebody pastes into a
     * README is whichever of them they had to hand. With none asked for, the
     * first workflow: a repository with one workflow is the common case, and
     * making that URL shorter is worth more than making it explicit.
     */
    const workflow = asked
      ? candidates.find(row => String(row.path) === asked)
        ?? candidates.find(row => String(row.path).endsWith(`/${asked}`))
        ?? candidates.find(row => String(row.name) === asked)
      : candidates[0]

    if (!workflow)
      return badge(request, wantedLabel || asked || 'build', null, 'missing')

    const branch = String(request.get('branch') ?? '').trim() || String(repository.default_branch ?? 'main')
    const label = wantedLabel || String(workflow.name || workflow.path || 'build')

    /*
     * The newest *finished* run, and the newest run of any state as the
     * fallback. A badge that showed the run in flight would flicker between
     * `running` and the answer on every page load while a build is going, and
     * the question a badge answers is "is this branch good", which the last
     * finished run is the answer to. When nothing has finished yet, saying
     * `running` is better than saying `unknown`.
     */
    const runs = await db
      .selectFrom('workflow_runs')
      .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
      .select(['workflow_runs.id as id', 'workflow_runs.state as state'])
      .where('workflow_versions.workflow_id', '=', Number(workflow.id))
      .where('workflow_runs.repository_id', '=', Number(repository.id))
      .where('workflow_runs.event_ref', '=', `refs/heads/${branch}`)
      .orderBy('workflow_runs.id', 'desc')
      .limit(20)
      .execute()
      .catch(() => [])

    const finished = runs.find(run => ['succeeded', 'failed', 'cancelled', 'skipped'].includes(String(run.state)))
    const run = finished ?? runs[0]

    if (!run)
      return badge(request, label, null, `${workflow.id}:none:${branch}`)

    return badge(request, label, String(run.state), `${workflow.id}:${run.id}:${String(run.state)}`)
  },
})

/**
 * One badge, with its cache headers.
 *
 * The version stamp goes into the `ETag` rather than the body, so two readers
 * asking about the same run get the same bytes and the same tag - and a
 * conditional request costs a query and no rendering at all.
 */
function badge(request: RequestInstance, label: string, state: string | null, version: string): Response {
  const etag = `"badge-${hash(`${label}:${version}`)}"`

  const headers = {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    /*
     * A minute, and `must-revalidate` after it. Long enough that a README with
     * ten badges does not cost ten renders on every view, short enough that a
     * build finishing is visible while somebody is still looking at the page.
     */
    'Cache-Control': 'public, max-age=60, must-revalidate',
    'ETag': etag,
    // Asserted because a badge is embedded in pages this instance does not
    // control, and an SVG served as something a browser will sniff is an
    // invitation to have it interpreted as markup.
    'X-Content-Type-Options': 'nosniff',
  }

  if (String(request?.headers?.get?.('if-none-match') ?? '') === etag)
    return new Response(null, { status: 304, headers })

  return new Response(renderBadge({ label, state: stateFor(state) }), { headers })
}

/** A short, stable stamp for the `ETag`. Not a security boundary. */
function hash(value: string): string {
  let sum = 5381

  for (let index = 0; index < value.length; index += 1)
    sum = ((sum * 33) ^ value.charCodeAt(index)) >>> 0

  return sum.toString(36)
}
