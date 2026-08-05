import { Action } from '@stacksjs/actions'
import { browseContext, browsePath } from './context'
import { blameFile, MAX_BLAME_LINES } from './load'

/**
 * Who last touched each line of a file.
 *
 * Capped at `MAX_BLAME_LINES`, and the cap is not a formality: blame walks
 * history per line, and the slowest file in any repository is a minified bundle
 * checked in years ago, which is also the file nobody wants the answer for.
 */
export default new Action({
  name: 'BrowseBlame',
  description: 'Blame a file at a ref',
  method: 'GET',

  async handle(request: any) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const path = browsePath(request.get('path'))
    if (!path)
      return response.json({ error: 'No path given' }, 422)

    const { diskPath, ref } = browse.context
    const requested = Number(request.get('limit') ?? MAX_BLAME_LINES)
    const limit = Number.isFinite(requested) ? requested : MAX_BLAME_LINES

    const blamed = await blameFile(diskPath, ref, path, limit)

    if (!blamed.ok)
      return response.json({ error: blamed.error ?? 'Not found' }, 404)

    return response.json({ ref, path, truncated: blamed.truncated, lines: blamed.lines })
  },
})
