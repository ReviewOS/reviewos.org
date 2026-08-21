import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { browsePath, browseContext } from './context'
import { BLOB_WINDOW_LINES, blobWindowFor, readBlobWindow } from './blobWindow'
import { renderBlobRows } from './blobRows'
import { highlightLines, tokenClass } from './highlight'
import { highlightResumed, resumeLanguage } from './resume'
import { coerced } from '../inputs'

/**
 * A window of a file's lines, highlighted, as rows.
 *
 * The blob view renders its first window into the page and asks for the rest as
 * the reader moves, which is what makes a forty thousand line file readable at
 * all: the alternative is forty thousand table rows in one document, which is
 * the failure the diff engine was built to avoid and which the file view has
 * been quietly doing on everything under half a megabyte.
 *
 * Rows rather than JSON, from the same renderer the page uses, because a client
 * that reassembles rows from tokens is a second implementation of the markup -
 * and the seam between the first window and the second is exactly where a
 * reader is looking.
 *
 * Highlighting stays on the server for the same reason it does on the diff: a
 * large file tokenised in the browser is jank precisely when somebody is trying
 * to read code, and the page downloads no highlighter at all.
 */
export default new Action({
  name: 'BlobRows',
  description: 'A window of one file’s lines, highlighted',
  method: 'GET',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    count: { rule: schema.number() },
    from: { rule: coerced },
    path: { rule: schema.string() },
    ref: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    // From the context rather than from the query: it has already resolved the
    // ref against the repository's own refs and turned `disk_path` into a real
    // path. Reading them again here is how the two answer differently.
    const { diskPath, ref } = browse.context

    const path = browsePath(request.get('path'))
    if (!path)
      return response.json({ error: 'No path given' }, 422)

    const from = Number(request.get('from') ?? 1)
    const count = Number(request.get('count') ?? BLOB_WINDOW_LINES)

    /*
     * The language is named on the way in rather than worked out on the way
     * out, because the reader needs it *while* it streams: the lines above the
     * window are what a resume needs and they are dropped as they go past.
     */
    const language = resumeLanguage(path)

    const window = await readBlobWindow(diskPath, ref, path, {
      from: Number.isFinite(from) ? from : 1,
      count: Number.isFinite(count) ? count : BLOB_WINDOW_LINES,
      language,
    })

    if (window.error)
      return response.json({ error: window.error }, 404)

    // Said rather than rendered as an empty file. A reader who asked for a
    // window of something binary or enormous gets the reason, and the page can
    // repeat it.
    if (window.binary)
      return response.json({ binary: true, total: 0, rows: '' })

    if (window.tooLarge)
      return response.json({ tooLarge: true, total: 0, rows: '' })

    /*
     * Resumed when the reader could say where the window began, which is the
     * whole point of a window past the first: line 20,000 of a file may be
     * inside a block comment opened at line 4, and a cold tokenizer renders it
     * as code with no sign that it is guessing.
     */
    const highlighted = highlightResumed(window.lines, language, window.resume, tokenClass)
      ?? await highlightLines(window.lines, path)
    const range = blobWindowFor(window.total, window.from, window.lines.length)

    return response.json({
      from: range.from,
      to: range.to,
      total: window.total,
      rows: renderBlobRows(highlighted, { from: range.from }),
    })
  },
})
