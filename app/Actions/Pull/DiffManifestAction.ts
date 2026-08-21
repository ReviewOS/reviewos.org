import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { diskPathFor } from '../Git/access'
import { streamMergeBaseDiff } from '../Git/diffStream'
import { authorizeRepository } from '../Repo/authorize'
import { renderMarkdownHighlighted } from '../Markdown/render'
import { languageRulesFor } from '../Browse/attributes'
import { readBlob } from '../Browse/load'
import { loadReviewThreads } from './loadThreads'
import { manifestToNdjson, streamManifest } from './manifest'

/**
 * What a pull request changed, as a list the browser can lay out immediately.
 *
 * The response is newline-delimited JSON, one record per file, written as git
 * produces the patch. The browser gets the first file's record in milliseconds
 * and the scrollbar is correct as soon as the last one lands, whatever the size
 * of the change. Nothing here holds the patch, and the browser never sees it.
 *
 * A raw `Response` rather than `response.json` because this streams: a JSON
 * array would have to be complete before the client could read any of it, which
 * would hand back everything the streaming bought.
 */
export default new Action({
  name: 'DiffManifest',
  description: 'Stream the per-file manifest of a pull request diff',
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
    highlight: { rule: schema.string() },
    layout: { rule: schema.string() },
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

    // Unified unless the reader asked for split. The layout decides the row
    // markup, so it has to be known before anything is rendered; switching
    // afterwards costs a refetch of the rows and nothing else, because the
    // manifest already carries the counts for both.
    const layout = String(request.get('layout') ?? '') === 'split' ? 'split' : 'unified'

    // Loaded before the stream opens, because every file may carry one and
    // asking the database per file would be a query per file. A pull request
    // has tens of threads, not thousands, so this is one small read.
    const threads = await loadReviewThreads({
      pullRequestId: Number(pullRequest.id),
      renderBody: body => renderMarkdownHighlighted(body, { owner, repository: repository.name }),
      // Carried onto this head before the stream opens, so a thread written
      // against a head that has since been rebased away lands on the line it
      // is about rather than the number it used to have. One `git diff` per
      // round of review, paid once here rather than per file.
      trackTo: { diskPath: path, headSha: String(pullRequest.head_sha) },
    })

    // The benchmark harness's stubbed mode, and nothing else asks for it. Layout
    // and paint are what a CSS change is measured on, and a token span per word
    // is a large and variable share of both - so a measurement taken with
    // highlighting on is partly a measurement of the tokenizer's opinion of the
    // fixture. Safe to expose: the worst a caller can do with it is read an
    // uncoloured diff.
    const highlight = String(request.get('highlight') ?? '') !== 'off'

    const encoder = new TextEncoder()
    const { loadCoverage } = await import('../Checks/coverage')
    const coverage = await loadCoverage(Number(repository.id), String(pullRequest?.head_sha ?? ''))

    /*
     * The repository's own language rules, once per request.
     *
     * `.gitattributes` at the head this diff is against, so a file the
     * repository declares as something detection would not guess is coloured
     * the same here as in the blob view. Read once and consulted per file: it
     * is one `cat-file` for a diff of any size, and cached for the next.
     */
    const languageRules = await languageRulesFor(path, String(pullRequest.head_sha), readBlob)

    /*
     * Spawned last, immediately before it is read.
     *
     * git starts writing the moment it is spawned, and a child's stdout here
     * does not hold what nobody has asked for - so every `await` between the
     * spawn and the first read is a window in which the whole diff can be
     * produced and dropped. It was spawned at the top of this action, above
     * three of them: the threads, the coverage and the language rules. A diff
     * small enough to finish inside that window - four hundred bytes, one
     * file, which is most pull requests - arrived as nothing, and git exited 0
     * while it did, so `done.ok` was true and the screen rendered "0 files"
     * for a pull request that changes one.
     *
     * Nothing below this line awaits anything before reading `chunks`.
     */
    const diff = await streamMergeBaseDiff(path, String(pullRequest.base_sha), String(pullRequest.head_sha))
    if (!diff) {
      // The shas came out of our own table, so this means the row is corrupt
      // rather than the caller being hostile. Still refused rather than passed
      // to git.
      return response.json({ error: 'This pull request has no usable revisions' }, 422)
    }

    const records = manifestToNdjson(streamManifest(diff, {
      rows: { layout, threads, skipCollapsed: true, highlight, coverage, languageRules },
    }))

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // One record per pull, so backpressure reaches all the way through to
        // git: a slow reader slows the parse rather than filling memory with
        // records nobody has asked for yet.
        const { done, value } = await records.next()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(value))
      },
      cancel() {
        // A reader who navigated away. Without this, `git diff` keeps running
        // against a large repository with nobody to read its output.
        diff.cancel()
      },
    })

    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        // The manifest is derived from two commit shas, so it is immutable for
        // as long as those shas are, but a force-push moves them. Revalidation
        // is cheap and being one push out of date is not.
        'Cache-Control': 'no-store',
        // Nothing here is HTML, and a browser sniffing it as such would be a
        // way to get a path from a diff treated as markup.
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})
