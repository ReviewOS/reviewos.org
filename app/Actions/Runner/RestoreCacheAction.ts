import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { blobStore } from '../Git/blobs'
import { findRestorable, markRestored, runFactsFor } from '../Workflow/cache'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * The snapshot this run is entitled to for a key, as bytes.
 *
 *     curl "$SERVER/api/runner/caches/restore" \\
 *       -H "Authorization: Bearer $JOB_TOKEN" \\
 *       -H "X-Cache-Key: <the derived key>" -o snapshot.tar.zst
 *
 * **The runner does not say which scope to look in.** It asks for a key, and
 * the instance decides what that key resolves to for this run: its own branch's
 * snapshot, or the default branch's, and never a fork's. The answer says which
 * one it was, in `X-Cache-Scope` and `X-Cache-Exact`, because a run view that
 * can say "restored from main" is one somebody can reason about when a build
 * behaves differently on a branch than it did on the pull request.
 *
 * A miss is a **204**, not a 404. Nothing went wrong: there is no snapshot for
 * that key yet, which is what the first run after a lockfile change looks like,
 * and a runner treating it as an error would fail a job over a cold cache.
 */
export default new Action({
  name: 'RestoreCache',
  description: 'Fetch the workspace snapshot this run may restore for a key',
  method: 'GET',

  validations: {
    /*
     * Declared so the published reference says what this takes.
     *
     * The header is the form a runner uses; this is the query fallback, and it
     * is the one the document can describe today. Documenting the headers needs
     * `requestHeaders`, which the framework gained for exactly this and which
     * reaches this app when that release lands.
     */
    key: { rule: schema.string() },
  },

  responses: {
    200: { description: 'The archive. `X-Cache-Scope` says whose it was and `X-Cache-Exact` whether it was this run\'s own rather than the fallback.' },
    204: { description: 'No snapshot for that key. A cold cache is not an error.' },
    422: { description: 'No key.' },
    426: { description: 'This runner speaks a protocol version the server does not.' },
    401: { description: 'No job credential, or one this instance does not recognise.' },
    404: { description: 'The credential names a job whose run has gone.' },
  },

  responseHeaders: {
    'X-Cache-Scope': { description: 'Which scope the snapshot came from.', schema: { type: 'string' } },
    'X-Cache-Exact': { description: '`true` when it came from the run\'s own scope rather than the default branch.', schema: { type: 'string' } },
    'X-Cache-Digest': { description: 'SHA-256 of the archive, so a runner can check what it unpacks.', schema: { type: 'string' } },
  },

  async handle(request: any) {
    const protocol = protocolOf(request)
    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)
    if (!held)
      return runnerJson({ error: 'Unknown job credential' }, 401)

    const context = await runFactsFor(held.jobId)
    if (!context)
      return runnerJson({ error: 'No such job' }, 404)

    const key = header(request, 'X-Cache-Key') || String(request?.get?.('key') ?? '').trim()

    if (!key)
      return runnerJson({ error: 'Ask for a key' }, 422)

    const hit = await findRestorable(context.repositoryId, context.facts, key)

    if (!hit)
      return new Response(null, { status: 204 })

    const stream = await blobStore().then(store => store.get(hit.blobKey)).catch(() => null)

    /*
     * A row whose bytes are gone is a miss, not a failure.
     *
     * It happens: the collector removed the snapshot between the lookup and the
     * read, or an operator emptied a bucket. The run does not care - it
     * installs from scratch, which is what it would have done a second earlier.
     */
    if (!stream)
      return new Response(null, { status: 204 })

    // Counted before the body is sent rather than after. A restore that the
    // network cut in half still says this entry is one runs reach for, which is
    // what the collector is asking when it reads the number.
    await markRestored(hit.id)

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(hit.sizeBytes),
        'X-Cache-Scope': hit.scope,
        'X-Cache-Exact': hit.exact ? 'true' : 'false',
        'X-Cache-Digest': hit.digest,
      },
    })
  },
})

/** A header, whichever shape of request object this is. */
function header(request: any, name: string): string {
  return String(
    request?.headers?.get?.(name)
    ?? request?.headers?.get?.(name.toLowerCase())
    ?? request?.header?.(name)
    ?? '',
  ).trim()
}
