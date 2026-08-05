import { Action } from '@stacksjs/actions'
import { browseContext, browsePath } from './context'
import { readBlob } from './load'

/**
 * A file's contents at a ref.
 *
 * Binary and oversized files come back with their size and a flag rather than
 * their bytes: a JSON response carrying a vendored bundle is a response nobody
 * can use and a request nobody can cancel. `RawFileAction` is where the bytes
 * live, and it streams them.
 */
export default new Action({
  name: 'BrowseBlob',
  description: 'Read a file in a repository at a ref',
  method: 'GET',

  async handle(request: any) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const path = browsePath(request.get('path'))
    if (!path)
      return response.json({ error: 'No path given' }, 422)

    const { diskPath, ref } = browse.context
    const blob = await readBlob(diskPath, ref, path)

    if (!blob.ok)
      return response.json({ error: blob.error ?? 'Not found' }, 404)

    return response.json({
      ref,
      path,
      size: blob.size,
      binary: blob.binary,
      too_large: blob.tooLarge,
      // Null rather than an empty string, so a caller can tell "we declined to
      // send this" from "this file is empty".
      text: blob.text,
    })
  },
})
