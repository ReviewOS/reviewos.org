import { Action } from '@stacksjs/actions'
import { MAX_SNAPSHOT_BYTES, runFactsFor, saveSnapshot } from '../Workflow/cache'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * A workspace snapshot, kept for the runs after this one.
 *
 * **The body is the archive**, the same way an artifact upload's body is the
 * file: a runner is a program, the thing it has is a stream of bytes, and
 * asking it to build a form around them is asking every implementer to pull in
 * a library to send one file.
 *
 *     curl -X POST "$SERVER/api/runner/caches" \\
 *       -H "Authorization: Bearer $JOB_TOKEN" \\
 *       -H "X-Cache-Key: <the derived key>" \\
 *       -H "X-Cache-Digest: <sha-256 of the archive>" \\
 *       --data-binary @snapshot.tar.zst
 *
 * **The scope is not a parameter.** A runner does not say whose cache it is
 * writing; the instance works that out from the run row, and a request naming
 * anything else is refused. That is the whole security boundary: a cache is a
 * directory one run writes and another executes out of, so a fork's pull
 * request being able to choose its scope is a fork's pull request being able to
 * run code on the default branch.
 */
export default new Action({
  name: 'SaveCache',
  description: 'Store a workspace snapshot for later runs',
  method: 'POST',

  responses: {
    201: {
      description: 'Stored, with the scope it was actually written to - which is the run\'s own, whatever the runner assumed.',
      schema: {
        type: 'object',
        properties: {
          scope: { type: 'string' },
          duplicate: { type: 'boolean', description: 'True when this snapshot was already stored - at-least-once delivery means a correct runner will send it twice.' },
        },
      },
    },
    403: { description: 'The runner named a scope this run may not write to.' },
    413: { description: 'Past the snapshot ceiling. Above it a cache costs more to move than the install it replaces.' },
    422: { description: 'No body, no key, or a digest that is not a sha-256.' },
    426: { description: 'This runner speaks a protocol version the server does not.' },
    401: { description: 'No job credential, or one this instance does not recognise.' },
    404: { description: 'The credential names a job whose run has gone.' },
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

    const key = header(request, 'X-Cache-Key')
    const digest = header(request, 'X-Cache-Digest').toLowerCase()

    if (!key)
      return runnerJson({ error: 'A snapshot needs the key it was computed for' }, 422)

    const bytes = await readBody(request)

    if (!bytes || bytes.byteLength === 0)
      return runnerJson({ error: 'A snapshot needs a body' }, 422)

    if (bytes.byteLength > MAX_SNAPSHOT_BYTES)
      return runnerJson({ error: `A snapshot may be at most ${MAX_SNAPSHOT_BYTES} bytes` }, 413)

    const saved = await saveSnapshot({
      repositoryId: context.repositoryId,
      facts: context.facts,
      cacheKey: key,
      digest,
      sizeBytes: bytes.byteLength,
      body: bytes,
      workflowRunId: context.runId,
      // The key an author wrote, when this is the `actions/cache` form. It is
      // metadata: the identity is still the hash, and this is what a later
      // `restore-keys` prefix search reads.
      label: header(request, 'X-Cache-Label') || null,
      claimedScope: header(request, 'X-Cache-Scope') || null,
    })

    if (!saved.ok) {
      // A refused scope is a different thing from a malformed request, and a
      // fleet operator reading a log needs to be able to tell them apart.
      const status = saved.reason.includes('may only write') ? 403 : 422

      return runnerJson({ error: saved.reason }, status)
    }

    return runnerJson({ scope: saved.scope, duplicate: saved.duplicate }, saved.duplicate ? 200 : 201)
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

/** The body, as bytes. Bounded by the ceiling above, which is checked after. */
async function readBody(request: any): Promise<Uint8Array | null> {
  try {
    if (typeof request?.arrayBuffer === 'function')
      return new Uint8Array(await request.arrayBuffer())

    const raw = request?.body ?? request?.raw ?? null

    if (raw instanceof Uint8Array)
      return raw

    if (typeof raw === 'string')
      return new TextEncoder().encode(raw)

    return null
  }
  catch {
    return null
  }
}
