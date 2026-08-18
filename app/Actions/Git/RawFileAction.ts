import { Action } from '@stacksjs/actions'
import { browseContext, browsePath } from '../Browse/context'
import { rawHeaders } from './download'
import { spawnGit } from './git'

/**
 * A file's bytes, exactly as they are stored.
 *
 * Streamed from `git cat-file` rather than read into memory. A raw URL is what
 * people point `curl` and build scripts at, so the file that goes through it is
 * routinely the largest one in the repository - a lockfile, a fixture, a model
 * checkpoint - and buffering it means one request can hold that much memory for
 * as long as the client takes to read it.
 *
 * The response is never served as its own type. See `download.ts` for why: a
 * repository is somebody else's content, and `index.html` served as HTML from
 * this origin runs script with this application's cookies.
 */
export default new Action({
  name: 'RawFile',
  description: 'Serve a file from a repository, unrendered',
  method: 'GET',

  async handle(request: RequestInstance) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const path = browsePath(request.get('path'))
    if (!path)
      return response.json({ error: 'No path given' }, 422)

    const { diskPath, ref } = browse.context

    // Asked first, so a missing file is a 404 rather than an empty 200: once
    // the stream has started there is no status left to change.
    const kind = spawnGit(diskPath, ['cat-file', '-t', `${ref}:${path}`])
    const type = await readAll(kind).catch(() => '')

    if (type.trim() !== 'blob')
      return response.json({ error: 'No such file at that ref' }, 404)

    const child = spawnGit(diskPath, ['cat-file', 'blob', `${ref}:${path}`])

    // git tells us nothing about whether the blob is text until it has been
    // read, and the whole point here is not to read it. `--textconv` would, and
    // runs repository-configured filters. So the guess comes from the request:
    // anything the caller wants shown inline has to say so, and the default is
    // the safe one.
    const inline = String(request.get('inline') ?? '') === '1'
    const headers = rawHeaders(path, !inline)

    const stream = new ReadableStream({
      start(controller) {
        child.stdout.on('data', chunk => controller.enqueue(new Uint8Array(chunk)))
        child.stdout.on('end', () => controller.close())
        child.on('error', () => controller.close())
      },
      cancel() {
        child.kill('SIGKILL')
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': headers.contentType,
        'Content-Disposition': headers.disposition,
        'X-Content-Type-Options': 'nosniff',
        // A ref may move, so only an immutable request may be cached hard.
        'Cache-Control': /^[0-9a-f]{40}$/.test(ref) ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  },
})

/** Collect a short command's output. Only used for the type probe. */
async function readAll(child: ReturnType<typeof spawnGit>): Promise<string> {
  return await new Promise((resolvePromise) => {
    let out = ''
    child.stdout.on('data', chunk => out += chunk)
    child.on('close', () => resolvePromise(out))
    child.on('error', () => resolvePromise(''))
  })
}
