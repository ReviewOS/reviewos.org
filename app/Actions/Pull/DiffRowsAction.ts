import { Action } from '@stacksjs/actions'
import { diskPathFor } from '../Git/access'
import { streamMergeBaseDiff } from '../Git/diffStream'
import { authorizeRepository } from '../Repo/authorize'
import { manifestToNdjson, streamManifest } from './manifest'

/**
 * Rows for a named handful of files.
 *
 * The second half of the two-mode design. A diff too large to render inline
 * stops sending rows partway through and says where it stopped; from there the
 * viewer asks for what the reader is about to reach, a batch at a time.
 *
 * Asking by path rather than by position is what makes this cheap. `git diff`
 * takes pathspecs, so fetching files 9,000 to 9,020 of a 40,000 file compare
 * costs a diff of twenty files, not a diff of forty thousand skipped to an
 * offset. No cache is needed for it to be fast, which means there is no cache
 * to invalidate when somebody force-pushes.
 */

/**
 * How many files one request may ask for.
 *
 * Enough to cover a screen and its overscan in one round trip, and small enough
 * that the URL stays well inside what every proxy will carry.
 */
export const MAX_ROW_PATHS = 40

export default new Action({
  name: 'DiffRows',
  description: 'Stream rendered diff rows for named files',
  method: 'GET',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const owner = String(request.get('owner') ?? '').trim().toLowerCase()

    const number = Number(request.get('number'))
    if (!Number.isInteger(number) || number <= 0)
      return response.json({ error: 'A pull request number is required' }, 422)

    const paths = readPaths(request)
    if (paths.length === 0)
      return response.json({ error: 'At least one path is required' }, 422)

    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['base_sha', 'head_sha'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const path = diskPathFor(owner, repository.name)
    if (!path)
      return response.json({ error: 'Repository not found' }, 404)

    const layout = String(request.get('layout') ?? '') === 'split' ? 'split' : 'unified'
    const diff = streamMergeBaseDiff(path, String(pullRequest.base_sha), String(pullRequest.head_sha), { paths })
    if (!diff)
      return response.json({ error: 'This pull request has no usable revisions' }, 422)

    // No budget: the caller named the files, so the size of the answer is the
    // size of what was asked for. The budget exists to stop a whole diff being
    // rendered eagerly, which is not what this is.
    const encoder = new TextEncoder()
    const records = manifestToNdjson(streamManifest(diff, { rows: { layout, budgetBytes: Number.POSITIVE_INFINITY } }))

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await records.next()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(value))
      },
      cancel() {
        diff.cancel()
      },
    })

    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})

/**
 * The requested paths, as a bounded list.
 *
 * Repeated `path` parameters rather than one delimited value, because a path
 * may legally contain any character except a slash and NUL, including whatever
 * separator seemed safe. Capped so one request cannot ask for the whole diff
 * and undo the point of the mode.
 */
function readPaths(request: any): string[] {
  const url = new URL(request.url)
  const values = url.searchParams.getAll('path')

  const paths: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    // A pathspec beginning with `-` or `:` is an option or a magic pathspec to
    // git, and neither is something a caller should be able to reach.
    if (trimmed === '' || trimmed.startsWith('-') || trimmed.startsWith(':'))
      continue

    paths.push(trimmed)
    if (paths.length >= MAX_ROW_PATHS)
      break
  }

  return paths
}
