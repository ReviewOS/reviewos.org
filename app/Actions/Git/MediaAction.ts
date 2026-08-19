import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { browseContext, browsePath } from '../Browse/context'
import { spawnGitLimited } from './git'
import { MAX_MEDIA_BYTES, MEDIA_SNIFF_BYTES, mediaHeaders, sniffImageType } from './media'

/**
 * An image out of a repository, served as an image.
 *
 * The narrow exception to the rule in `app/Actions/Git/download.ts`, and the
 * reason it has to exist: raw serves every binary as `application/octet-stream`
 * with `nosniff`, which is right, and which means a browser will not paint an
 * `<img>` pointed at it. Every relative image in every README was broken, and
 * broken in a way that read as the README's fault.
 *
 * What makes this safe is in `./media.ts`: the type comes from the *bytes*, off
 * a closed list of image formats, and the response carries a CSP that denies
 * the document every subresource and puts it in an opaque origin. Nothing here
 * looks at the filename.
 *
 * Buffered rather than streamed, unlike raw. Sniffing means reading before
 * deciding the status, and a response already streaming has no status left to
 * change - so the size is checked first and anything past the cap is refused
 * rather than held in memory.
 */
export default new Action({
  name: 'RepositoryMedia',
  description: 'Serve an image from a repository, as an image',
  method: 'GET',

  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
    ref: { rule: schema.string() },
    path: { rule: schema.string().required() },
  },

  responses: {
    200: { description: 'The image, with the type its bytes say it is.' },
    404: { description: 'No such repository or file, or the file is not an image of a kind this serves. A private repository answers this rather than 403.' },
    413: { description: 'The file is larger than this endpoint will buffer. It is still available through `/repos/raw` as a download.' },
    503: { description: 'Too many git processes are already running. Try again shortly.' },
  },

  async handle(request: RequestInstance) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const path = browsePath(request.get('path'))
    if (!path)
      return response.json({ error: 'No path given' }, 422)

    const { diskPath, ref } = browse.context

    /*
     * Type and size first, and both before a single byte of the file is read.
     * Sequential acquisitions, never nested: the probe's slot is released
     * before the blob's is taken, which is the semaphore's structural deadlock
     * rule - see `RawFileAction`, which does the same dance for the same
     * reason.
     */
    const probe = await spawnGitLimited('interactive', diskPath, ['cat-file', '-s', `${ref}:${path}`])
    if (!probe)
      return response.json({ error: 'The server is busy. Try again shortly.' }, 503)

    const size = Number((await collect(probe)).toString('utf8').trim())

    if (!Number.isFinite(size) || size <= 0)
      return response.json({ error: 'No such file at that ref' }, 404)

    if (size > MAX_MEDIA_BYTES)
      return response.json({ error: 'That file is too large to serve as an image' }, 413)

    const child = await spawnGitLimited('interactive', diskPath, ['cat-file', 'blob', `${ref}:${path}`])
    if (!child)
      return response.json({ error: 'The server is busy. Try again shortly.' }, 503)

    const bytes = await collect(child, MAX_MEDIA_BYTES)
    const type = sniffImageType(bytes.subarray(0, MEDIA_SNIFF_BYTES * 16))

    // Not an image, or not one on the list. The same answer a missing file
    // gets: this endpoint has exactly one thing it serves, and anything else
    // is not here.
    if (!type)
      return response.json({ error: 'That file is not an image' }, 404)

    const headers = mediaHeaders(type)

    return new Response(bytes, {
      headers: {
        'Content-Type': headers.contentType,
        'Content-Disposition': headers.disposition,
        'Content-Security-Policy': headers.contentSecurityPolicy,
        // Without this the browser is free to overrule the decision above,
        // which would make deciding it from the bytes pointless.
        'X-Content-Type-Options': 'nosniff',
        // A ref may move, so only an immutable request may be cached hard.
        'Cache-Control': /^[0-9a-f]{40}$/.test(ref) ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  },
})

/**
 * A short command's output, as bytes.
 *
 * Bytes rather than a string, which is the whole difference between this and
 * the helper in `RawFileAction`: concatenating chunks onto a string decodes
 * them as UTF-8, and a PNG that has been through that is no longer a PNG.
 *
 * `limit` is a backstop against a blob that grew between the size probe and
 * the read. The size check above is what actually bounds this.
 */
async function collect(child: any, limit = 1024 * 1024): Promise<Buffer> {
  return await new Promise((resolvePromise) => {
    const chunks: Buffer[] = []
    let total = 0

    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length

      if (total <= limit)
        chunks.push(chunk)
    })

    child.on('close', () => resolvePromise(Buffer.concat(chunks)))
    child.on('error', () => resolvePromise(Buffer.concat(chunks)))
  })
}
