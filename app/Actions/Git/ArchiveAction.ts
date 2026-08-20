import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { browseContext } from '../Browse/context'
import {
  archiveContentType,
  archiveCacheKey,
  archiveFilename,
  archiveFormat,
  archivePrefix,
  gitArchiveFormat,
  headerSafeName,
} from './download'
import { blobStore } from './blobs'
import { runGit, spawnGitLimited } from './git'
import { stdoutStream } from './stream'

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

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    format: { rule: schema.string() },
    ref: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
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

    // `heavy`: an archive is a whole-repository transfer, the same class as a
    // clone. Saturation answers 503 rather than queueing without bound.
    /*
     * The blob store first, and this is the CI answer rather than a nicety.
     *
     * A fleet building the same commit asks for the same archive over and
     * over, and every one of those is `git archive` walking a tree and
     * compressing it - the most expensive read this server serves, repeated
     * for an answer that cannot change. An archive is keyed by commit and
     * format, so it is immutable by construction and a cache of it needs no
     * invalidation at all.
     *
     * A miss falls through to git, exactly as before, and the result is
     * stored on the way out.
     */
    const commit = resolved.stdout.trim()
    const cacheKey = archiveCacheKey(commit, format)
    const store = await blobStore()
    const cached = await store.get(cacheKey).catch(() => null)

    if (cached) {
      return new Response(cached, {
        headers: {
          'Content-Type': archiveContentType(format),
          'Content-Disposition': `attachment; filename="${headerSafeName(archiveFilename(name, ref, format))}"`,
          'X-Content-Type-Options': 'nosniff',
          // Said out loud so an operator can see the cache working rather
          // than infer it from a latency graph.
          'X-Archive-Cache': 'hit',
        },
      })
    }

    const child = await spawnGitLimited('heavy', diskPath, [
      'archive',
      `--format=${gitArchiveFormat(format)}`,
      `--prefix=${archivePrefix(name, ref)}`,
      resolved.stdout.trim(),
    ])

    if (!child) {
      return new Response(JSON.stringify({ error: 'The server is at its concurrent transfer limit. Try again shortly.' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
      })
    }

    /*
     * Tee'd: the client gets its bytes as git produces them, and the store
     * gets a copy for the next asker. The response is never delayed by the
     * write - a `tee` hands both branches the same chunks, and the store's
     * branch is consumed in the background.
     *
     * A failed cache write is swallowed on purpose: this download is already
     * correct, and the next request simply misses again.
     */
    const [toClient, toStore] = stdoutStream(child).tee()

    void store.put(cacheKey, toStore).catch(() => undefined)

    // Pull-based (`stdoutStream`): a rate-limited download of a large archive
    // holds process memory flat, because git only produces what the client
    // has taken. Cancel kills the child - somebody closing the tab must not
    // leave git packing a repository.
    return new Response(toClient, {
      headers: {
        'Content-Type': archiveContentType(format),
        'Content-Disposition': `attachment; filename="${headerSafeName(archiveFilename(name, ref, format))}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})
