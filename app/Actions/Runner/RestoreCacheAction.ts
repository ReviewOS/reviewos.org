import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { blobStore } from '../Git/blobs'
import { db } from '@stacksjs/database'
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

    /*
     * `restore-keys`, in the author's order.
     *
     * Sent by the runner because they are the author's, not the instance's -
     * unlike the scope, which the runner does not get a say in. A prefix
     * decides *which of this run's own entries* is close enough; it cannot
     * reach an entry the scope rules would refuse, because the prefix search
     * runs inside those same scopes.
     */
    const prefixes = header(request, 'X-Cache-Restore-Keys')
      .split(',')
      .map(one => one.trim())
      .filter(Boolean)
      .slice(0, 10)

    const hit = await findRestorable(context.repositoryId, context.facts, key, prefixes)

    /*
     * Counted on the job, hit or miss.
     *
     * "Did the cache work" is asked of a run somebody is looking at, and the
     * only place it could be answered before this was a log line - which
     * answers it for one person at a time, and only while the log is still
     * there. Two counters rather than a ratio, because the ratio is derived and
     * a stored one eventually disagrees with the pair it came from.
     */
    await countLookup(held.jobId, Boolean(hit))

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

/**
 * Record that a job asked the cache something, and whether it got it.
 *
 * Never throws and never blocks the restore: a counter is a fact about a build,
 * and failing a cache lookup because the count could not be written would trade
 * a working job for a statistic.
 */
async function countLookup(jobId: number, hit: boolean): Promise<void> {
  /*
   * Read then written, like `markRestored` next door and with the same
   * tolerance: two lookups landing together can lose a count, and a cache
   * statistic that is occasionally one low is worth less than the lock it would
   * take to be exact.
   */
  const row: any = await db
    .selectFrom('workflow_jobs')
    .select(['cache_lookups', 'cache_hits'])
    .where('id', '=', jobId)
    .executeTakeFirst()
    .catch(() => null)

  if (!row)
    return

  await db
    .updateTable('workflow_jobs')
    .set({
      cache_lookups: Number(row.cache_lookups ?? 0) + 1,
      cache_hits: Number(row.cache_hits ?? 0) + (hit ? 1 : 0),
    })
    .where('id', '=', jobId)
    .execute()
    .catch(() => null)
}
