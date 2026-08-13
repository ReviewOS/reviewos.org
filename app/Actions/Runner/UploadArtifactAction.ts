import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { storeArtifact } from '../Artifact/store'
import { MAX_ARTIFACT_BYTES, megabytes } from '../Artifact/storage'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * What a job publishes for somebody to collect later.
 *
 * **The body is the file**, not a multipart form. A runner is a program, the
 * thing it has is a stream of bytes, and asking it to build a form around them
 * would be asking every implementer to pull in a library to send one file. The
 * name and the retention travel in headers for the same reason: nothing here
 * needs parsing before the bytes can be written.
 *
 *     curl -X POST "$SERVER/api/runner/artifacts" \\
 *       -H "Authorization: Bearer $JOB_TOKEN" \\
 *       -H "X-Artifact-Name: coverage.lcov" \\
 *       --data-binary @coverage.lcov
 *
 * Authenticated with the **job credential**, so an artifact can only ever be
 * attached to the run whose work this machine is holding. The registration
 * token is not accepted: it reaches every job that machine may run, and a
 * mistake there attaches one repository's build output to another's run.
 *
 * The ceiling is enforced before the row is written and the run's total is
 * checked with it, because a per-artifact limit on its own is walked around by
 * a matrix of fifty jobs each uploading just under it.
 */
export default new Action({
  name: 'UploadArtifact',
  description: 'Publish a file produced by a job',
  method: 'POST',

  responses: {
    201: {
      description: 'The artifact, with the digest a client can check what it downloads against and the date it stops being available.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          digest: { type: 'string', description: 'SHA-256 of the bytes, lower case hex. Also the address the file is stored at.' },
          size_bytes: { type: 'integer' },
          expires_at: { type: 'string' },
          duplicate: { type: 'boolean', description: 'True when this exact upload had already been recorded - at-least-once delivery means a correct runner will send it twice.' },
        },
      },
    },
    409: { description: 'This run already has an artifact under that name with different content. Replacing it silently would leave two people holding different files with one name.' },
    413: { description: 'Past the per-artifact or per-run ceiling. The message says which and by how much.' },
    426: { description: 'This runner speaks a protocol version the server does not.' },
    401: { description: 'No job credential, or one this instance does not recognise.' },
    404: { description: 'The credential names a job whose run has gone.' },
  },

  responseHeaders: {
    'X-Runner-Protocol-Supported': {
      description: 'The protocol version, or range, this server speaks.',
      schema: { type: 'string' },
    },
  },

  async handle(request: any) {
    const protocol = protocolOf(request)
    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)
    if (!held)
      return runnerJson({ error: 'Unknown job credential' }, 401)

    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'workflow_run_id'])
      .where('id', '=', held.jobId)
      .executeTakeFirst()

    if (!job)
      return runnerJson({ error: 'No such job' }, 404)

    const bytes = await readBody(request)

    if (!bytes)
      return runnerJson({ error: 'An artifact needs a body' }, 422)

    /*
     * The ceiling is checked twice: once here against what arrived, and once
     * inside `storeArtifact` against the run's total. This one exists so an
     * oversized upload is refused with the number rather than by whatever
     * happens when a body outgrows memory.
     */
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      return runnerJson({
        error: `An artifact may be at most ${megabytes(MAX_ARTIFACT_BYTES)}; this one is ${megabytes(bytes.byteLength)}`,
      }, 413)
    }

    const stored = await storeArtifact({
      runId: Number(job.workflow_run_id),
      jobId: Number(job.id),
      name: header(request, 'X-Artifact-Name') || 'artifact',
      bytes,
      contentType: header(request, 'Content-Type'),
      retentionDays: Number(header(request, 'X-Artifact-Retention-Days')) || null,
      runnerId: String(held.runner.id),
    })

    if (!stored.ok)
      return runnerJson({ error: stored.reason }, stored.status)

    return runnerJson({
      id: stored.id,
      name: header(request, 'X-Artifact-Name') || 'artifact',
      digest: stored.digest,
      size_bytes: stored.size,
      expires_at: stored.expiresAt,
      duplicate: stored.duplicate,
    }, stored.duplicate ? 200 : 201)
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
 * The body, as bytes.
 *
 * Read whole rather than streamed to disk, which is the honest limit of this
 * implementation: the ceiling is what keeps that from being a problem, and a
 * streaming upload is the change to make when somebody wants artifacts larger
 * than a process should hold.
 */
async function readBody(request: any): Promise<Uint8Array | null> {
  try {
    if (typeof request?.arrayBuffer === 'function') {
      const buffer = await request.arrayBuffer()

      return buffer && buffer.byteLength > 0 ? new Uint8Array(buffer) : null
    }

    const body: ReadableStream | null = request?.body ?? null
    if (!body)
      return null

    const chunks: Uint8Array[] = []
    const reader = body.getReader()

    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      if (value)
        chunks.push(value)
    }

    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    if (size === 0)
      return null

    const all = new Uint8Array(size)
    let at = 0

    for (const chunk of chunks) {
      all.set(chunk, at)
      at += chunk.byteLength
    }

    return all
  }
  catch {
    return null
  }
}
