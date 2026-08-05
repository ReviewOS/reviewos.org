import { Action } from '@stacksjs/actions'
import { browseContext } from '../Browse/context'
import {
  archiveContentType,
  archiveFilename,
  archiveFormat,
  archivePrefix,
  gitArchiveFormat,
  headerSafeName,
} from './download'
import { runGit, spawnGit } from './git'

/**
 * A repository at a ref, as a zip or a tar.gz.
 *
 * `git archive` writes the whole thing to stdout, and it is streamed straight
 * through: an archive of a large repository is hundreds of megabytes, and
 * holding one in memory per request is how a download page takes a server down.
 *
 * Every entry sits under a `repository-ref/` prefix. Without it the archive
 * unpacks into whatever directory somebody happened to be in, which is the
 * difference between getting a repository and getting a thousand loose files in
 * a home directory.
 */
export default new Action({
  name: 'Archive',
  description: 'Download a repository at a ref as an archive',
  method: 'GET',

  async handle(request: any) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const format = archiveFormat(request.get('format') ?? 'tar.gz')
    if (!format)
      return response.json({ error: 'An archive is zip or tar.gz' }, 422)

    const { diskPath, ref, name } = browse.context

    // Resolved before streaming starts, because once bytes are going out there
    // is no status code left to change: a bad ref would otherwise download as a
    // zero-byte archive that reports success.
    const resolved = await runGit(diskPath, ['rev-parse', '--verify', `${ref}^{commit}`])
    if (!resolved.ok)
      return response.json({ error: 'No such ref' }, 404)

    const child = spawnGit(diskPath, [
      'archive',
      `--format=${gitArchiveFormat(format)}`,
      `--prefix=${archivePrefix(name, ref)}`,
      resolved.stdout.trim(),
    ])

    const stream = new ReadableStream({
      start(controller) {
        child.stdout.on('data', chunk => controller.enqueue(new Uint8Array(chunk)))
        child.stdout.on('end', () => controller.close())
        child.on('error', () => controller.close())
      },
      cancel() {
        // Somebody closing the tab must not leave git packing a repository.
        child.kill('SIGKILL')
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': archiveContentType(format),
        'Content-Disposition': `attachment; filename="${headerSafeName(archiveFilename(name, ref, format))}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})
