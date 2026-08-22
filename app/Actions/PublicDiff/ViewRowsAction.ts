import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import publicDiff from '../../../config/publicdiff'
import { manifestToNdjson, streamManifest } from '../Pull/manifest'
import { MAX_ROW_PATHS } from '../Pull/DiffRowsAction'
import { parseDiffPath } from './parse'
import { patchFor } from './render'
import { patchAsSource } from './source'

/**
 * Rows for a named handful of files of somebody else's diff.
 *
 * The other half of the streamed front door. The manifest stops sending rows
 * once its budget is spent and says where it stopped; from there the viewer
 * asks for what the reader is about to reach, a batch at a time.
 *
 * Where the review screen answers this by handing git a pathspec - so twenty
 * files of a forty thousand file compare cost a diff of twenty files - this has
 * the whole patch in hand already and filters it. That is the honest difference
 * between a diff on disk and a diff fetched over the network, and it is why the
 * patch is held between requests rather than fetched per batch.
 */
export default new Action({
  name: 'ViewRows',
  description: 'Rows for named files of a public GitHub diff',
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

    /*
     * The paths asked for, capped.
     *
     * Read off the URL rather than through `request.get`, which answers with
     * one value: the viewer asks for a screenful at a time as repeated `path`
     * parameters - a path may contain any character but a slash and NUL, so
     * there is no separator that is safe to join on - and reading one of them
     * silently returns a screen with one file on it and no error anywhere.
     *
     * The cap is the same one the review screen uses, and for the same reason:
     * a screenful and its overscan in one round trip, and a URL that stays well
     * inside what every proxy will carry.
     */
    const paths = new URL(request.url).searchParams
      .getAll('path')
      .map(path => path.trim())
      .filter(path => path.length > 0)
      .slice(0, MAX_ROW_PATHS)

    if (paths.length === 0)
      return response.json({ error: 'No files named' }, 422)

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
    const wanted = new Set(paths)

    const records = manifestToNdjson(streamManifest(patchAsSource(onlyFiles(patch.patch, wanted)), {
      rows: {
        layout,
        // No budget: the caller asked for these files by name, which is the
        // reader having reached them.
        budgetBytes: Number.POSITIVE_INFINITY,
        highlight,
      },
    }))

    const encoder = new TextEncoder()

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
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
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})

/**
 * The named files of a patch, and nothing else.
 *
 * A textual filter rather than a parse, because the parse is what
 * `streamManifest` is about to do and doing it twice on a forty-three megabyte
 * patch is the cost this whole arrangement exists to avoid. A file's text runs
 * from its `diff --git` line to the next one, which is the same boundary the
 * splitter uses.
 */
export function onlyFiles(patch: string, wanted: ReadonlySet<string>): string {
  const kept: string[] = []
  let at = patch.indexOf('diff --git ')

  while (at !== -1) {
    const next = patch.indexOf('\ndiff --git ', at + 1)
    const end = next === -1 ? patch.length : next + 1
    const header = patch.slice(at, patch.indexOf('\n', at) === -1 ? patch.length : patch.indexOf('\n', at))

    /*
     * `diff --git a/path b/path`, and the path is taken from the `b/` side
     * because that is the name the manifest reports and therefore the name the
     * viewer asks for. A rename gives two different names and the viewer knows
     * the new one.
     */
    const b = header.lastIndexOf(' b/')

    if (b !== -1 && wanted.has(header.slice(b + 3)))
      kept.push(patch.slice(at, end))

    at = next === -1 ? -1 : next + 1
  }

  return kept.join('')
}
