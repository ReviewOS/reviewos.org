import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { diskPathFor } from '../Git/access'
import { streamMergeBaseDiff } from '../Git/diffStream'
import { authorizeRepository } from '../Repo/authorize'
import { languageRulesFor } from '../Browse/attributes'
import { readBlob } from '../Browse/load'
import { manifestToNdjson, streamManifest } from './manifest'
import { coerced } from '../inputs'

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

/**
 * The largest window one request may ask for.
 *
 * A window is meant to be a screenful and its overscan. Asking for a hundred
 * thousand rows is asking for the whole file by another name, and the whole
 * file is what windowing exists to avoid putting in one response.
 */
export const MAX_ROW_WINDOW = 5_000

/** The default-folded hunks a request wants open, or null when none named. */
function readOpenHunks(request: RequestInstance): Set<number> | null {
  const raw = request.get('open')
  if (raw === undefined || raw === null || String(raw) === '')
    return null

  const opened = new Set<number>()
  for (const part of String(raw).split(',')) {
    const index = Number(part)
    if (Number.isInteger(index) && index >= 0)
      opened.add(index)
  }

  return opened.size > 0 ? opened : null
}

/** The row window a request asks for, or null for the whole file. */
function readRange(request: RequestInstance): { from: number, to: number } | null {
  const raw = request.get('from')
  if (raw === undefined || raw === null || String(raw) === '')
    return null

  const from = Number(raw)
  const to = Number(request.get('to'))

  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from)
    return null

  return { from, to: Math.min(to, from + MAX_ROW_WINDOW) }
}

export default new Action({
  name: 'DiffRows',
  description: 'Stream rendered diff rows for named files',
  method: 'GET',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    from: { rule: schema.string() },
    highlight: { rule: schema.string() },
    layout: { rule: schema.string() },
    open: { rule: schema.string() },
    to: { rule: coerced },
  },

  async handle(request: RequestInstance) {
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
      .select(['id', 'base_sha', 'head_sha'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const path = diskPathFor(owner, repository.name)
    if (!path)
      return response.json({ error: 'Repository not found' }, 404)

    const layout = String(request.get('layout') ?? '') === 'split' ? 'split' : 'unified'

    // A window within one file, for a file too large to send whole. Only
    // honoured for a single path, because a range is a range *within* a file
    // and applying one to forty would be asking for rows 1,000 to 1,200 of
    // each of them.
    const range = readRange(request)
    if (range != null && paths.length !== 1)
      return response.json({ error: 'A row range needs exactly one path' }, 422)

    // Default-folded hunks the reader has opened. One path only, like a
    // range: an open set is a set within *a* file.
    const openHunks = readOpenHunks(request)
    if (openHunks != null && paths.length !== 1)
      return response.json({ error: 'Opened hunks need exactly one path' }, 422)

    // The same threads the manifest renders with, for the same reason the
    // manifest loads them: the fold policy never folds a conversation, and
    // this endpoint re-rendering with a different fold set than the manifest
    // counted would shift the numbering by whole hunks.
    const { loadReviewThreads } = await import('./loadThreads')
    const { renderMarkdownHighlighted } = await import('../Markdown/render')
    const threads = await loadReviewThreads({
      pullRequestId: Number(pullRequest?.id ?? 0),
      renderBody: (body: string) => renderMarkdownHighlighted(body, { owner, repository: repository.name }),
      // Carried onto the head the same way the manifest carries them, so the
      // two endpoints hold one opinion about where every thread sits.
      trackTo: { diskPath: path, headSha: String(pullRequest?.head_sha ?? '') },
    })
    const diff = await streamMergeBaseDiff(path, String(pullRequest.base_sha), String(pullRequest.head_sha), { paths })
    if (!diff)
      return response.json({ error: 'This pull request has no usable revisions' }, 422)

    // No budget: the caller named the files, so the size of the answer is the
    // size of what was asked for. The budget exists to stop a whole diff being
    // rendered eagerly, which is not what this is.
    const encoder = new TextEncoder()
    // Matches the manifest endpoint, so a benchmark run is stubbed on both
    // halves. Rows fetched with highlighting on while the manifest was stubbed
    // would make one mode out of two.
    const highlight = String(request.get('highlight') ?? '') !== 'off'

    const { loadCoverage } = await import('../Checks/coverage')
    const coverage = await loadCoverage(Number(repository.id), String(pullRequest?.head_sha ?? ''))

    // The same rules the manifest used, so a file's colours do not change
    // when its rows are fetched separately. Cached from that request in the
    // ordinary case, since this is the same repository at the same head.
    const languageRules = await languageRulesFor(path, String(pullRequest.head_sha), readBlob)

    const records = manifestToNdjson(streamManifest(diff, {
      rows: {
        layout,
        budgetBytes: Number.POSITIVE_INFINITY,
        range: range ?? undefined,
        highlight,
        threads,
        openHunks: openHunks ?? undefined,
        coverage,
        languageRules,
      },
    }))

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
function readPaths(request: RequestInstance): string[] {
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
