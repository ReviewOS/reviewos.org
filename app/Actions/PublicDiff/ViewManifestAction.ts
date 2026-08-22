import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import publicDiff from '../../../config/publicdiff'
import { manifestToNdjson, streamManifest } from '../Pull/manifest'
import { parseDiffPath } from './parse'
import { patchFor } from './render'
import { patchAsSource } from './source'

/**
 * The file list of somebody else's diff, streamed.
 *
 * The front door used to render every file it could - up to three hundred -
 * into one document and send it. On the two diffs this viewer was written
 * against that is 24.9MB of HTML for `nodejs/node#59805` and **55.5MB** for
 * `oven-sh/bun#30412`, in a single page. A phone does not render that; it
 * reloads the tab, which is exactly the failure DiffsHub's own landing page
 * warns about and exactly what this product exists to beat.
 *
 * So the front door gets what the review screen has: a manifest first, rows for
 * the first screen alongside it, and the rest fetched as the reader reaches
 * them. It is the *same* generator - `streamManifest` takes a source of patch
 * text and knows nothing about git - so there is one implementation of the
 * batching, the inline row budget and the truncation notice rather than two.
 *
 * The patch itself is fetched once and held briefly, because this endpoint and
 * the rows endpoint beside it both need it. See `patchCache.ts`.
 */
export default new Action({
  name: 'ViewManifest',
  description: 'The file list of a public GitHub diff, as a stream',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    kind: { rule: schema.string() },
    ref: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    if (!publicDiff.enabled)
      return response.json({ error: 'The public diff viewer is not enabled on this instance' }, 404)

    const target = parseDiffPath([
      String(request.get('owner') ?? ''),
      String(request.get('repo') ?? ''),
      String(request.get('kind') ?? ''),
      String(request.get('ref') ?? ''),
    ].join('/'))

    if (!target)
      return response.json({ error: 'That is not a pull request, commit or compare range' }, 422)

    const authorization = String(request.headers?.get?.('authorization') ?? '')
    const token = authorization.toLowerCase().startsWith('bearer ')
      ? authorization.slice('bearer '.length).trim()
      : null

    const patch = await patchFor(target, { token })

    if (!patch.ok) {
      return response.json({
        error: patch.message,
        reason: patch.reason,
      }, patch.reason === 'rate-limited' ? 429 : 404)
    }

    const layout = String(request.get('layout') ?? '') === 'split' ? 'split' : 'unified'
    const highlight = String(request.get('highlight') ?? '') !== 'off'

    const records = manifestToNdjson(streamManifest(patchAsSource(patch.patch), {
      rows: { layout, highlight, skipCollapsed: true },
    }))

    const encoder = new TextEncoder()

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // One record per pull, so a slow reader slows the parse rather than
        // filling memory with records nobody has asked for.
        const { done, value } = await records.next()

        if (done) {
          controller.close()
          return
        }

        controller.enqueue(encoder.encode(value))
      },
    })

    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        // Somebody else's diff, which moves when they push. The patch behind it
        // is held for minutes; the answer is not cached for longer than that by
        // anything in between.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})
